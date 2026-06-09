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

export async function connectToWhatsApp(phoneNumber) {
  return new Promise(async (resolve, reject) => {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger,
      auth: state,
      browser: ["Ubuntu", "Chrome", "20.0.0"],
    });

    let resolved = false;
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        sock.end(new Error("Connection timeout"));
        reject(new Error("Connection timeout after 60 seconds"));
      }
    }, 60000);

    // Event pairing code
    sock.ev.on("pairing-code", (code) => {
      console.log("Pairing code received:", code);
      global.pendingPairingCode = code;
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          global.sock = sock;
          global.isConnected = true;
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
        const shouldReconnect = statusCode !== 401 && statusCode !== 403;
        console.log("❌ Connection closed. Status code:", statusCode);

        if (shouldReconnect && !resolved) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            reject(
              new Error(
                `Connection closed before open: ${lastDisconnect?.error}`,
              ),
            );
          }
        } else if (shouldReconnect && resolved) {
          scheduleReconnect();
        } else {
          console.log("Session invalid, clearing auth folder...");
          await clearSession();
          try {
            await rm("./auth_info", { recursive: true, force: true });
          } catch (err) {}
          global.sock = null;
          global.isConnected = false;
          global.pendingPairingCode = null;
        }
      }
    });

    const isRegistered =
      sock.authState?.creds?.registered === true || sock.user !== undefined;
    if (!isRegistered && phoneNumber) {
      // Delay agar websocket siap
      setTimeout(async () => {
        try {
          await sock.requestPairingCode(phoneNumber);
          console.log("Requested pairing code for", phoneNumber);
        } catch (err) {
          console.error("Error requesting pairing code:", err);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            reject(err);
          }
        }
      }, 2000);
    } else if (isRegistered) {
      console.log("Existing session found, waiting for connection...");
    } else {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        reject(new Error("Phone number required for pairing"));
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

app.use(cors());
app.use(express.json());
app.get("/", (req, res) =>
  res.json({ success: true, message: "WA Gateway API" }),
);
app.use("/api/wa", waRoutes);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
autoReconnect();
