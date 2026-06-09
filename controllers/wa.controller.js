import { connectToWhatsApp } from "../index.js";
import { rm } from "node:fs/promises";
import { clearSession } from "../sessionManager.js";

let pairingInProgress = false;

export const sendMessage = async (req, res) => {
  const globalSock = global.sock;
  try {
    const { number, message } = req.body;
    if (!number || !message) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Parameter 'number' and 'message' required",
        });
    }
    if (!globalSock || !global.isConnected) {
      return res
        .status(503)
        .json({ success: false, message: "WhatsApp not connected" });
    }
    const jid = number.replace(/\D/g, "") + "@s.whatsapp.net";
    await globalSock.sendMessage(jid, { text: message });
    res.status(200).json({ success: true, message: "Message sent" });
  } catch (error) {
    console.error("Send error:", error);
    res.status(500).json({ success: false, message: "Failed to send" });
  }
};

export const getStatus = async (req, res) => {
  const isConnected = global.isConnected === true;
  res.status(200).json({
    success: true,
    connected: isConnected,
    data:
      isConnected && global.sock?.user
        ? {
            id: global.sock.user.id,
            name: global.sock.user.name || global.sock.user.pushName,
          }
        : null,
  });
};

export const checkRegistered = async (req, res) => {
  try {
    let { phoneNumber, otpCodeManual } = req.body;
    if (!phoneNumber || !otpCodeManual) {
      return res
        .status(400)
        .json({
          success: false,
          message: "phoneNumber and otpCodeManual required",
        });
    }
    if (pairingInProgress) {
      return res
        .status(409)
        .json({ success: false, message: "Pairing already in progress" });
    }

    // Reset state
    global.sock = null;
    global.isConnected = false;
    pairingInProgress = true;

    // Hapus auth lama
    try {
      await rm("./auth_info", { recursive: true, force: true });
    } catch (err) {}
    clearSession();

    console.log(
      "Starting pairing for:",
      phoneNumber,
      "with custom OTP:",
      otpCodeManual,
    );
    connectToWhatsApp(phoneNumber, otpCodeManual).catch((err) => {
      console.error("Background pairing error:", err);
      pairingInProgress = false;
    });

    res
      .status(200)
      .json({
        success: true,
        message: "Pairing initiated. Please wait for connection.",
      });
  } catch (error) {
    console.error("Error starting pairing:", error);
    pairingInProgress = false;
    res.status(500).json({ success: false, message: error.message });
  }
};

export const logout = async (req, res) => {
  try {
    global.sock = null;
    global.isConnected = false;
    pairingInProgress = false;
    await rm("./auth_info", { recursive: true, force: true });
    clearSession();
    res.status(200).json({ success: true, message: "Logged out" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
