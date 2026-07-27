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

// พนักงานพิมพ์ข้อความนี้ตรงๆ (ไม่ได้กดปุ่ม quick reply) ก็ให้รับทราบงานได้เหมือนกัน เผื่อปุ่มเก่าถูกข้อความใหม่ทับไปแล้วกดไม่ได้อีก
const ACK_TEXT_PATTERN = /^รับทราบ(แล้ว)?$/;

// รอลูกค้าพิมพ์ให้ครบก่อนค่อยประมวลผล+ตอบทีเดียว กันเคสลูกค้าพิมพ์แยกเป็นหลายข้อความติดกัน
// (เช่น พิมพ์ทีละประโยค) แล้วบอทตอบสวนทุกข้อความจนดูงงๆ/ตอบไม่ตรงบริบท
// ทุกครั้งที่มีข้อความใหม่เข้ามาจากคนเดิม จะรีเซ็ตตัวจับเวลาใหม่ ถ้าเงียบไปครบเวลานี้แล้วค่อยรวมข้อความทั้งหมดส่งไปวิเคราะห์ทีเดียว
const BATCH_WAIT_MS = 60 * 1000; // ~1 นาที ตามที่ร้านต้องการ ปรับได้ตรงนี้จุดเดียว
const pendingBatches = new Map(); // key = LINE userId -> { texts: string[], timer }

