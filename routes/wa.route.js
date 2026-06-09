import express from "express";
const router = express.Router();
import {
  sendMessage,
  getStatus,
  checkRegistered,
  logout,
} from "../controllers/wa.controller.js";

router.post("/send-message", sendMessage);
router.get("/status", getStatus);
router.post("/registered", checkRegistered);
router.post("/logout", logout);

export default router;
