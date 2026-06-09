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
let reconnectAttempts = 0;
let reconnectTimeout = null;

export async function connectToWhatsApp(
  phoneNumber,
  customPairingCode,
  retryCount = 0,
) {
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
      browser: ["Ubuntu", "Chrome", "120.0"],
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 30000,
      keepAliveIntervalMs: 30000,
    });

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        sock.end(new Error("Timeout"));
        reject(new Error("Connection timeout after 60s"));
      }
    }, 60000);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, pairingCode } = update;

      if (pairingCode) {
        console.log("Pairing code received from WhatsApp:", pairingCode);
      }

      if (connection === "open") {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          global.sock = sock;
          global.isConnected = true;
          reconnectAttempts = 0;
          if (phoneNumber && customPairingCode) {
            saveSession(phoneNumber, customPairingCode);
          }
          console.log("✅ WhatsApp Connected!");
          resolve(sock);
        }
      }

      if (connection === "close") {
        global.isConnected = false;
        let statusCode = lastDisconnect?.error?.output?.statusCode;
        if (!statusCode && lastDisconnect?.error) {
          statusCode = lastDisconnect.error.output?.statusCode;
        }
        const errorMessage = lastDisconnect?.error?.message;
        console.log(
          `❌ Connection closed. Code: ${statusCode}, Msg: ${errorMessage}`,
        );

        if (statusCode === 515) {
          console.log("⚠️ 515 Stream Error – restarting pairing...");
          await clearSession();
          await rm("./auth_info", { recursive: true, force: true }).catch(
            () => {},
          );
          global.sock = null;
          global.isConnected = false;

          if (retryCount < MAX_RETRY) {
            console.log(
              `🔄 Retry pairing (${retryCount + 1}/${MAX_RETRY}) after ${retryDelay}ms`,
            );
            setTimeout(() => {
              connectToWhatsApp(
                phoneNumber,
                customPairingCode,
                retryCount + 1,
              ).catch(console.error);
            }, retryDelay);
          } else {
            if (!resolved) reject(new Error("Max retry for 515"));
          }
          return;
        }

        const shouldReconnect =
          statusCode !== 401 && statusCode !== 403 && statusCode !== undefined;
        if (shouldReconnect && resolved) {
          scheduleReconnect();
        } else if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          reject(new Error(`Closed before open: ${errorMessage}`));
        } else {
          console.log("Unauthorized, clearing auth...");
          await clearSession();
          await rm("./auth_info", { recursive: true, force: true }).catch(
            () => {},
          );
          global.sock = null;
          global.isConnected = false;
        }
      }
    });

    // Minta pairing code dengan custom code dari user
    console.log(
      "Requesting custom pairing code for",
      phoneNumber,
      "with code:",
      customPairingCode,
    );
    setTimeout(async () => {
      try {
        await sock.requestPairingCode(phoneNumber, customPairingCode);
        console.log("Custom pairing code request sent");
      } catch (err) {
        console.error("Error requesting custom pairing code:", err);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      }
    }, 3000);
  });
}

function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  const maxAttempts = 10;
  const baseDelay = 5000;
  const delay = Math.min(baseDelay * Math.pow(2, reconnectAttempts), 60000);
  if (reconnectAttempts >= maxAttempts) return;
  reconnectAttempts++;
  console.log(`Scheduling reconnect in ${delay / 1000}s...`);
  reconnectTimeout = setTimeout(async () => {
    const session = getSession();
    if (session?.phone && session?.otp) {
      try {
        await connectToWhatsApp(session.phone, session.otp);
        reconnectAttempts = 0;
      } catch (err) {
        scheduleReconnect();
      }
    }
  }, delay);
}

export async function autoReconnect() {
  const session = getSession();
  if (session?.phone && session?.otp) {
    console.log("Auto-reconnecting with saved phone & OTP");
    try {
      await connectToWhatsApp(session.phone, session.otp);
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
