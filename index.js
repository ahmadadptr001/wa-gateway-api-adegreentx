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
const logger = P({ level: "silent" });

// Global hanya untuk menyimpan socket yang aktif (dipakai route sendMessage)
global.sock = null;
global.isConnected = false;
let isStarting = false; // mencegah multiple start

// Fungsi wait
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fungsi utama start WhatsApp - diadopsi dari kode user yang berhasil
async function startWhatsApp(phoneNumber, customCode, retryCount = 0) {
  if (isStarting) {
    console.log("⏳ Proses start sedang berjalan, abaikan...");
    return;
  }
  isStarting = true;
  try {
    // Hapus auth lama untuk fresh start (opsional, bisa dihapus jika ingin retain)
    await rm("./auth_info", { recursive: true, force: true }).catch(() => {});
    clearSession();

    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📱 WA version: ${version.join(".")} (latest: ${isLatest})`);

    const sock = makeWASocket({
      logger: P({ level: "silent" }),
      version,
      auth: state,
      browser: ["Ubuntu", "Chrome", "120.0"],
    });

    // 🔥 Kunci sukses: delay 5 detik sebelum minta pairing code (seperti contoh user)
    if (!sock.authState.creds?.registered) {
      console.log(
        "⏳ Menunggu 5 detik sebelum mengirim kode pairing custom...",
      );
      await wait(5000);
      try {
        const result = await sock.requestPairingCode(phoneNumber, customCode);
        console.log(
          `✅ Kode custom "${customCode}" berhasil dikirim ke WhatsApp. Result: ${result || "tidak ada"}`,
        );
      } catch (err) {
        console.error("❌ Gagal mengirim kode custom:", err);
        throw err;
      }
    } else {
      console.log("🔐 Sudah terdaftar, menunggu koneksi...");
    }

    sock.ev.on("creds.update", saveCreds);

    // Event connection.update diadopsi dari contoh user (pakai DisconnectReason)
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        console.log("✅ WhatsApp berhasil terhubung!");
        global.sock = sock;
        global.isConnected = true;
        // Simpan session (pairing code disimpan untuk auto reconnect)
        saveSession(phoneNumber, customCode);
        isStarting = false;
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`❌ Koneksi tertutup. Kode: ${statusCode}`);
        global.isConnected = false;
        global.sock = null;
        isStarting = false;

        // Gunakan DisconnectReason untuk menentukan reconnect (seperti contoh user)
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log("🔄 Mencoba menyambung ulang dalam 5 detik...");
          setTimeout(() => {
            startWhatsApp(phoneNumber, customCode, retryCount + 1).catch(
              console.error,
            );
          }, 5000);
        } else {
          console.log("🚫 Logged out");
        }
      }
    });

    // Optional: jika ingin menyimpan pesan masuk (bisa dihapus jika tidak perlu)
    // Tidak mempengaruhi pairing.
  } catch (err) {
    console.error("Gagal startWhatsApp:", err);
    isStarting = false;
    // Jika gagal, retry lagi setelah 5 detik (maks 3 kali)
    if (retryCount < 3) {
      console.log(
        `🔄 Retry startWhatsApp (${retryCount + 1}/3) setelah 5 detik...`,
      );
      setTimeout(
        () => startWhatsApp(phoneNumber, customCode, retryCount + 1),
        5000,
      );
    }
  }
}

// Auto-start jika ada session tersimpan (sama seperti autoReconnect sebelumnya)
const session = getSession();
if (session?.phone && session?.otp) {
  console.log("🔄 Auto start dengan session tersimpan");
  startWhatsApp(session.phone, session.otp).catch(console.error);
}

// Express setup
app.use(cors());
app.use(express.json());
app.get("/", (req, res) =>
  res.json({ success: true, message: "WA Gateway API" }),
);
app.use("/api/wa", waRoutes);
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

export { startWhatsApp }; // diekspor untuk digunakan di controller
