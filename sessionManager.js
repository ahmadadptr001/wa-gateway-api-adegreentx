import fs from "fs";
import path from "path";

const SESSION_FILE = path.join(process.cwd(), "session_data.json");

export function saveSession(phoneNumber, otpCodeManual = null) {
  const data = {
    phone: phoneNumber,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  console.log("[SESSION] Metadata saved for phone:", phoneNumber);
}

export function getSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      console.log("[SESSION] Loaded session:", data.phone);
      return data;
    }
  } catch (err) {
    console.error("[SESSION] Error loading session:", err);
  }
  return null;
}

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
