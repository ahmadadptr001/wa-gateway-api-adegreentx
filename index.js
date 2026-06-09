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
import { authenticate } from "./middleware/auth.js";

const PORT = process.env.PORT || 4000;
const app = express();

// Global untuk socket aktif
global.sock = null;
global.isConnected = false;

let isStarting = false; // mencegah multiple start
let currentRetryCount = 0;
let currentPhone = null;
let currentCustomCode = null;
let isPairingMode = false; // apakah sedang dalam mode pairing (butuh request code)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fungsi utama start WhatsApp (bisa untuk pairing atau reconnect biasa)
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
    // Gunakan multi file auth state tanpa menghapus folder
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📱 WA version: ${version.join(".")} (latest: ${isLatest})`);

    const sock = makeWASocket({
      logger: P({ level: "info" }), // ubah ke info untuk debugging
      version,
      auth: state,
      browser: ["Ubuntu", "Chrome", "20.0.0"], // sama seperti contoh yang berhasil
    });

    // Event: creds.update
    sock.ev.on("creds.update", saveCreds);

    // Event: connection.update
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, pairingCode } = update;

      // Jika ada pairingCode dari event (kode default 8 digit), log saja
      if (pairingCode) {
        console.log(`📟 Kode pairing (default): ${pairingCode}`);
      }

      if (connection === "open") {
        console.log("✅ WhatsApp berhasil terhubung!");
        global.sock = sock;
        global.isConnected = true;
        // Simpan session (nomor & kode, meski tidak digunakan untuk auth)
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

        // Handle restartRequired (515) - ini bukan error, tapi perintah restart dari WA
        if (statusCode === DisconnectReason.restartRequired) {
          console.log(
            "🔄 WhatsApp meminta restart (515), memulai ulang koneksi...",
          );
          // Jangan set isStarting = false dulu, biarkan reconnect tanpa pairing mode
          isStarting = false; // agar bisa start ulang
          // Panggil startWhatsApp ulang dengan pairingMode = false
          startWhatsApp(
            currentPhone,
            currentCustomCode,
            false,
            retryCount + 1,
          ).catch(console.error);
          return;
        }

        // Untuk loggedOut, hapus data auth
        if (statusCode === DisconnectReason.loggedOut) {
          console.log("🚫 Logged out, hapus data auth.");
          await rm("./auth_info", { recursive: true, force: true }).catch(
            () => {},
          );
          await clearSession();
          isStarting = false;
          return;
        }

        // Selain 515 dan loggedOut, reconnect biasa dengan jeda
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log("🔄 Mencoba menyambung ulang dalam 5 detik...");
          setTimeout(() => {
            startWhatsApp(
              currentPhone,
              currentCustomCode,
              false,
              retryCount + 1,
            ).catch(console.error);
          }, 5000);
        } else {
          isStarting = false;
        }
      }
    });

    // Jika mode pairing dan belum terdaftar, minta pairing code
    // Kita gunakan pendekatan: tunggu hingga koneksi dalam keadaan 'connecting' atau setelah delay
    // Untuk keandalan, kita tunggu 5 detik lalu request (seperti contoh TS yang berhasil)
    if (isPairingMode && !sock.authState.creds?.registered) {
      console.log(
        "⏳ Menunggu 5 detik sebelum mengirim kode pairing custom...",
      );
      await wait(5000);
      try {
        // Pastikan sock masih valid
        const result = await sock.requestPairingCode(
          currentPhone,
          currentCustomCode,
        );
        console.log(
          `✅ Kode custom "${currentCustomCode}" berhasil dikirim ke WhatsApp. Result: ${result}`,
        );
      } catch (err) {
        console.error("❌ Gagal mengirim kode custom:", err);
        // Jangan throw, biarkan connection.update menangani close
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
      console.log(
        `🔄 Retry startWhatsApp (${retryCount + 1}/3) setelah 5 detik...`,
      );
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

// Auto-start jika ada session tersimpan (tanpa pairing mode)
const session = await getSession();
if (session?.phone && session?.otp) {
  console.log("🔄 Auto start dengan session tersimpan (tanpa pairing)");
  startWhatsApp(session.phone, session.otp, false).catch(console.error);
}

// Express setup
app.use(cors());
app.use(express.json());

// Public endpoint (boleh tanpa auth)
app.get("/", (req, res) =>
  res.json({ success: true, message: "WA Gateway API" }),
);
app.get("/api/wa/status", async (req, res) => {
  // status bisa publik
  const { getStatus } = await import("./controllers/wa.controller.js");
  return getStatus(req, res);
});

// Endpoint yang memerlukan autentikasi
app.use("/api/wa", authenticate);
app.use("/api/wa", waRoutes);

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
