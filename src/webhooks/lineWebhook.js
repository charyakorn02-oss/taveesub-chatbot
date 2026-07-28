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
// รองรับพิมพ์เลขต่อท้ายด้วย (เช่น "รับทราบ 2" หรือ "รับทราบ #2") เพื่อระบุว่าจะรับทราบงานลำดับไหน (เลขเดียวกับที่โชว์ในปุ่ม "รับทราบ #N")
// ถ้าพิมพ์แค่ "รับทราบ" เฉยๆ ไม่ใส่เลข และมีงานค้างมากกว่า 1 งาน จะไม่เดาให้อีกต่อไป (ดู handleAckByText) จะถามกลับให้ระบุเลขแทน
const ACK_TEXT_PATTERN = /^รับทราบ(?:แล้ว)?\s*#?\s*(\d+)?$/;

// รอลูกค้าพิมพ์ให้ครบก่อนค่อยประมวลผล+ตอบทีเดียว กันเคสลูกค้าพิมพ์แยกเป็นหลายข้อความติดกัน
// (เช่น พิมพ์ทีละประโยค) แล้วบอทตอบสวนทุกข้อความจนดูงงๆ/ตอบไม่ตรงบริบท
// ทุกครั้งที่มีข้อความใหม่เข้ามาจากคนเดิม จะรีเซ็ตตัวจับเวลาใหม่ ถ้าเงียบไปครบเวลานี้แล้วค่อยรวมข้อความทั้งหมดส่งไปวิเคราะห์ทีเดียว
// ข้อความแรกสุดของ batch รอ 20 วิ (ให้เวลาลูกค้าพิมพ์ประโยคต่อได้ทัน) ส่วนข้อความถัดๆ ไปในรอบเดียวกันรอแค่ 10 วิพอ (ลูกค้าน่าจะพิมพ์ใกล้จะจบแล้ว)
const FIRST_BATCH_WAIT_MS = 20 * 1000;
const SUBSEQUENT_BATCH_WAIT_MS = 10 * 1000;
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
  // หาให้เองว่าเป็นพนักงานคนไหนจาก lineUserId ที่เคยลงทะเบียนไว้ แล้วรับทราบงานตามเลขที่ระบุ (หรือถามกลับถ้าไม่ระบุและมีมากกว่า 1 งาน)
  const ackMatch = text.match(ACK_TEXT_PATTERN);
  if (ackMatch) {
    const indexNum = ackMatch[1] ? Number(ackMatch[1]) : null;
    return handleAckByText(userId, indexNum);
  }

  // ---- flow ปกติ: คุยกับลูกค้า ผ่าน Claude -> เข้าคิว batch รอรวมข้อความก่อนตอบ ----
  const session = await getSession("line", userId);
  if (session.handedOff) return;

  const existingBatch = pendingBatches.get(userId);
  const isFirstMessage = !existingBatch || existingBatch.texts.length === 0;
  scheduleBatchedReply(userId, isFirstMessage);
  let batch = pendingBatches.get(userId);
  if (!batch) {
    batch = { texts: [] };
    pendingBatches.set(userId, batch);
  }
  batch.texts.push(text);

  // เซฟข้อความที่ค้างอยู่ในคิว batch ลง Sheets ด้วย (fire-and-forget) เผื่อเซิร์ฟเวอร์รีสตาร์ทพอดีตอนลูกค้ากำลังพิมพ์อยู่
  // (เช่น deploy โค้ดใหม่ชนจังหวะพอดี) กันข้อความหายเงียบๆ โดยไม่มีการตอบกลับเลย — จะถูกกู้คืนตอนบูตเครื่องรอบถัดไป (ดู recoverPendingBatches)
  store.savePendingBatch(`line:${userId}`, batch.texts).catch((err) => {
    console.error("[lineWebhook] savePendingBatch error:", err.message);
  });
}

