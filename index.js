import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import waRoutes from "./routes/wa.route.js";
import express from "express";
import cors from "cors";
import P from "pino";
import { saveSession, getSession, clearSession } from "./sessionManager.js";
import { rm } from "node:fs/promises";

const PORT = process.env.PORT || 4000;
const app = express();

global.sock = null;
global.isConnected = false;

let isStarting = false;
let currentPhone = null;
let currentCustomCode = null;
let isPairingMode = false;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startWhatsApp(
  phoneNumber,
  customCode,
  pairingMode = false,
  retryCount = 0,
) {
  if (isStarting) {
    console.log("⏳ Proses start sedang berjalan, abaikan...");
    return;
  }
  isStarting = true;
  currentPhone = phoneNumber;
  currentCustomCode = customCode;
  isPairingMode = pairingMode;

  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📱 WA version: ${version.join(".")} (latest: ${isLatest})`);

    const sock = makeWASocket({
      logger: P({ level: "info" }),
      version,
      auth: state,
      browser: ["Ubuntu", "Chrome", "20.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, pairingCode } = update;

      if (pairingCode) {
        console.log(`📟 Kode pairing (default): ${pairingCode}`);
      }

      if (connection === "open") {
        console.log("✅ WhatsApp berhasil terhubung!");
        global.sock = sock;
        global.isConnected = true;
        await saveSession(currentPhone, currentCustomCode);
        isStarting = false;
        currentRetryCount = 0;
        isPairingMode = false;
        return;
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`❌ Koneksi tertutup. Kode: ${statusCode}`);

        global.isConnected = false;
        global.sock = null;

        // 🔥 Tangani restartRequired (515) - bukan error, restart koneksi tanpa pairing
        if (statusCode === DisconnectReason.restartRequired) {
          console.log(
            "🔄 WhatsApp meminta restart (515), memulai ulang koneksi...",
          );
          isStarting = false;
          startWhatsApp(
            currentPhone,
            currentCustomCode,
            false,
            retryCount + 1,
          ).catch(console.error);
          return;
        }

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("🚫 Logged out, hapus data auth.");
          await rm("./auth_info", { recursive: true, force: true }).catch(
            () => {},
          );
          await clearSession();
          isStarting = false;
          return;
        }

        // Reconnect biasa untuk error lain
        console.log("🔄 Mencoba menyambung ulang dalam 5 detik...");
        setTimeout(() => {
          startWhatsApp(
            currentPhone,
            currentCustomCode,
            false,
            retryCount + 1,
          ).catch(console.error);
        }, 5000);
      }
    });

    // Jika mode pairing dan belum terdaftar, minta pairing code setelah delay
    if (isPairingMode && !sock.authState.creds?.registered) {
      console.log(
        "⏳ Menunggu 5 detik sebelum mengirim kode pairing custom...",
      );
      await wait(5000);
      try {
        const result = await sock.requestPairingCode(
          currentPhone,
          currentCustomCode,
        );
        console.log(
          `✅ Kode custom "${currentCustomCode}" berhasil dikirim ke WhatsApp. Result: ${result}`,
        );
      } catch (err) {
        console.error("❌ Gagal mengirim kode custom:", err);
      }
    } else if (!isPairingMode) {
      console.log(
        "🔐 Mode reconnect (tanpa pairing), menunggu koneksi terbuka...",
      );
    }
  } catch (err) {
    console.error("Gagal startWhatsApp:", err);
    isStarting = false;
    if (retryCount < 3) {
      console.log(`🔄 Retry (${retryCount + 1}/3) setelah 5 detik...`);
      setTimeout(
        () =>
          startWhatsApp(
            currentPhone,
            currentCustomCode,
            isPairingMode,
            retryCount + 1,
          ),
        5000,
      );
    }
  }
}

// Auto-start jika ada session tersimpan
const session = await getSession();
if (session?.phone && session?.otp) {
  console.log("🔄 Auto start dengan session tersimpan (tanpa pairing)");
  startWhatsApp(session.phone, session.otp, false).catch(console.error);
}

// Express setup - semua endpoint publik
app.use(cors());
app.use(express.json());

app.get("/", (req, res) =>
  res.json({ success: true, message: "WA Gateway API" }),
);
app.use("/api/wa", waRoutes); // semua route wa tanpa auth

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
