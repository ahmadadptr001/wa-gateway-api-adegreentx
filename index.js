import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import waRoutes from "./routes/wa.route.js";
import express from "express";
import cors from "cors";
import P from "pino";
import { saveSession, getSession, clearSession } from "./sessionManager.js";
import { rm } from "node:fs/promises";

const PORT = process.env.PORT || 4000;
const app = express();
const logger = P({ level: "silent" });

// Global state
global.sock = null;
global.isConnected = false;
global.pendingQR = null;
global.pendingPairingCode = null;
let reconnectAttempts = 0;
let reconnectTimeout = null;

export async function connectToWhatsApp(phoneNumber) {
  return new Promise(async (resolve, reject) => {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger,
      auth: state,
      browser: ["Chrome (Linux)", "", ""],
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 30000,
      keepAliveIntervalMs: 30000,
    });

    let resolved = false;
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        sock.end(new Error("Connection timeout"));
        reject(new Error("Connection timeout after 60 seconds"));
      }
    }, 60000);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, pairingCode, qr } = update;

      // Tangkap QR code
      if (qr) {
        console.log("QR Code received, length:", qr.length);
        global.pendingQR = qr;
        global.pendingPairingCode = null;
      }

      // Tangkap pairing code (opsional)
      if (pairingCode) {
        console.log("Pairing code received:", pairingCode);
        global.pendingPairingCode = pairingCode;
        global.pendingQR = null;
      }

      if (connection === "open") {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          global.sock = sock;
          global.isConnected = true;
          global.pendingQR = null;
          global.pendingPairingCode = null;
          reconnectAttempts = 0;
          if (phoneNumber) saveSession(phoneNumber);
          console.log("✅ WhatsApp Connected!");
          resolve(sock);
        }
      }

      if (connection === "close") {
        global.isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMessage = lastDisconnect?.error?.message;
        console.log(
          "❌ Connection closed. Status code:",
          statusCode,
          "Error:",
          errorMessage,
        );

        const shouldReconnect =
          statusCode !== 401 && statusCode !== 403 && statusCode !== undefined;

        if (shouldReconnect && !resolved) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            reject(
              new Error(
                `Connection closed before open: ${errorMessage || lastDisconnect?.error}`,
              ),
            );
          }
        } else if (shouldReconnect && resolved) {
          scheduleReconnect();
        } else {
          console.log(
            "Session invalid or unrecoverable, clearing auth folder...",
          );
          await clearSession();
          try {
            await rm("./auth_info", { recursive: true, force: true });
          } catch (err) {}
          global.sock = null;
          global.isConnected = false;
          global.pendingQR = null;
          global.pendingPairingCode = null;
        }
      }
    });

    // Tidak perlu requestPairingCode, biarkan QR code yang keluar
    const isRegistered =
      sock.authState?.creds?.registered === true || sock.user !== undefined;
    if (!isRegistered && phoneNumber) {
      console.log("Waiting for QR code to appear...");
    } else if (isRegistered) {
      console.log("Existing session found, waiting for connection...");
    } else {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        reject(new Error("Phone number required but no session"));
      }
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  const maxAttempts = 10;
  const baseDelay = 5000;
  const delay = Math.min(baseDelay * Math.pow(2, reconnectAttempts), 60000);
  if (reconnectAttempts >= maxAttempts) {
    console.log("Max reconnect attempts reached.");
    return;
  }
  reconnectAttempts++;
  console.log(
    `Scheduling reconnect attempt ${reconnectAttempts} in ${delay / 1000}s...`,
  );
  reconnectTimeout = setTimeout(async () => {
    const session = getSession();
    if (session && session.phone) {
      try {
        await connectToWhatsApp(session.phone);
        console.log("Reconnect successful");
        reconnectAttempts = 0;
      } catch (err) {
        console.error("Reconnect failed:", err);
        scheduleReconnect();
      }
    }
  }, delay);
}

export async function autoReconnect() {
  const session = getSession();
  if (session && session.phone) {
    console.log("Auto-reconnecting with saved phone:", session.phone);
    try {
      await connectToWhatsApp(session.phone);
      return true;
    } catch (err) {
      console.error("Auto-reconnect failed:", err);
      clearSession();
      return false;
    }
  }
  return false;
}

// Express setup
app.use(cors());
app.use(express.json());

app.get("/", (req, res) =>
  res.json({ success: true, message: "WA Gateway API" }),
);
app.use("/api/wa", waRoutes);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
autoReconnect();
