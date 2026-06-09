import { connectToWhatsApp } from "../index.js";
import { rm } from "node:fs/promises";
import { clearSession } from "../sessionManager.js";

export const sendMessage = async (req, res) => {
  let globalSock = global.sock;

  try {
    const { number, message } = req.query;

    if (!number || !message) {
      return res.status(400).json({
        success: false,
        message: "Parameter 'number' and 'message' required",
      });
    }

    if (!globalSock) {
      return res.status(503).json({
        success: false,
        message: "WhatsApp socket not initialized. Call /registered first.",
      });
    }

    // Format nomor: hapus karakter non-digit, tambahkan @s.whatsapp.net
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
  let globalSock = global.sock;
  console.log("[LOG SOCKET] state: ", globalSock);
  try {
    let isConnected = globalSock?.authState?.registered;
    z;
    // Cara 2: Cek dari WebSocket readyState (0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED)
    res.status(200).json({
      success: true,
      connected: isConnected ? true : false,
      data: isConnected
        ? {
            id: globalSock.user?.id || null,
            name: globalSock.user?.name || globalSock.user?.pushName || null,
          }
        : null,
    });
  } catch (error) {
    console.error("Error getting status:", error);
    res.status(500).json({ success: false, message: "Failed to get status" });
  }
};

export const checkRegistered = async (req, res) => {
  try {
    const { phoneNumber, otpCodeManual } = req.body;

    if (!phoneNumber || !otpCodeManual) {
      return res.status(400).json({
        success: false,
        message: " 'phoneNumber and 'otpCodeManual' required",
      });
    }

    await rm("./auth_info", { recursive: true, force: true });
    clearSession(); // Hapus session lama

    console.log("nomor hp:" + phoneNumber);
    console.log("kode otp:", otpCodeManual);

    try {
      await connectToWhatsApp(phoneNumber, otpCodeManual);
      res.status(200).json({
        success: true,
        registered: true,
        message:
          "Device initialization started. Check pairing code in server logs.",
      });
    } catch (err) {
      res.status(400).json({
        success: false,
        registered: false,
        message: err.message,
      });
    }
  } catch (error) {
    console.error("Error checking registration:", error);
    res.status(500).json({
      success: false,
      message: "Failed to initialize: " + error.message,
    });
  }
};
