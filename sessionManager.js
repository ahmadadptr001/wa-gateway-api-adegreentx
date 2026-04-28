import fs from "fs";
import path from "path";

const SESSION_FILE = path.join(process.cwd(), "session_data.json");

/**
 * Simpan metadata session ke file
 */
export function saveSession(phoneNumber, otpCodeManual) {
  const data = {
    phone: phoneNumber,
    otp: otpCodeManual,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  console.log("[SESSION] Metadata saved!");
}

/**
 * Ambil metadata session dari file
 */
export function getSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      console.log("[SESSION] Loaded session:", data);
      return data;
    }
  } catch (err) {
    console.error("[SESSION] Error loading session:", err);
  }
  return null;
}

/**
 * Hapus session saat logout/reset
 */
export function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
      console.log("[SESSION] Session cleared");
    }
  } catch (err) {
    console.error("[SESSION] Error clearing session:", err);
  }
}
