import express from "express";
const router = express.Router();
import {
  sendMessage,
  getStatus,
  checkRegistered,
  logout,
  sendOtp,
} from "../controllers/wa.controller.js";

router.post("/send-message", sendMessage);
router.get("/status", getStatus);
router.post("/registered", checkRegistered);
router.post("/logout", logout);
router.post("/send-otp", sendOtp);

export default router;
