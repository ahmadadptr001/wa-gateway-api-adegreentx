import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import waRoutes from "./routes/wa.route.js";
import express from "express";
import cors from "cors";
import P from "pino";
import { saveSession, getSession, clearSession } from "./sessionManager.js";

const PORT = process.env.PORT || 4000;
const app = express();

const logger = P({ level: "silent" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function connectToWhatsApp(phoneNumber, otpCodeManual) {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();
  logger.info(`Using WA version v${version.join(".")}`);

  const socket = makeWASocket({
    version,
    logger,
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.0"],
  });

  state.sock = socket;

  console.log("Connecting to WhatsApp...");

  if (!socket.authState.creds.registered) {
    try {
      await wait(5000);
      const code = await socket.requestPairingCode(phoneNumber, otpCodeManual);
      console.log("Menunggu verifikasi otp:", code);
    } catch (err) {
      console.error("Error request pairing code:", err);
      throw new Error(err);
      return;
    }
  }

  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    global.sock = socket;

    if (connection === "open") {
      console.log("✅ WhatsApp Berhasil Tertaut!");
      // Simpan socket ke global agar bisa diakses dari controller
      if (!global.sock) {
        global.sock = socket;
      }
      global.isRegistered = true;

      console.log("[SOCKET LOG] state user:", socket.user);
      // Simpan session saat berhasil terhubung
      if (phoneNumber && otpCodeManual) {
        saveSession(phoneNumber, otpCodeManual);
      }
    }

    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
      console.log("❌ Koneksi terputus karena:", lastDisconnect?.error);

      if (shouldReconnect) {
        global.sock = socket;
        global.isRegistered = true;
        global.phone = phoneNumber;
        global.otp = otpCodeManual;
        console.log("🔄 Menghubungkan ulang...");
        connectToWhatsApp(phoneNumber, otpCodeManual);
      } else {
        console.log(
          "🚫 Sesi tidak valid. Silakan hapus folder auth dan scan ulang.",
        );
        clearSession();
      }
    }
  });
}

/**
 * Auto-reconnect menggunakan credentials yang tersimpan
 */
export async function autoReconnect() {
  const session = getSession();
  if (session) {
    console.log("[AUTO] Ditemukan session tersimpan, mencoba reconnect...");
    try {
      global.phone = session.phone;
      global.otp = session.otp;
      global.sock = session.sock;
      // connectToWhatsApp akan set global.sock saat koneksi berhasil
      await connectToWhatsApp(session.phone, session.otp);
      return true;
    } catch (err) {
      console.error("[AUTO] Gagal reconnect:", err);
      clearSession();
    }
  }
  return false;
}

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).json({ success: true, message: "Welcome to WA Gateway API" });
});

app.use("/api/wa", waRoutes);
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Auto-reconnect saat server restart
autoReconnect().then((success) => {
  if (success) {
    console.log("[AUTO] Reconnect berhasil!");
  } else {
    console.log("[AUTO] Tidak ada session tersimpan, perlu register manual");
  }
});