// รีเซ็ตตัวจับเวลาทุกครั้งที่มีข้อความใหม่เข้ามาจากลูกค้าคนเดิม ถ้าเงียบไปครบเวลาที่กำหนดแล้วค่อยประมวลผลรวมทีเดียว
// isFirstMessage = true ตอนเป็นข้อความแรกของ batch นี้ (รอ 20 วิ) ส่วนข้อความถัดๆ ไปรอแค่ 10 วิ (ดูค่าคงที่ด้านบน)
function scheduleBatchedReply(userId, isFirstMessage) {
  const existing = pendingBatches.get(userId);
  if (existing && existing.timer) {
    clearTimeout(existing.timer);
  }
  const waitMs = isFirstMessage ? FIRST_BATCH_WAIT_MS : SUBSEQUENT_BATCH_WAIT_MS;
  const timer = setTimeout(() => {
    flushBatch(userId).catch((err) => console.error("[lineWebhook] flushBatch error:", err.message));
  }, waitMs);

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

  // เคลียร์ backup ใน Sheets ทิ้งด้วยเสมอ (ไม่ว่าจะมีข้อความจริงให้ประมวลผลรอบนี้หรือไม่) กันขยะค้าง
  store.clearPendingBatch(`line:${userId}`).catch((err) => {
    console.error("[lineWebhook] clearPendingBatch error:", err.message);
  });

  if (!batch || batch.texts.length === 0) return;

  const combinedText = batch.texts.join("\n");
  const session = await getSession("line", userId);
  if (session.handedOff) return;

  try {
    const analysis = await claude.analyzeMessage(session.history, combinedText, session.fallbackCount, session.collected);
    session.history.push({ role: "user", content: combinedText });

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
    // สำคัญมาก: ต้องเก็บ "ข้อความจริงที่ลูกค้าเห็น" (replyText หลัง routing ปรับแล้ว) ไว้เป็นประวัติฝั่งบอท ไม่ใช่ JSON ดิบจาก Claude
    // (analysis) เพราะ router.js มักเขียนทับ/สร้างข้อความเองใหม่ทั้งหมด (เช่น ตอนแนะนำสาขา, ตอน handoff) ทำให้ JSON เดิมไม่ตรงกับ
    // สิ่งที่ลูกค้าเห็นจริง ถ้าเก็บ JSON ไว้ รอบถัดไป Claude จะอ่านประวัติตัวเองแล้วงงว่าเคยพูดอะไรไปจริงๆ กลายเป็นอาการ "ลืม"/ถามซ้ำ
    session.history.push({ role: "assistant", content: replyText });
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

// พนักงานพิมพ์ "รับทราบแล้ว" ตรงๆ เป็นข้อความ (ไม่ได้กดปุ่ม) -> หาว่าเป็นพนักงานคนไหนจาก lineUserId แล้วรับทราบงานตามเลขที่ระบุ (indexNum)
// เลข #N ตรงกับลำดับที่โชว์ในปุ่ม quick reply / ข้อความแจ้งเตือน (เรียงเก่าสุดไปใหม่สุดเหมือนกันทั้งสองที่)
// ถ้าไม่ได้ระบุเลขมาและมีงานค้างมากกว่า 1 งาน จะไม่เดาว่าเป็นงานไหนให้อีกต่อไป (กันรับทราบผิดงาน) จะถามกลับพร้อมลิสต์ให้พนักงานเลือกแทน
async function handleAckByText(userId, indexNum) {
  try {
    const staff = await store.findStaffByLineUserId(userId);
    if (!staff) {
      await line.pushMessage(userId, "ขอโทษนะคะ ไม่พบว่าไลน์นี้ลงทะเบียนเป็นพนักงานในระบบไว้ค่ะ (ลงทะเบียนก่อนด้วยคำสั่ง \"ลงทะเบียน <รหัสพนักงาน> <PIN>\")");
      return;
    }
    const pending = (await store.getPendingRefsForStaff(staff.name, staff.branchId, null)).filter((p) => p && p.refId);
    if (pending.length === 0) {
      await line.pushMessage(userId, "ตอนนี้ไม่มีงานค้างที่ต้องรับทราบแล้วนะคะ ✅");
      return;
    }

    if (indexNum) {
      const target = pending[indexNum - 1];
      if (!target) {
        await line.pushMessage(
          userId,
          `ไม่พบงาน #${indexNum} นะคะ ตอนนี้มีงานค้างอยู่ดังนี้ค่ะ:\n${buildPendingListText(pending)}\n\nพิมพ์ "รับทราบ #เลข" เพื่อระบุงานที่ต้องการรับทราบได้เลยค่ะ`
        );
        return;
      }
      await acknowledgeAndReply(userId, target.refId);
      return;
    }

    if (pending.length === 1) {
      // มีงานค้างแค่งานเดียว รับทราบให้เลย ไม่ต้องให้พิมพ์เลขซ้ำ
      await acknowledgeAndReply(userId, pending[0].refId);
      return;
    }

    // มีงานค้างหลายงานแต่ไม่ได้ระบุเลขมา -> ถามกลับให้ชัดเจนว่าจะรับทราบงานไหน แทนที่จะเดาเอาเองว่าเป็นงานที่ค้างนานสุด
    await line.pushMessage(
      userId,
      `ตอนนี้มีงานค้างรับทราบอยู่ ${pending.length} งานนะคะ พิมพ์ "รับทราบ #เลข" เพื่อระบุว่าจะรับทราบงานไหนค่ะ:\n${buildPendingListText(pending)}`
    );
  } catch (err) {
    console.error("[lineWebhook] handleAckByText error:", err.message);
  }
}

// สร้างข้อความลิสต์งานค้างพร้อมเลขลำดับ #N (ใช้ทั้งตอนถามกลับให้เลือก และตอนแจ้งว่าเลขที่พิมพ์มาไม่พบ)
function buildPendingListText(pending) {
  return pending
    .map((p, i) => `#${i + 1}) [${p.type === "booking" ? "นัดซ่อม" : "Lead"}] ลูกค้า: ${p.customerName || "-"} | เรื่อง: ${p.detail || "-"}`)
    .join("\n");
}

// รับทราบงานตาม refId ที่ระบุ (ใช้ร่วมกันทั้งตอนกดปุ่ม quick reply และตอนพิมพ์ "รับทราบแล้ว" เป็นข้อความ)
// แจ้งผลกลับพร้อมเลขที่งานเสมอ (กันสับสนว่ารับทราบงานไหนไปแล้วบ้าง) และถ้ายังมีงานอื่นค้างไม่รับทราบอยู่อีก แจ้งจำนวนที่เหลือให้รู้ด้วย
// รองรับทั้ง lead (ขาย/เทิร์นรถ/ทั่วไป ขึ้นต้น LD-) และ booking (นัดซ่อม ขึ้นต้น BK-) แยกว่าจะรับทราบฝั่งไหนจาก prefix ของ id เอง
async function acknowledgeAndReply(userId, refId) {
  // กันเหนียว: กรณี refId หลุดมาว่าง/undefined (เช่น ข้อมูลตกหล่นในชีต) ไม่ให้ crash ทั้งฟังก์ชัน
  if (!refId) {
    console.error("[lineWebhook] acknowledgeAndReply error: refId ว่างเปล่า");
    await line.pushMessage(userId, "ขอโทษนะคะ ไม่พบเลขที่งานที่จะรับทราบ รบกวนลองพิมพ์ \"รับทราบแล้ว\" ใหม่อีกครั้งนะคะ 🙏");
    return;
  }
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

// เรียกครั้งเดียวตอนเซิร์ฟเวอร์เพิ่งบูต (ดู server.js) เพื่อดึงข้อความที่ค้างอยู่จากตอนก่อนรีสตาร์ท (เช่น deploy โค้ดใหม่
// ชนจังหวะพอดีตอนลูกค้ากำลังพิมพ์อยู่ในช่วงรอ batch) กลับมาประมวลผลต่อให้ทันที กันลูกค้าเห็นบอทเงียบหายไปดื้อๆ
async function recoverPendingBatches() {
  try {
    const leftover = await store.getAllPendingBatches();
    for (const item of leftover) {
      if (!item.sessionKey.startsWith("line:")) continue;
      const userId = item.sessionKey.slice("line:".length);
      if (!userId || !item.texts || item.texts.length === 0) continue;
      console.log(`[lineWebhook] กู้คืนข้อความค้างจากตอนรีสตาร์ทให้ลูกค้า ${userId} (${item.texts.length} ข้อความ)`);
      pendingBatches.set(userId, { texts: item.texts });
      await flushBatch(userId).catch((err) => console.error("[lineWebhook] recoverPendingBatches flushBatch error:", err.message));
    }
  } catch (err) {
    console.error("[lineWebhook] recoverPendingBatches error:", err.message);
  }
}

router.recoverPendingBatches = recoverPendingBatches;
module.exports = router;
