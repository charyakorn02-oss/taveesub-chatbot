// รับ event จาก Facebook (Messenger DM + คอมเมนต์) แล้วส่งเข้า pipeline เดียวกัน
"use strict";

const express = require("express");
const router = express.Router();
const claude = require("../services/claude");
const facebook = require("../services/facebook");
const routing = require("../routing/router");
const { getSession, saveSession } = require("../session/sessionStore");

// ใช้ตรวจสอบ Webhook ตอนตั้งค่าครั้งแรกใน Facebook App Dashboard
router.get("/facebook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.FB_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// รับ event จริง
router.post("/facebook", async (req, res) => {
  // ตอบ 200 กลับให้ Facebook ทันทีก่อน (ป้องกัน retry ซ้ำ) แล้วค่อยประมวลผลต่อ
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== "page") return;

    for (const entry of body.entry || []) {
      // 1) คอมเมนต์ใหม่ได้โพสต์ (Pull to Inbox)
      for (const change of entry.changes || []) {
        if (change.field === "feed" && change.value && change.value.item === "comment") {
          await handleComment(change.value);
        }
      }

      // 2) ข้อความ Messenger ตรง
      for (const evt of entry.messaging || []) {
        if (evt.message && evt.message.text) {
          await handleMessengerText(evt.sender.id, evt.message.text);
        }
      }
    }
  } catch (err) {
    console.error("[facebookWebhook] error:", err.message);
  }
});

async function handleComment(commentValue) {
  const commentId = commentValue.comment_id;
  const senderMessage = commentValue.message || "";

  // กรองสแปมเบื้องต้นแบบง่าย: ต้องมีคำที่เกี่ยวกับความสนใจ
  const interestKeywords = ["สนใจ", "ราคา", "มีไหม", "ขอ", "สอบถาม", "รุ่น"];
  const looksInterested = interestKeywords.some((k) => senderMessage.includes(k));
  if (!looksInterested) return;

  try {
    await facebook.replyToComment(commentId, "ทักแชทมาคุยรายละเอียดได้เลยครับ 😊 Inbox ไปหาแล้วนะครับ");
    await facebook.privateReplyToComment(commentId, "สวัสดีครับ 👋 มีอะไรให้ช่วยไหมครับ");
  } catch (err) {
    console.error("[facebookWebhook] handleComment error:", err.message);
  }
}

async function handleMessengerText(psid, text) {
  const session = getSession("facebook", psid);

  if (session.handedOff) {
    // handoff ไปแล้ว ปล่อยให้พนักงานคุยต่อเอง บอทไม่ต้องแทรก
    return;
  }

  try {
    const analysis = await claude.analyzeMessage(session.history, text, session.fallbackCount);
    session.history.push({ role: "user", content: text });
    session.history.push({ role: "assistant", content: JSON.stringify(analysis) });

    // ดึงชื่อ Facebook ของลูกค้า เก็บไว้ครั้งเดียวใน session กันเรียก API ซ้ำทุกข้อความ
    if (!session.customerName) {
      session.customerName = await facebook.getProfile(psid);
    }

    const replyText = await routing.handleTurn({
      session,
      analysis,
      rawMessage: text,
      platform: "facebook",
      userId: psid,
      customerName: session.customerName,
    });

    saveSession("facebook", psid, session);
    await facebook.sendMessage(psid, replyText);
  } catch (err) {
    console.error("[facebookWebhook] handleMessengerText error:", err.message);
    try {
      await facebook.sendMessage(psid, "ขอโทษครับ ระบบขัดข้องชั่วคราว เดี๋ยวทีมงานติดต่อกลับไปนะครับ");
    } catch (_) {}
  }
}

module.exports = router;
