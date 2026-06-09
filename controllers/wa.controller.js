import { startWhatsApp } from "../index.js";
import { rm } from "node:fs/promises";
import { clearSession } from "../sessionManager.js";

let pairingInProgress = false;

export const sendMessage = async (req, res) => {
  try {
    const { number, message } = req.body;
    if (!number || !message) {
      return res.status(400).json({
        success: false,
        message: "Parameter 'number' and 'message' required",
      });
    }
    if (!global.sock || !global.isConnected) {
      return res
        .status(503)
        .json({ success: false, message: "WhatsApp not connected" });
    }
    const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";
    await global.sock.sendMessage(jid, { text: message });
    res.status(200).json({ success: true, message: "Message sent" });
  } catch (error) {
    console.error("Send error:", error);
    res.status(500).json({ success: false, message: "Failed to send" });
  }
};

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

    // JANGAN hapus auth_info di sini! Biarkan startWhatsApp yang mengelola

    console.log(
      `Memulai pairing untuk ${phoneNumber} dengan kode: ${otpCodeManual}`,
    );

    // Jalankan startWhatsApp dengan flag pairing = true
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

export const logout = async (req, res) => {
  try {
    global.sock = null;
    global.isConnected = false;
    pairingInProgress = false;
    // Hapus auth folder hanya saat logout manual
    await rm("./auth_info", { recursive: true, force: true }).catch(() => {});
    await clearSession();
    res.status(200).json({ success: true, message: "Logged out" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
