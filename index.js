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
let activePromise = null; // 🔥 mencegah multiple pairing

export async function connectToWhatsApp(phoneNumber, customPairingCode) {
  // Jika sudah ada proses pairing, return promise yang sama
  if (activePromise) {
    console.log("Pairing already in progress, using existing promise");
    return activePromise;
  }

  activePromise = (async () => {
    return new Promise(async (resolve, reject) => {
      let resolved = false;

      // Hapus auth lama untuk fresh start
      try {
        await rm("./auth_info", { recursive: true, force: true });
      } catch (e) {}
      clearSession();

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
          reject(new Error("Connection timeout after 60s"));
          activePromise = null;
        }
      }, 60000);

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            global.sock = sock;
            global.isConnected = true;
            saveSession(phoneNumber, customPairingCode);
            console.log("✅ WhatsApp Connected!");
            resolve(sock);
            activePromise = null;
          }
        }

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log(`❌ Connection closed, code: ${statusCode}`);
          global.isConnected = false;

          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            reject(new Error(`Connection closed before open: ${statusCode}`));
            activePromise = null;
          } else {
            // Auto reconnect jika bukan 401/403
            if (statusCode !== 401 && statusCode !== 403) {
              console.log("🔄 Auto reconnecting in 5 seconds...");
              setTimeout(() => {
                connectToWhatsApp(phoneNumber, customPairingCode).catch(
                  console.error,
                );
              }, 5000);
            } else {
              console.log("🔐 Unauthorized, clearing session");
              clearSession();
              await rm("./auth_info", { recursive: true, force: true }).catch(
                () => {},
              );
            }
          }
        }
      });

      // Minta custom pairing code (hanya SEKALI, tidak akan double)
      console.log(
        `📱 Requesting custom pairing code for ${phoneNumber} -> ${customPairingCode}`,
      );
      setTimeout(async () => {
        try {
          await sock.requestPairingCode(phoneNumber, customPairingCode);
          console.log("✅ Custom pairing code request sent");
        } catch (err) {
          console.error("❌ Failed to request pairing code:", err);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            reject(err);
            activePromise = null;
          }
        }
      }, 4000); // delay 4 detik untuk stabilitas
    });
  })();

  return activePromise;
}

// Auto reconnect saat server start
const session = getSession();
if (session?.phone && session?.otp) {
  console.log("🔁 Auto reconnect with saved session");
  connectToWhatsApp(session.phone, session.otp).catch(console.error);
}

app.use(cors());
app.use(express.json());
app.get("/", (req, res) =>
  res.json({ success: true, message: "WA Gateway API" }),
);
app.use("/api/wa", waRoutes);
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
