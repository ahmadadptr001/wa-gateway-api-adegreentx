import express from "express";
const router = express.Router();
import {
  sendMessage,
  getStatus,
  checkRegistered,
  logout,
} from "../controllers/wa.controller.js";

router.post("/send-message", sendMessage); // ubah ke POST
router.get("/status", getStatus);
router.post("/registered", checkRegistered);
router.post("/logout", logout); // endpoint baru untuk reset

export default router;
