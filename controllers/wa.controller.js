import { connectToWhatsApp } from "../index.js";
import { rm } from "node:fs/promises";
import { clearSession } from "../sessionManager.js";

let pairingInProgress = false;

export const sendMessage = async (req, res) => {
  const globalSock = global.sock;
  try {
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
  const isConnected = global.isConnected === true;
  const pairingCode = global.pendingPairingCode || null;
  res.status(200).json({
    success: true,
    connected: isConnected,
    pairingCode: pairingCode, // hanya ini yang dikirim
    data:
      isConnected && global.sock?.user
        ? {
            id: global.sock.user.id || null,
            name: global.sock.user.name || global.sock.user.pushName || null,
          }
        : null,
  });
};

export const checkRegistered = async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      return res
        .status(400)
        .json({ success: false, message: "'phoneNumber' required" });
    }

    if (pairingInProgress) {
      return res.status(409).json({
        success: false,
        message: "Pairing already in progress. Please wait.",
      });
    }

    // Reset state global
    global.sock = null;
    global.isConnected = false;
    global.pendingPairingCode = null;
    pairingInProgress = true;

    // Hapus auth folder dan session metadata
    try {
      await rm("./auth_info", { recursive: true, force: true });
    } catch (err) {}
    clearSession();

    console.log("Starting pairing for phone number:", phoneNumber);

    // Jalankan pairing di background
    connectToWhatsApp(phoneNumber).catch((err) => {
      console.error("Background pairing error:", err);
      pairingInProgress = false;
    });

    res.status(200).json({
      success: true,
      message: "Pairing initiated. Poll /status to get pairing code.",
    });
  } catch (error) {
    console.error("Error starting pairing:", error);
    pairingInProgress = false;
    res.status(500).json({
      success: false,
      message: "Failed to start pairing: " + error.message,
    });
  }
};

export const logout = async (req, res) => {
  try {
    global.sock = null;
    global.isConnected = false;
    global.pendingPairingCode = null;
    pairingInProgress = false;
    await rm("./auth_info", { recursive: true, force: true });
    clearSession();
    res
      .status(200)
      .json({ success: true, message: "Logged out and session cleared" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
