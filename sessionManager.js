import fs from "fs";
import path from "path";

const SESSION_FILE = path.join(process.cwd(), "session_data.json");

export function saveSession(phoneNumber, otpCodeManual) {
  const data = {
    phone: phoneNumber,
    otp: otpCodeManual,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  console.log("[SESSION] Tersimpan:", phoneNumber);
}

export function getSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    }
  } catch (err) {}
  return null;
}

export function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch (err) {}
}
