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
let activeSocket = null; // socket yang sedang hidup, agar bisa dimatikan saat pairing baru
let reconnectAttempt = 0;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Matikan socket lama + lepaskan listener supaya tidak ada 2 koneksi
// bersaing untuk 1 akun (menyebabkan pesan tertahan di HP & gateway)
const killActiveSocket = () => {
  if (!activeSocket) return;
  try {
    activeSocket.ev.removeAllListeners("connection.update");
    activeSocket.ev.removeAllListeners("creds.update");
    activeSocket.end(undefined);
  } catch {}
  activeSocket = null;
};

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

  // Pastikan socket sebelumnya benar-benar mati sebelum membuat koneksi baru
  killActiveSocket();

  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📱 WA version: ${version.join(".")} (latest: ${isLatest})`);

    const sock = makeWASocket({
      // Level "warn": level "info" terlalu verbose & membebani event loop
      logger: P({ level: "warn" }),
      version,
      auth: state,
      browser: ["Ubuntu", "Chrome", "20.0.0"],
      // 🔑 Kunci anti-lag:
      // Jangan tandai akun "online" dari gateway — jika true, presence bentrok
      // dengan aplikasi HP dan pesan dari HP sering tertahan (centang satu).
      markOnlineOnConnect: false,
      // Jangan sinkron seluruh riwayat chat saat pertama tertaut —
      // proses ini berat dan membuat server + HP lemot.
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    activeSocket = sock;

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
        reconnectAttempt = 0;
        isPairingMode = false;
        return;
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`❌ Koneksi tertutup. Kode: ${statusCode}`);

        // Lepaskan listener socket ini agar handler lama tidak ikut
        // menimpa global.sock milik koneksi yang baru
        try {
          sock.ev.removeAllListeners("connection.update");
          sock.ev.removeAllListeners("creds.update");
        } catch {}
        if (global.sock === sock) {
          global.isConnected = false;
          global.sock = null;
        }
        if (activeSocket === sock) activeSocket = null;

        // 🔑 Bebaskan guard DI SINI. Jika koneksi close sebelum pernah
        // "open", isStarting masih true dan reconnect berikutnya akan
        // diabaikan → server stuck 503 selamanya.
        isStarting = false;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("🚫 Logged out, hapus data auth.");
          await rm("./auth_info", { recursive: true, force: true }).catch(
            () => {},
          );
          await clearSession();
          return;
        }

        if (statusCode === DisconnectReason.restartRequired) {
          console.log("🔄 WhatsApp meminta restart (515), menyambung ulang...");
        }

        // Reconnect dengan backoff eksponensial: 5s, 10s, 20s, 40s, maks 60s.
        // Reconnect terlalu cepat/berulang bisa memicu rate-limit WhatsApp.
        const delay = Math.min(5000 * 2 ** reconnectAttempt, 60000);
        reconnectAttempt++;
        console.log(`🔄 Menyambung ulang dalam ${delay / 1000} detik...`);
        setTimeout(() => {
          startWhatsApp(currentPhone, currentCustomCode, false).catch(
            console.error,
          );
        }, delay);
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
