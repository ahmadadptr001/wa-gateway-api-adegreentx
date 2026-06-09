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

// State global
global.sock = null;
global.isConnected = false;
let reconnectAttempts = 0;
let reconnectTimeout = null;

/**
 * Connect to WhatsApp dan return Promise yang resolve saat koneksi open atau reject jika gagal.
 * Jika belum terautentikasi, akan menghasilkan pairing code dan menyimpannya ke global.pendingPairingCode.
 */
export async function connectToWhatsApp(phoneNumber) {
  return new Promise(async (resolve, reject) => {
    const authState = await useMultiFileAuthState("auth_info");
    const { state, saveCreds } = authState;
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger,
      auth: state,
      browser: ["Ubuntu", "Chrome", "20.0.0"],
    });

    let resolved = false;
    let timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        sock.end(new Error("Connection timeout"));
        reject(new Error("Connection timeout after 60 seconds"));
      }
    }, 60000);

    // Event untuk pairing code (jika belum terautentikasi)
    sock.ev.on("pairing-code", (code) => {
      console.log("Pairing code received:", code);
      global.pendingPairingCode = code;
      // Jangan resolve di sini, tunggu koneksi open
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
          reconnectAttempts = 0; // Reset reconnect attempts

          // Simpan metadata session (tanpa OTP, hanya phone number)
          if (phoneNumber) {
            saveSession(phoneNumber, null); // OTP tidak perlu
          }
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
          // Jika belum resolve (berarti gagal saat pairing), reject saja
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
          // Koneksi yang sudah berhasil tiba-tiba putus, lakukan reconnect dengan backoff
          scheduleReconnect();
        } else {
          // 401 Unauthorized, hapus session dan tidak usah reconnect
          console.log("Session invalid, clearing auth folder...");
          await clearSession();
          await rm("./auth_info", { recursive: true, force: true }).catch(
            () => {},
          );
          global.sock = null;
          global.isConnected = false;
        }
      }
    });

    // Jika sudah memiliki credentials yang valid, tidak perlu pairing code
    // Tapi jika belum, kita panggil requestPairingCode untuk memulai pairing
    // Periksa apakah sudah terdaftar
    const isRegistered = sock.authState.creds.registered === true; // properti registered di creds?
    if (!isRegistered && phoneNumber) {
      try {
        // Minta pairing code secara manual (opsional, karena event pairing-code akan tetap keluar)
        await sock.requestPairingCode(phoneNumber);
        console.log("Requested pairing code for", phoneNumber);
      } catch (err) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      }
    } else if (isRegistered) {
      // Sudah punya session, tunggu koneksi open
      console.log("Existing session found, waiting for connection...");
    } else {
      // Tidak ada phoneNumber, tidak bisa pairing
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
  const baseDelay = 5000; // 5 detik
  const delay = Math.min(baseDelay * Math.pow(2, reconnectAttempts), 60000);

  if (reconnectAttempts >= maxAttempts) {
    console.log("Max reconnect attempts reached. Manual restart required.");
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
    } else {
      console.log("No saved phone number, cannot auto-reconnect");
    }
  }, delay);
}

// Auto-reconnect saat server start
export async function autoReconnect() {
  const session = getSession();
  if (session && session.phone) {
    console.log("Auto-reconnecting with saved phone:", session.phone);
    try {
      await connectToWhatsApp(session.phone);
      console.log("Auto-reconnect successful");
      return true;
    } catch (err) {
      console.error("Auto-reconnect failed:", err);
      clearSession();
      return false;
    }
  }
  return false;
}

// Middleware & server
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).json({ success: true, message: "Welcome to WA Gateway API" });
});

app.use("/api/wa", waRoutes);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Auto-reconnect setelah server jalan
autoReconnect();
