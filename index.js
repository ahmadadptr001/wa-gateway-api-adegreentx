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

global.sock = null;
global.isConnected = false;
global.pendingPairingCode = null;
let reconnectAttempts = 0;
let reconnectTimeout = null;
let isPairing = false; // untuk mencegah multiple pairing

export async function connectToWhatsApp(phoneNumber, retryCount = 0) {
  if (isPairing) {
    console.log("Pairing already in progress, skip new request");
    return;
  }
  isPairing = true;
  const MAX_RETRY = 5;
  const retryDelay = 3000;

  return new Promise(async (resolve, reject) => {
    let resolved = false;
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger,
      auth: state,
      browser: ["Edge", "Windows", "10.0"],
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 30000,
      keepAliveIntervalMs: 30000,
    });

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        sock.end(new Error("Connection timeout"));
        reject(new Error("Timeout after 60 detik"));
        isPairing = false;
      }
    }, 60000);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, pairingCode, qr } = update;

      if (pairingCode) {
        console.log("✅ Pairing code:", pairingCode);
        global.pendingPairingCode = pairingCode;
      }

      if (qr) {
        console.log("📱 QR code received (fallback)");
        global.pendingQR = qr;
      }

      if (connection === "open") {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          global.sock = sock;
          global.isConnected = true;
          global.pendingPairingCode = null;
          global.pendingQR = null;
          reconnectAttempts = 0;
          if (phoneNumber) saveSession(phoneNumber);
          console.log("✅ WhatsApp Connected!");
          isPairing = false;
          resolve(sock);
        }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMessage = lastDisconnect?.error?.message;
        console.log(
          `❌ Connection closed. Code: ${statusCode}, Msg: ${errorMessage}`,
        );

        // 🔥 Tangani error 515 dengan restart socket dan pairing ulang
        if (statusCode === 515) {
          console.log("⚠️ 515 Stream Error – restarting pairing...");
          await clearSession();
          await rm("./auth_info", { recursive: true, force: true }).catch(
            () => {},
          );
          global.sock = null;
          global.isConnected = false;
          global.pendingPairingCode = null;
          global.pendingQR = null;
          isPairing = false;

          if (retryCount < MAX_RETRY) {
            console.log(
              `🔄 Retry pairing (${retryCount + 1}/${MAX_RETRY}) after ${retryDelay}ms`,
            );
            setTimeout(() => {
              connectToWhatsApp(phoneNumber, retryCount + 1).catch((err) => {
                console.error("Retry failed:", err);
              });
            }, retryDelay);
          } else {
            console.log("Max retry reached, pairing failed permanently.");
            if (!resolved) reject(new Error("Max retry for 515 error"));
          }
          return;
        }

        // Untuk kode lain, lakukan reconnect biasa
        const shouldReconnect =
          statusCode !== 401 && statusCode !== 403 && statusCode !== undefined;
        if (shouldReconnect && !resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          reject(new Error(`Connection closed before open: ${errorMessage}`));
          isPairing = false;
        } else if (shouldReconnect && resolved) {
          scheduleReconnect();
        } else {
          console.log("Session invalid (401/403), clearing auth...");
          await clearSession();
          await rm("./auth_info", { recursive: true, force: true }).catch(
            () => {},
          );
          global.sock = null;
          global.isConnected = false;
          global.pendingPairingCode = null;
          global.pendingQR = null;
          isPairing = false;
          if (!resolved) reject(new Error("Unauthorized"));
        }
      }
    });

    // Minta pairing code (prioritas) – lebih stabil
    const isRegistered =
      sock.authState?.creds?.registered === true || sock.user !== undefined;
    if (!isRegistered && phoneNumber) {
      console.log("Requesting pairing code for", phoneNumber);
      setTimeout(async () => {
        try {
          await sock.requestPairingCode(phoneNumber);
          console.log("Pairing code request sent");
        } catch (err) {
          console.error("Gagal minta pairing code:", err);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            reject(err);
            isPairing = false;
          }
        }
      }, 3000);
    } else if (isRegistered) {
      console.log("Existing session found, waiting for connection...");
    } else {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        reject(new Error("Phone number required"));
        isPairing = false;
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
    if (session?.phone) {
      try {
        await connectToWhatsApp(session.phone);
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
  if (session?.phone) {
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

app.use(cors());
app.use(express.json());
app.get("/", (req, res) =>
  res.json({ success: true, message: "WA Gateway API" }),
);
app.use("/api/wa", waRoutes);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
autoReconnect();
// testing
