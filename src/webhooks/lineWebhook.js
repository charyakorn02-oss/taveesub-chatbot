// รับ event ข้อความจาก LINE OA แล้วส่งเข้า pipeline เดียวกับ Facebook
"use strict";

const express = require("express");
const router = express.Router();

const claude = require("../services/claude");
const line = require("../services/line");
const routing = require("../routing/router");
const { getSession, saveSession } = require("../session/sessionStore");

// LINE ต้องการ raw body สำหรับตรวจลายเซ็น (เพิ่ม middleware เฉพาะ route นี้ใน server.js แล้ว)
router.post("/line", async (req, res) => {
  const signature = req.headers["x-line-signature"];
  const rawBody = req.rawBody || JSON.stringify(req.body);

  if (!line.verifySignature(rawBody, signature)) {
    return res.sendStatus(401);
  }

  res.sendStatus(200); // ตอบ LINE ทันทีก่อน กันหมดเวลา

  try {
    const events = req.body.events || [];
    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        await handleLineText(event);
      }
    }
  } catch (err) {
    console.error("[lineWebhook] error:", err.message);
  }
});

async function handleLineText(event) {
  const userId = event.source.userId;
  const text = event.message.text;
  const replyToken = event.replyToken;

  const session = getSession("line", userId);
  if (session.handedOff) return;

  try {
    const analysis = await claude.analyzeMessage(session.history, text, session.fallbackCount);
    session.history.push({ role: "user", content: text });
    session.history.push({ role: "assistant", content: JSON.stringify(analysis) });

    const replyText = await routing.handleTurn({
      session,
      analysis,
      rawMessage: text,
      platform: "line",
      userId,
    });

    saveSession("line", userId, session);
    await line.replyMessage(replyToken, replyText);
  } catch (err) {
    console.error("[lineWebhook] handleLineText error:", err.message);
    try {
      await line.replyMessage(replyToken, "ขอโทษครับ ระบบขัดข้องชั่วคราว เดี๋ยวทีมงานติดต่อกลับไปนะครับ");
    } catch (_) {}
  }
}

module.exports = router;
