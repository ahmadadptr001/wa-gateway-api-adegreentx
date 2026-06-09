import { connectToWhatsApp } from "../index.js";
import { rm } from "node:fs/promises";
import { clearSession } from "../sessionManager.js";

// Variabel untuk menyimpan status koneksi dan pairing code sementara
let connectionPromise = null; // Untuk mencegah multiple connect simultan
let pendingPairingCode = null; // Menyimpan pairing code untuk response

export const sendMessage = async (req, res) => {
  const globalSock = global.sock;

  try {
    // Ubah ke POST, ambil dari body
    const { number, message } = req.body;

    if (!number || !message) {
      return res.status(400).json({
        success: false,
        message: "Parameter 'number' and 'message' required in body",
      });
    }

    if (!globalSock || !global.isConnected) {
      return res.status(503).json({
        success: false,
        message: "WhatsApp not connected. Please pair first.",
      });
    }

    const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";
    await globalSock.sendMessage(jid, { text: message });

    res
      .status(200)
      .json({ success: true, message: "Message sent successfully" });
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).json({ success: false, message: "Failed to send message" });
  }
};

export const getStatus = async (req, res) => {
  const globalSock = global.sock;
  const isConnected = global.isConnected === true;

  res.status(200).json({
    success: true,
    connected: isConnected,
    data:
      isConnected && globalSock?.user
        ? {
            id: globalSock.user.id || null,
            name: globalSock.user.name || globalSock.user.pushName || null,
          }
        : null,
    pairingCode: pendingPairingCode, // Jika sedang menunggu pairing
  });
};

export const checkRegistered = async (req, res) => {
  try {
    const { phoneNumber } = req.body; // Hanya butuh phoneNumber, tidak perlu OTP manual

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        message: "'phoneNumber' required",
      });
    }

    // Jika sudah dalam proses koneksi, tolak permintaan baru
    if (connectionPromise) {
      return res.status(409).json({
        success: false,
        message: "Pairing process already in progress. Wait or restart.",
      });
    }

    // Reset state global
    global.sock = null;
    global.isConnected = false;
    pendingPairingCode = null;

    // Hapus auth lama untuk memulai pairing fresh (opsional, bisa dihapus jika ingin retain)
    await rm("./auth_info", { recursive: true, force: true });
    clearSession(); // Hapus metadata session

    console.log("Starting pairing for phone number:", phoneNumber);

    // Jalankan koneksi dan tunggu sampai pairing code didapat atau timeout
    connectionPromise = connectToWhatsApp(phoneNumber);

    // Kita perlu menunggu sampai event pairing-code keluar atau koneksi berhasil
    // Karena connectToWhatsApp sekarang mengembalikan Promise yang resolve saat koneksi open ATAU reject jika gagal
    // Namun untuk pairing code, kita tangkap di event dan simpan ke pendingPairingCode
    // Kita akan response setelah koneksi berhasil atau setelah pairing code siap? Sebaiknya response dulu bahwa pairing dimulai,
    // lalu client polling status untuk mendapatkan pairing code.

    // Tapi agar lebih sederhana, kita tunggu maksimal 10 detik untuk mendapatkan pairing code
    let codeReceived = false;
    const codePromise = new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (pendingPairingCode) {
          clearInterval(checkInterval);
          resolve(pendingPairingCode);
        }
      }, 500);
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error("Timeout waiting for pairing code"));
      }, 10000);
    });

    try {
      const code = await codePromise;
      res.status(200).json({
        success: true,
        paired: false,
        pairingCode: code,
        message: `Use this pairing code in WhatsApp: ${code}`,
      });
    } catch (err) {
      // Jika timeout, tapi mungkin koneksi sudah berhasil? Cek status global
      if (global.isConnected) {
        res.status(200).json({
          success: true,
          paired: true,
          message: "Already connected",
        });
      } else {
        res.status(500).json({
          success: false,
          message: "Failed to get pairing code: " + err.message,
        });
      }
    } finally {
      connectionPromise = null;
    }
  } catch (error) {
    console.error("Error in pairing:", error);
    connectionPromise = null;
    res.status(500).json({
      success: false,
      message: "Failed to initialize: " + error.message,
    });
  }
};

// Fungsi untuk logout / reset
export const logout = async (req, res) => {
  try {
    global.sock = null;
    global.isConnected = false;
    pendingPairingCode = null;
    await rm("./auth_info", { recursive: true, force: true });
    clearSession();
    res
      .status(200)
      .json({ success: true, message: "Logged out and session cleared" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
