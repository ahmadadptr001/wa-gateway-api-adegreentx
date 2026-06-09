import { connectToWhatsApp } from "../index.js";
import { rm } from "node:fs/promises";
import { clearSession } from "../sessionManager.js";

let connectionPromise = null;

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
    pairingCode: pairingCode,
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
      return res.status(400).json({
        success: false,
        message: "'phoneNumber' required",
      });
    }

    if (connectionPromise) {
      return res.status(409).json({
        success: false,
        message: "Pairing process already in progress. Wait or restart.",
      });
    }

    // Reset state global
    global.sock = null;
    global.isConnected = false;
    global.pendingPairingCode = null;

    // Hapus auth lama untuk pairing fresh (opsional)
    try {
      await rm("./auth_info", { recursive: true, force: true });
    } catch (err) {
      console.log("No existing auth_info to delete");
    }
    clearSession();

    console.log("Starting pairing for phone number:", phoneNumber);

    connectionPromise = connectToWhatsApp(phoneNumber);

    // Tunggu maksimal 15 detik untuk mendapatkan pairing code atau koneksi langsung
    const result = await Promise.race([
      connectionPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Timeout waiting for connection")),
          15000,
        ),
      ),
    ]);

    connectionPromise = null;

    // Jika sudah terhubung langsung (sudah ada session)
    if (global.isConnected) {
      return res.status(200).json({
        success: true,
        paired: true,
        message: "Already connected",
      });
    }

    // Jika belum terhubung, cek apakah ada pairing code
    if (global.pendingPairingCode) {
      return res.status(200).json({
        success: true,
        paired: false,
        pairingCode: global.pendingPairingCode,
        message: `Use this pairing code in WhatsApp: ${global.pendingPairingCode}`,
      });
    }

    // Fallback
    return res.status(500).json({
      success: false,
      message: "Failed to get pairing code or connection",
    });
  } catch (error) {
    console.error("Error in pairing:", error);
    connectionPromise = null;
    res.status(500).json({
      success: false,
      message: "Failed to initialize: " + error.message,
    });
  }
};

export const logout = async (req, res) => {
  try {
    global.sock = null;
    global.isConnected = false;
    global.pendingPairingCode = null;
    await rm("./auth_info", { recursive: true, force: true });
    clearSession();
    res
      .status(200)
      .json({ success: true, message: "Logged out and session cleared" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
