// รับ event ข้อความจาก LINE OA แล้วส่งเข้า pipeline เดียวกับ Facebook
"use strict";

const express = require("express");
const router = express.Router();
const claude = require("../services/claude");
const line = require("../services/line");
const routing = require("../routing/router");
const store = require("../services/store");
const { getSession, saveSession } = require("../session/sessionStore");

// คำสั่งลับสำหรับพนักงาน: พิมพ์ "ลงทะเบียน <รหัสพนักงาน>" ทักมาที่ LINE OA
// เพื่อผูก LINE userId ส่วนตัวของตัวเองเข้ากับรหัสพนักงานในชีต Staff
// (ต้องทำครั้งเดียว หลังจากนั้นระบบจะส่ง lead ตรงมาหาแอคเคาท์ไลน์นี้)
const REGISTER_KEYWORD = "ลงทะเบียน";

// คำสั่งลับสำหรับหัวหน้าสาขา: พิมพ์ "ลงทะเบียนหัวหน้า <รหัสสาขา>" ทักมาที่ LINE OA
// เพื่อผูก LINE userId ของหัวหน้าเข้ากับสาขา ใช้ตอน escalate lead ที่เซลตอบช้า
const REGISTER_SUPERVISOR_KEYWORD = "ลงทะเบียนหัวหน้า";

// คำสั่งลับสำหรับทีมอะไหล่ประจำสาขา: พิมพ์ "ลงทะเบียนอะไหล่ <รหัสสาขา>" ทักมาที่ LINE OA
// เพื่อผูก LINE userId ของทีมอะไหล่เข้ากับสาขา ใช้ตอนมีลูกค้าจองคิวซ่อม บอทจะส่งรายละเอียดรถ/อาการมาไลน์นี้ตรงๆ
const REGISTER_PARTS_KEYWORD = "ลงทะเบียนอะไหล่";

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

  // ---- flow ลงทะเบียนทีมอะไหล่ (เช็คก่อน เพราะขึ้นต้นคำเดียวกับลงทะเบียนพนักงาน) ----
  if (text.startsWith(REGISTER_PARTS_KEYWORD)) {
    return handlePartsRegister(event, userId, text, replyToken);
  }

  // ---- flow ลงทะเบียนหัวหน้าสาขา (เช็คก่อน เพราะขึ้นต้นคำเดียวกับลงทะเบียนพนักงาน) ----
  if (text.startsWith(REGISTER_SUPERVISOR_KEYWORD)) {
    return handleSupervisorRegister(event, userId, text, replyToken);
  }

  // ---- flow ลงทะเบียนพนักงาน ----
  if (text.startsWith(REGISTER_KEYWORD)) {
    return handleStaffRegister(event, userId, text, replyToken);
  }

  // ---- flow ปกติ: คุยกับลูกค้า ผ่าน Claude ----
  const session = getSession("line", userId);
  if (session.handedOff) return;

  try {
    const analysis = await claude.analyzeMessage(session.history, text, session.fallbackCount);
    session.history.push({ role: "user", content: text });
    session.history.push({ role: "assistant", content: JSON.stringify(analysis) });

    // ดึงชื่อ LINE ของลูกค้า เก็บไว้ครั้งเดียวใน session กันเรียก API ซ้ำทุกข้อความ
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
      await line.replyMessage(replyToken, "ขอโทษครับ ระบบขัดข้องชั่วคราว เดี๋ยวทีมงานติดต่อกลับไปนะครับ");
    } catch (_) {}
  }
}

async function handleStaffRegister(event, userId, text, replyToken) {
  const staffId = text.replace(REGISTER_KEYWORD, "").trim();
  if (!staffId) {
    await line.replyMessage(replyToken, "พิมพ์ตามแบบนี้นะครับ: ลงทะเบียน <รหัสพนักงาน> เช่น ลงทะเบียน staff1");
    return;
  }
  try {
    const staff = await store.findStaffById(staffId);
    if (!staff) {
      await line.replyMessage(replyToken, `ไม่พบรหัสพนักงาน "${staffId}" ในระบบ รบกวนเช็ครหัสในชีต Staff อีกครั้งนะครับ`);
      return;
    }
    await store.setStaffLineUserId(staffId, userId);
    await line.replyMessage(replyToken, `ลงทะเบียนสำเร็จครับ คุณ ${staff.name} ✅ ต่อไปนี้ lead ใหม่จะส่งแจ้งเตือนมาที่ไลน์นี้โดยตรง`);
  } catch (err) {
    console.error("[lineWebhook] handleStaffRegister error:", err.message);
    try {
      await line.replyMessage(replyToken, "ขอโทษครับ ลงทะเบียนไม่สำเร็จ ลองใหม่อีกครั้งนะครับ");
    } catch (_) {}
  }
}

