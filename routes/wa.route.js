import express from "express";
const router = express.Router();
import {
  sendMessage,
  getStatus,
  checkRegistered,
} from "../controllers/wa.controller.js";

router.get("/send-message", sendMessage);
router.get("/status", getStatus);
router.post("/registered", checkRegistered);

export default router;
