import { startWhatsApp } from "../index.js";
import { rm } from "node:fs/promises";
import { clearSession } from "../sessionManager.js";
import path from "path";
import fs from "fs/promises";

let pairingInProgress = false;

// ========== RATE LIMITING PER NOMOR + IP ==========
const otpRateLimit = new Map(); // key: "number|ip", value: { count, firstRequestTime }
const OTP_LIMIT_PER_NUMBER = 3;
const OTP_TIME_WINDOW_MS = 10 * 60 * 1000; // 10 menit

// ========== RATE LIMITING GLOBAL ==========
let globalOtpCount = 0;
let globalResetTime = Date.now() + 60 * 1000; // reset setiap 1 menit
const MAX_GLOBAL_OTP_PER_MINUTE = 30; // maksimal 30 OTP per menit

// Bersihkan data rate limit per nomor secara berkala
setInterval(
  () => {
    const now = Date.now();
    for (const [key, data] of otpRateLimit.entries()) {
      if (now - data.firstRequestTime > OTP_TIME_WINDOW_MS) {
        otpRateLimit.delete(key);
      }
    }
  },
  5 * 60 * 1000,
);

// Reset global counter setiap menit
setInterval(() => {
  globalOtpCount = 0;
  globalResetTime = Date.now() + 60 * 1000;
}, 60 * 1000);

// ========== FUNGSI PENGECEK KONEKSI ==========
const checkWaConnection = (res) => {
  if (!global.sock || !global.isConnected) {
    res.status(503).json({
      success: false,
      message: "Sistem sedang maintenance, coba lagi nanti.",
    });
    return false;
  }
  return true;
};

// ========== FORMAT PESAN OTP ==========
const formatOtpMessage = (otpCode) => {
  return `🔐 *${otpCode}* adalah kode otp Anda

⚠️ *JANGAN BERIKAN KODE INI KEPADA SIAPA PUN*, termasuk yang mengaku sebagai petugas Ade Green TX.

Abaikan pesan ini jika Anda tidak merasa melakukan permintaan.

> *Ade Green TX* – Jaga kerahasiaan akun Anda.`;
};

// ========== CACHE GAMBAR OTP (dibaca sekali saat startup, bukan tiap request) ==========
let otpImageBuffer = null;
try {
  otpImageBuffer = await fs.readFile(
    path.join(process.cwd(), "public", "images", "otp-banner.png"),
  );
  console.log("✅ Banner OTP dimuat ke cache");
} catch {
  console.log("⚠️ Gambar OTP tidak ditemukan, OTP akan dikirim tanpa gambar");
}

