import fs from "fs/promises";
import path from "path";

const SESSION_FILE = path.join(process.cwd(), "session_data.json");

export async function saveSession(phoneNumber, otpCodeManual) {
  const data = {
    phone: phoneNumber,
    otp: otpCodeManual,
    savedAt: new Date().toISOString(),
  };
  await fs.writeFile(SESSION_FILE, JSON.stringify(data, null, 2));
  console.log("[SESSION] Tersimpan:", phoneNumber);
}

export async function getSession() {
  try {
    await fs.access(SESSION_FILE);
    const content = await fs.readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    return null;
  }
}

export async function clearSession() {
  try {
    await fs.unlink(SESSION_FILE);
  } catch (err) {
    // ignore if not exists
  }
}