async function handleSupervisorRegister(event, userId, text, replyToken) {
  const branchId = text.replace(REGISTER_SUPERVISOR_KEYWORD, "").trim();
  if (!branchId) {
    await line.replyMessage(replyToken, "พิมพ์ตามแบบนี้นะครับ: ลงทะเบียนหัวหน้า <รหัสสาขา> เช่น ลงทะเบียนหัวหน้า branch1");
    return;
  }
  try {
    const branches = await store.getAllBranches();
    const branch = branches.find((b) => b.id === branchId);
    if (!branch) {
      await line.replyMessage(replyToken, `ไม่พบรหัสสาขา "${branchId}" ในระบบ รบกวนเช็ครหัสในชีต Branches อีกครั้งนะครับ`);
      return;
    }
    await store.setBranchSupervisorLineUserId(branchId, userId);
    await line.replyMessage(
      replyToken,
      `ลงทะเบียนสำเร็จครับ หัวหน้าสาขา ${branch.name} ✅ ต่อไปนี้ถ้ามีเซลตอบ lead ช้าเกินกำหนด ระบบจะแจ้งเตือนมาที่ไลน์นี้`
    );
  } catch (err) {
    console.error("[lineWebhook] handleSupervisorRegister error:", err.message);
    try {
      await line.replyMessage(replyToken, "ขอโทษครับ ลงทะเบียนไม่สำเร็จ ลองใหม่อีกครั้งนะครับ");
    } catch (_) {}
  }
}

// ทีมอะไหล่ประจำสาขาลงทะเบียนไลน์ของตัวเอง หลังจากนี้บอทจะส่งรายละเอียดรถ/อาการของลูกค้าที่จองคิวซ่อมมาไลน์นี้ตรงๆ
async function handlePartsRegister(event, userId, text, replyToken) {
  const branchId = text.replace(REGISTER_PARTS_KEYWORD, "").trim();
  if (!branchId) {
    await line.replyMessage(replyToken, "พิมพ์ตามแบบนี้นะครับ: ลงทะเบียนอะไหล่ <รหัสสาขา> เช่น ลงทะเบียนอะไหล่ branch1");
    return;
  }
  try {
    const branches = await store.getAllBranches();
    const branch = branches.find((b) => b.id === branchId);
    if (!branch) {
      await line.replyMessage(replyToken, `ไม่พบรหัสสาขา "${branchId}" ในระบบ รบกวนเช็ครหัสในชีต Branches อีกครั้งนะครับ`);
      return;
    }
    await store.setBranchPartsLineUserId(branchId, userId);
    await line.replyMessage(
      replyToken,
      `ลงทะเบียนสำเร็จครับ ทีมอะไหล่สาขา ${branch.name} ✅ ต่อไปนี้ลูกค้าจองคิวซ่อมจะส่งรายละเอียดรถ/อาการมาที่ไลน์นี้โดยตรง`
    );
  } catch (err) {
    console.error("[lineWebhook] handlePartsRegister error:", err.message);
    try {
      await line.replyMessage(replyToken, "ขอโทษครับ ลงทะเบียนไม่สำเร็จ ลองใหม่อีกครั้งนะครับ");
    } catch (_) {}
  }
}

// เซลกดปุ่ม "รับทราบแล้ว" ใน quick reply -> บันทึกเวลาที่ตอบกลับ และเวลาที่ใช้ตั้งแต่แจ้งเตือน
async function handlePostback(event) {
  const data = event.postback && event.postback.data;
  if (!data || !data.startsWith("ack:")) return;

  const leadId = data.slice(4);
  try {
    const result = await store.acknowledgeLead(leadId);
    if (!result) {
      await line.pushMessage(event.source.userId, "ไม่พบ lead นี้ในระบบแล้วครับ (อาจถูกบันทึกไปแล้ว)");
      return;
    }
    if (result.alreadyAcknowledged) {
      await line.pushMessage(
        event.source.userId,
        `รับทราบแล้วก่อนหน้านี้ครับ (ใช้เวลา ${result.responseTimeMin} นาที)`
      );
      return;
    }
    await line.pushMessage(
      event.source.userId,
      `บันทึกแล้วครับ ✅ รับทราบ lead ภายใน ${result.responseTimeMin} นาที ขอบคุณครับ`
    );
  } catch (err) {
    console.error("[lineWebhook] handlePostback error:", err.message);
  }
}

module.exports = router;