// ========== KIRIM PESAN DENGAN TIMEOUT ==========
// Jika koneksi setengah mati, sendMessage bisa hang lama dan menahan request HTTP.
const sendMessageWithTimeout = async (jid, content, timeoutMs = 20000) => {
  let timer;
  try {
    return await Promise.race([
      global.sock.sendMessage(jid, content),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timeout: pesan gagal terkirim")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

// ========== ENDPOINT SEND OTP ==========
export const sendOtp = async (req, res) => {
  try {
    const { number, message } = req.body;
    if (!number || !message) {
      return res.status(400).json({
        success: false,
        message: "Parameter 'number' and 'message' (OTP) required",
      });
    }

    // --- Global rate limiting ---
    if (globalOtpCount >= MAX_GLOBAL_OTP_PER_MINUTE) {
      return res.status(429).json({
        success: false,
        message: "Server sedang sibuk, coba lagi dalam 1 menit.",
      });
    }

    // --- Per-nomor + IP rate limiting ---
    const clientIp = req.ip || req.connection.remoteAddress;
    const rateKey = `${number}|${clientIp}`;
    const now = Date.now();
    const rateData = otpRateLimit.get(rateKey);

    if (rateData) {
      if (now - rateData.firstRequestTime <= OTP_TIME_WINDOW_MS) {
        if (rateData.count >= OTP_LIMIT_PER_NUMBER) {
          const remainSeconds = Math.ceil(
            (OTP_TIME_WINDOW_MS - (now - rateData.firstRequestTime)) / 1000,
          );
          return res.status(429).json({
            success: false,
            message: `Terlalu banyak permintaan OTP. Coba lagi setelah ${remainSeconds} detik.`,
          });
        } else {
          rateData.count++;
          otpRateLimit.set(rateKey, rateData);
        }
      } else {
        otpRateLimit.set(rateKey, { count: 1, firstRequestTime: now });
      }
    } else {
      otpRateLimit.set(rateKey, { count: 1, firstRequestTime: now });
    }

    // Increment global counter
    globalOtpCount++;

    // --- Cek koneksi WhatsApp ---
    if (!checkWaConnection(res)) return;

    // Bersihkan nomor telepon
    const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";
    const otpCode = message; // asumsi message adalah kode OTP

    const formattedText = formatOtpMessage(otpCode);

    // Kirim sebagai SATU pesan (gambar + caption) — jauh lebih cepat
    // daripada 2 pesan terpisah (gambar dulu, lalu teks)
    if (otpImageBuffer) {
      await sendMessageWithTimeout(jid, {
        image: otpImageBuffer,
        caption: formattedText,
      });
    } else {
      await sendMessageWithTimeout(jid, { text: formattedText });
    }

    res.status(200).json({
      success: true,
      message: "Kode OTP berhasil dikirim",
    });
  } catch (error) {
    console.error("Gagal mengirim OTP:", error.message);
    res.status(500).json({
      success: false,
      message: "Gagal mengirim OTP",
    });
  }
};

// ========== ENDPOINT SEND MESSAGE BIASA (tetap dipertahankan) ==========
export const sendMessage = async (req, res) => {
  try {
    const { number, message } = req.body;
    if (!number || !message) {
      return res.status(400).json({
        success: false,
        message: "Parameter 'number' and 'message' required",
      });
    }

    if (!checkWaConnection(res)) return;

    const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";
    await sendMessageWithTimeout(jid, { text: message });
    res.status(200).json({ success: true, message: "Message sent" });
  } catch (error) {
    console.error("Send error:", error);
    res.status(500).json({ success: false, message: "Failed to send" });
  }
};

// ========== CEK STATUS KONEKSI ==========
export const getStatus = async (req, res) => {
  res.status(200).json({
    success: true,
    connected: global.isConnected === true,
    data: global.sock?.user
      ? {
          id: global.sock.user.id,
          name: global.sock.user.name || global.sock.user.pushName,
        }
      : null,
  });
};

// ========== PAIRING (TIDAK PERLU PENGECEKAN MAINTENANCE) ==========
export const checkRegistered = async (req, res) => {
  try {
    const { phoneNumber, otpCodeManual } = req.body;
    if (!phoneNumber || !otpCodeManual) {
      return res.status(400).json({
        success: false,
        message: "phoneNumber and otpCodeManual required",
      });
    }
    if (pairingInProgress) {
      return res
        .status(409)
        .json({ success: false, message: "Pairing already in progress" });
    }

    pairingInProgress = true;

    // Reset state
    global.sock = null;
    global.isConnected = false;

    console.log(
      `Memulai pairing untuk ${phoneNumber} dengan kode: ${otpCodeManual}`,
    );

    startWhatsApp(phoneNumber, otpCodeManual, true)
      .catch((err) => {
        console.error("Pairing error:", err);
        pairingInProgress = false;
      })
      .finally(() => {
        setTimeout(() => {
          pairingInProgress = false;
        }, 5000);
      });

    res.status(200).json({
      success: true,
      message: `Meminta pairing dengan kode "${otpCodeManual}". Buka WhatsApp -> Perangkat Tertaut -> Tautkan Perangkat -> Tautkan dengan nomor telepon, masukkan kode tersebut.`,
    });
  } catch (error) {
    console.error("Error:", error);
    pairingInProgress = false;
    res.status(500).json({ success: false, message: error.message });
  }
};

// ========== LOGOUT ==========
export const logout = async (req, res) => {
  try {
    // Matikan socket dengan benar agar tidak menyisa koneksi ghost
    if (global.sock) {
      try {
        global.sock.ev.removeAllListeners();
        global.sock.end(undefined);
      } catch {}
    }
    global.sock = null;
    global.isConnected = false;
    pairingInProgress = false;
    await rm("./auth_info", { recursive: true, force: true }).catch(() => {});
    await clearSession();
    res.status(200).json({ success: true, message: "Logged out" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