// LINE ต้องการ raw body สำหรับตรวจลายเซ็น (เพิ่ม middleware เฉพาะ route นี้ใน server.js แล้ว)
router.post("/line", async (req, res) => {
  const signature = req.headers["x-line-signature"];
  const rawBody = req.rawBody || JSON.stringify(req.body);

  if (!line.verifySignature(rawBody, signature)) {
    return res.sendStatus(401);
  }

  res.sendStatus(200); // ตอบ LINE ทันทีก่อน กันหมดเวลา (ไม่เกี่ยวกับการตอบลูกค้า ซึ่งอาจถูกหน่วงไว้ตาม batch ด้านล่าง)

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

  // ---- flow ลงทะเบียนพนักงาน (ใช้ร่วมกันทุกตำแหน่ง: เซล/ทีมอะไหล่/หัวหน้าสาขา) ตอบทันที ไม่ต้องรอ batch ----
  if (text.startsWith(REGISTER_KEYWORD)) {
    return handleStaffRegister(event, userId, text, event.replyToken);
  }

  // ---- flow พนักงานพิมพ์ "รับทราบแล้ว" ตรงๆ (ไม่ได้กดปุ่ม) ----
  // เผื่อปุ่ม quick reply ของงานเก่าโดนข้อความใหม่ทับไปแล้วกดไม่ได้อีก ให้พิมพ์ข้อความนี้แทนได้เลย
  // หาให้เองว่าเป็นพนักงานคนไหนจาก lineUserId ที่เคยลงทะเบียนไว้ แล้วรับทราบงานที่ค้างนานที่สุดของคนนั้นให้อัตโนมัติ ทีละงาน
  if (ACK_TEXT_PATTERN.test(text)) {
    return handleAckByText(userId);
  }

  // ---- flow ปกติ: คุยกับลูกค้า ผ่าน Claude -> เข้าคิว batch รอรวมข้อความก่อนตอบ ----
  const session = getSession("line", userId);
  if (session.handedOff) return;

  scheduleBatchedReply(userId);
  let batch = pendingBatches.get(userId);
  if (!batch) {
    batch = { texts: [] };
    pendingBatches.set(userId, batch);
  }
  batch.texts.push(text);
}

// รีเซ็ตตัวจับเวลาทุกครั้งที่มีข้อความใหม่เข้ามาจากลูกค้าคนเดิม ถ้าเงียบไปครบ BATCH_WAIT_MS ค่อยประมวลผลรวมทีเดียว
function scheduleBatchedReply(userId) {
  const existing = pendingBatches.get(userId);
  if (existing && existing.timer) {
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => {
    flushBatch(userId).catch((err) => console.error("[lineWebhook] flushBatch error:", err.message));
  }, BATCH_WAIT_MS);

  if (existing) {
    existing.timer = timer;
  } else {
    pendingBatches.set(userId, { texts: [], timer });
  }
}

// รวมข้อความทั้งหมดที่ลูกค้าพิมพ์มาในช่วงที่รอ (คั่นด้วยขึ้นบรรทัดใหม่) แล้ววิเคราะห์+ตอบครั้งเดียว
// ใช้ push message แทน reply message เพราะ replyToken ของ LINE ใช้ได้แค่ครั้งเดียวและหมดอายุเร็วกว่าเวลาที่รอ (~1 นาที)
async function flushBatch(userId) {
  const batch = pendingBatches.get(userId);
  pendingBatches.delete(userId);
  if (!batch || batch.texts.length === 0) return;

  const combinedText = batch.texts.join("\n");
  const session = getSession("line", userId);
  if (session.handedOff) return;

  try {
    const analysis = await claude.analyzeMessage(session.history, combinedText, session.fallbackCount);
    session.history.push({ role: "user", content: combinedText });
    session.history.push({ role: "assistant", content: JSON.stringify(analysis) });

    if (!session.customerName) {
      session.customerName = await line.getProfile(userId);
    }

    const replyText = await routing.handleTurn({
      session,
      analysis,
      rawMessage: combinedText,
      platform: "line",
      userId,
      customerName: session.customerName,
    });
    saveSession("line", userId, session);
    await line.pushMessage(userId, replyText);
  } catch (err) {
    console.error("[lineWebhook] flushBatch handle error:", err.message);
    try {
      await line.pushMessage(userId, "ขอโทษนะคะ ระบบขัดข้องชั่วคราว เดี๋ยวทีมงานติดต่อกลับไปนะคะ");
    } catch (_) {}
  }
}

// แยกข้อความหลังคำสั่งลงทะเบียนออกเป็น [รหัส, PIN] เช่น "staff1 4173" -> ["staff1","4173"]
function parseIdAndPin(remainder) {
  const parts = remainder.trim().split(/\s+/).filter(Boolean);
  return { id: parts[0] || "", pin: parts[1] || "" };
}

// ป้ายชื่อ role ให้อ่านง่ายเป็นภาษาไทย ใช้แสดงในข้อความยืนยันหลังลงทะเบียนสำเร็จ
function roleLabelTh(role) {
  if (role === "sales") return "เซล";
  if (role === "parts") return "ทีมอะไหล่";
  if (role === "supervisor") return "หัวหน้าสาขา";
  return role || "พนักงาน";
}

// ใช้ได้กับพนักงานทุกตำแหน่ง (เซล/ทีมอะไหล่/หัวหน้าสาขา) เพราะทุกคนอยู่ในแท็บ Staff เดียวกันหมดแล้ว
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
async function handlePostback(event) {
  const data = event.postback && event.postback.data;
  if (!data || !data.startsWith("ack:")) return;

  const refId = data.slice(4);
  await acknowledgeAndReply(event.source.userId, refId);
}

// พนักงานพิมพ์ "รับทราบแล้ว" ตรงๆ เป็นข้อความ (ไม่ได้กดปุ่ม) -> หาว่าเป็นพนักงานคนไหนจาก lineUserId แล้วรับทราบงานที่ค้างนานสุดให้ทีละงาน
async function handleAckByText(userId) {
  try {
    const staff = await store.findStaffByLineUserId(userId);
    if (!staff) {
      await line.pushMessage(userId, "ขอโทษนะคะ ไม่พบว่าไลน์นี้ลงทะเบียนเป็นพนักงานในระบบไว้ค่ะ (ลงทะเบียนก่อนด้วยคำสั่ง \"ลงทะเบียน <รหัสพนักงาน> <PIN>\")");
      return;
    }
    const pending = await store.getPendingRefsForStaff(staff.name, staff.branchId, null);
    if (pending.length === 0) {
      await line.pushMessage(userId, "ตอนนี้ไม่มีงานค้างที่ต้องรับทราบแล้วนะคะ ✅");
      return;
    }
    // รับทราบงานที่ค้างนานที่สุด (เก่าสุด) ก่อนเสมอ
    await acknowledgeAndReply(userId, pending[0].refId);
  } catch (err) {
    console.error("[lineWebhook] handleAckByText error:", err.message);
  }
}

// รับทราบงานตาม refId ที่ระบุ (ใช้ร่วมกันทั้งตอนกดปุ่ม quick reply และตอนพิมพ์ "รับทราบแล้ว" เป็นข้อความ)
// แจ้งผลกลับพร้อมเลขที่งานเสมอ (กันสับสนว่ารับทราบงานไหนไปแล้วบ้าง) และถ้ายังมีงานอื่นค้างไม่รับทราบอยู่อีก แจ้งจำนวนที่เหลือให้รู้ด้วย
// รองรับทั้ง lead (ขาย/เทิร์นรถ/ทั่วไป ขึ้นต้น LD-) และ booking (นัดซ่อม ขึ้นต้น BK-) แยกว่าจะรับทราบฝั่งไหนจาก prefix ของ id เอง
async function acknowledgeAndReply(userId, refId) {
  const isBooking = refId.startsWith("BK-");
  try {
    const result = isBooking ? await store.acknowledgeBooking(refId) : await store.acknowledgeLead(refId);
    if (!result) {
      await line.pushMessage(userId, "ไม่พบรายการนี้ในระบบแล้วนะคะ (เลขที่: " + refId + ") อาจถูกบันทึกรับทราบไปแล้ว หรือถูกยกเลิกไปก่อนหน้านี้ค่ะ");
      return;
    }
    if (result.alreadyAcknowledged) {
      await line.pushMessage(
        userId,
        "รับทราบแล้วก่อนหน้านี้นะคะ (เลขที่: " + refId + ", ใช้เวลา " + result.responseTimeMin + " นาที)"
      );
      return;
    }

    let replyText = "รับทราบแล้วค่ะ ✅ (เลขที่: " + refId + ") ใช้เวลา " + result.responseTimeMin + " นาที ขอบคุณนะคะ";

    if (result.staffName && result.branchId) {
      const remaining = await store.getPendingRefsForStaff(result.staffName, result.branchId, refId);
      if (remaining.length > 0) {
        replyText +=
          "\n\nยังเหลืออีก " +
          remaining.length +
          " งานที่ยังไม่ได้รับทราบนะคะ พิมพ์ \"รับทราบแล้ว\" อีกครั้งเพื่อรับทราบงานถัดไป หรือกดปุ่มในข้อความก่อนหน้าได้เลยค่ะ";
      }
    }

    await line.pushMessage(userId, replyText);
  } catch (err) {
    console.error("[lineWebhook] acknowledgeAndReply error:", err.message);
  }
}

module.exports = router;
