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
  return `🔐 *KODE OTP ANDA: ${otpCode}*

Halo, permintaan verifikasi dari *Ade Green TX* sedang diproses.

⚠️ *JANGAN BERIKAN KODE INI KEPADA SIAPA PUN*, termasuk yang mengaku sebagai petugas Ade Green TX.

Kode ini hanya untuk verifikasi login / reset password Anda.

Abaikan pesan ini jika Anda tidak merasa melakukan permintaan.

✅ *Ade Green TX* – Jaga kerahasiaan akun Anda.`;
};

// ========== KIRIM GAMBAR OTP (jika ada) ==========
const sendOtpImage = async (jid) => {
  const imagePath = path.join(
    process.cwd(),
    "public",
    "images",
    "otp-banner.png",
  );
  try {
    await fs.access(imagePath);
    const imageBuffer = await fs.readFile(imagePath);
    await global.sock.sendMessage(jid, { image: imageBuffer, caption: " " });
    console.log("✅ Gambar OTP terkirim");
  } catch (err) {
    console.log("⚠️ Gambar OTP tidak ditemukan, lanjut tanpa gambar");
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

    // Kirim teks OTP (kode di awal)
    const formattedText = formatOtpMessage(otpCode);
    await global.sock.sendMessage(jid, { text: formattedText });

    // Kirim gambar pendukung (jika ada)
    await sendOtpImage(jid);

    res.status(200).json({
      success: true,
      message: "Kode OTP berhasil dikirim",
    });
  } catch (error) {
    console.error("Gagal mengirim OTP:", error);
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
    await global.sock.sendMessage(jid, { text: message });
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
