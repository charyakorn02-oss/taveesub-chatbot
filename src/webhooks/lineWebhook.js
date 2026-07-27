// รับ event ข้อความจาก LINE OA แล้วส่งเข้า pipeline เดียวกับ Facebook
"use strict";

const express = require("express");
const router = express.Router();
const claude = require("../services/claude");
const line = require("../services/line");
const routing = require("../routing/router");
const store = require("../services/store");
const { getSession, saveSession } = require("../session/sessionStore");

// คำสั่งลับสำหรับพนักงานทุกตำแหน่ง (เซล/ทีมอะไหล่/หัวหน้าสาขา): พิมพ์ "ลงทะเบียน <รหัสพนักงาน> <PIN>" ทักมาที่ LINE OA
// เพื่อผูก LINE userId ส่วนตัวของตัวเองเข้ากับรหัสพนักงานในแท็บ Staff (ทุกตำแหน่งอยู่แท็บเดียวกันหมดแล้ว แยกด้วยคอลัมน์ role)
// ต้องใส่ PIN ที่ตรงกับคอลัมน์ registerPin ของแถวนั้นด้วย กันคนอื่นเดารหัสพนักงานแล้วสวมสิทธิ์
// (ต้องทำครั้งเดียว หลังจากนั้นระบบจะส่ง lead/นัดซ่อม/ข้อความ escalate ตรงมาหาแอคเคาท์ไลน์นี้ตาม role ของแต่ละคน)
const REGISTER_KEYWORD = "ลงทะเบียน";

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
      } else if (event.type === "postback") {
        await handlePostback(event);
      }
    }
  } catch (err) {
    console.error("[lineWebhook] error:", err.message);
  }
});

async function handleLineText(event) {
  const userId = event.source.userId;
  const text = (event.message.text || "").trim();
  const replyToken = event.replyToken;

  if (text.startsWith(REGISTER_KEYWORD)) {
    return handleStaffRegister(event, userId, text, replyToken);
  }

  const session = getSession("line", userId);
  if (session.handedOff) return;

  try {
    const analysis = await claude.analyzeMessage(session.history, text, session.fallbackCount);
    session.history.push({ role: "user", content: text });
    session.history.push({ role: "assistant", content: JSON.stringify(analysis) });

    if (!session.customerName) {
      session.customerName = await line.getProfile(userId);
    }

    const replyText = await routing.handleTurn({
      session,
      analysis,
      rawMessage: text,
      platform: "line",
      userId,
      customerName: session.customerName,
    });
    saveSession("line", userId, session);
    await line.replyMessage(replyToken, replyText);
  } catch (err) {
    console.error("[lineWebhook] handleLineText error:", err.message);
    try {
      await line.replyMessage(replyToken, "ขอโทษนะคะ ระบบขัดข้องชั่วคราว เดี๋ยวทีมงานติดต่อกลับไปนะคะ");
    } catch (_) {}
  }
}

function parseIdAndPin(remainder) {
  const parts = remainder.trim().split(/\s+/).filter(Boolean);
  return { id: parts[0] || "", pin: parts[1] || "" };
}

function roleLabelTh(role) {
  if (role === "sales") return "เซล";
  if (role === "parts") return "ทีมอะไหล่";
  if (role === "supervisor") return "หัวหน้าสาขา";
  return role || "พนักงาน";
}

async function handleStaffRegister(event, userId, text, replyToken) {
  const { id: staffId, pin } = parseIdAndPin(text.replace(REGISTER_KEYWORD, ""));
  if (!staffId || !pin) {
    await line.replyMessage(replyToken, "พิมพ์ตามแบบนี้นะคะ: ลงทะเบียน <รหัสพนักงาน> <PIN> เช่น ลงทะเบียน staff1 4173 (PIN ขอได้จากผู้จัดการ/แอดมิน)");
    return;
  }
  try {
    const staff = await store.findStaffById(staffId);
    if (!staff) {
      await line.replyMessage(replyToken, "ไม่พบรหัส \"" + staffId + "\" ในระบบ รบกวนเช็ครหัสในชีต Staff อีกครั้งนะคะ");
      return;
    }
    if (staff.lineUserId) {
      await line.replyMessage(
        replyToken,
        "รหัส \"" + staffId + "\" นี้เคยลงทะเบียนไลน์ไปแล้วนะคะ ถ้าต้องการเปลี่ยนไลน์ใหม่ รบกวนให้ผู้จัดการ/แอดมินล้างค่าในชีต Staff ให้ก่อนนะคะ"
      );
      return;
    }
    if (String(staff.registerPin || "") !== pin) {
      await line.replyMessage(replyToken, "PIN ไม่ถูกต้องนะคะ รบกวนเช็ค PIN กับผู้จัดการ/แอดมินอีกครั้งนะคะ");
      return;
    }
    if (await store.isLineUserIdTaken(userId)) {
      await line.replyMessage(
        replyToken,
        "ไลน์นี้ถูกผูกกับตำแหน่งอื่นในระบบไปแล้วนะคะ 1 ไลน์ลงทะเบียนได้แค่ 1 ตำแหน่งเท่านั้น ถ้ามีปัญหารบกวนติดต่อผู้จัดการ/แอดมินนะคะ"
      );
      return;
    }
    await store.setStaffLineUserId(staffId, userId);
    const roleLabel = roleLabelTh(staff.role);
    await line.replyMessage(
      replyToken,
      "ลงทะเบียนสำเร็จค่ะ คุณ " + staff.name + " (" + roleLabel + ") ✅ ต่อไปนี้ระบบจะส่งแจ้งเตือนที่เกี่ยวข้องมาที่ไลน์นี้โดยตรงนะคะ"
    );
  } catch (err) {
    console.error("[lineWebhook] handleStaffRegister error:", err.message);
    try {
      await line.replyMessage(replyToken, "ขอโทษนะคะ ลงทะเบียนไม่สำเร็จ ลองใหม่อีกครั้งนะคะ");
    } catch (_) {}
  }
}

// เซล/ทีมอะไหล่/หัวหน้าสาขา กดปุ่ม "รับทราบแล้ว" -> บันทึกเวลาที่ตอบกลับ
// รองรับทั้ง lead (ขาย/เทิร์นรถ/ทั่วไป ขึ้นต้น LD-) และ booking (นัดซ่อม ขึ้นต้น BK-) เพราะใช้ปุ่มเดียวกัน (data = "ack:<id>")
// แยกว่าจะรับทราบฝั่งไหนจาก prefix ของ id เอง
async function handlePostback(event) {
  const data = event.postback && event.postback.data;
  if (!data || !data.startsWith("ack:")) return;

  const refId = data.slice(4);
  const isBooking = refId.startsWith("BK-");

  try {
    const result = isBooking ? await store.acknowledgeBooking(refId) : await store.acknowledgeLead(refId);
    if (!result) {
      await line.pushMessage(event.source.userId, "ไม่พบรายการนี้ในระบบแล้วนะคะ (อาจถูกบันทึกไปแล้ว)");
      return;
    }
    if (result.alreadyAcknowledged) {
      await line.pushMessage(
        event.source.userId,
        "รับทราบแล้วก่อนหน้านี้นะคะ (ใช้เวลา " + result.responseTimeMin + " นาที)"
      );
      return;
    }
    await line.pushMessage(
      event.source.userId,
      "บันทึกแล้วค่ะ ✅ รับทราบภายใน " + result.responseTimeMin + " นาที ขอบคุณนะคะ"
    );
  } catch (err) {
    console.error("[lineWebhook] handlePostback error:", err.message);
  }
}

module.exports = router;
