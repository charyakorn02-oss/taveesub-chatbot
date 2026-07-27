"use strict";

require("dotenv").config();

const express = require("express");
const facebookWebhook = require("./webhooks/facebookWebhook");
const lineWebhook = require("./webhooks/lineWebhook");
const store = require("./services/store");
const line = require("./services/line");

const app = express();

// เก็บ raw body ไว้ด้วย เพราะ LINE ต้องใช้ raw body ไปคำนวณลายเซ็นตรวจสอบความถูกต้อง
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

app.get("/", (req, res) => {
  res.send("Taveesub Yanyont chatbot server กำลังทำงานอยู่ค่ะ ✅");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.use("/webhook", facebookWebhook);
app.use("/webhook", lineWebhook);

// ตรวจทุกกี่นาทีว่า lead/booking ไหนพนักงานยังไม่รับทราบเกินเวลาที่กำหนด แล้วแจ้งเตือน
// แจ้งทั้งเซล/ทีมอะไหล่คนเดิม (เตือนซ้ำ) และหัวหน้าสาขาไปพร้อมกันเสมอ (ครบ 100% ทุกกรณี ไม่มีเคสไหนไม่มีคนตาม)
// ทั้งคู่ได้ปุ่ม "รับทราบแล้ว" ผูกกับ lead/booking เดียวกัน ใครกดก่อนก็บันทึกเป็นอันนั้น ไม่ปนกับ lead อื่น
const ESCALATION_THRESHOLD_MIN = 30;
const ESCALATION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// เวลาทำการร้าน (ใช้กันไม่ให้แจ้งเตือนตามงาน/เตือนซ้ำไปกวนพนักงานนอกเวลางาน เช่นตอนดึก)
// จันทร์–เสาร์ 08:00–17:30, อาทิตย์ 09:00–16:00 (ตามข้อมูลเวลาเปิด-ปิดร้านจริงในชีต FAQ)
// หมายเหตุ: การแจ้งเตือนแรกตอนมี lead/booking ใหม่ยังส่งได้ตลอดเวลา (ลูกค้าทักได้ทุกเมื่อ) — ที่ต้องเว้นเวลาคือ "การเตือนซ้ำ" (escalation) เท่านั้น
function isBusinessHours(date = new Date()) {
  // เซิร์ฟเวอร์ Render รันเป็นเวลา UTC เสมอ แปลงเป็นเวลาไทย (UTC+7 ตลอดปี ไม่มี DST) ตรงนี้ก่อนเช็ค
  const bangkok = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const day = bangkok.getUTCDay(); // 0 = อาทิตย์, 1-6 = จันทร์-เสาร์
  const minutesOfDay = bangkok.getUTCHours() * 60 + bangkok.getUTCMinutes();

  if (day === 0) {
    return minutesOfDay >= 9 * 60 && minutesOfDay < 16 * 60; // อาทิตย์ 09:00–16:00
  }
  return minutesOfDay >= 8 * 60 && minutesOfDay < 17 * 60 + 30; // จันทร์–เสาร์ 08:00–17:30
}

// สร้างข้อความสรุปงานค้างเก่าที่ยังไม่มีใครกดรับทราบ (ถ้ามี) แปะไว้ก่อนเนื้อหาแจ้งเตือนเสมอ พร้อมเลขที่งานแยกชัดเจนทีละงาน
// (เหมือนกับที่ใช้ใน routing/router.js — ทำซ้ำที่นี่เพื่อกัน circular require เพราะ server.js กับ router.js ไม่ได้พึ่งพากันโดยตรง)
function buildPendingJobsSection(pendingRefs) {
  if (!pendingRefs.length) return "";
  const lines = pendingRefs
    .map((p, i) => {
      const typeLabel = p.type === "booking" ? "นัดซ่อม" : "Lead";
      return `#${i + 1}) [${typeLabel}] ลูกค้า: ${p.customerName || "-"} | เรื่อง: ${p.detail || "-"} | เลขที่: ${p.refId}`;
    })
    .join("\n");
  return (
    "⚠️ มีงานค้างที่ยังไม่มีใครกดรับทราบอยู่ก่อนหน้านี้ด้วยนะคะ (" + pendingRefs.length + " งาน):\n" +
    lines +
    "\n\n———————————\n\n"
  );
}

async function notifyEscalation({ refId, branchId, staffName, customerName, modelOrIssue, phone, platform, label }) {
  const branch = await store.getBranchById(branchId);
  const supervisor = await store.getSupervisorForBranch(branchId);
  const text =
    "⏰ แจ้งเตือน: " + label + " ยังไม่มีคนรับทราบเกิน " + ESCALATION_THRESHOLD_MIN + " นาที\n" +
    "สาขา: " + (branch ? branch.name : branchId) + "\n" +
    "ผู้รับผิดชอบเดิม: " + (staffName || "-") + "\n" +
    "ลูกค้า (" + (platform || "-") + "): " + (customerName || "-") + "\n" +
    "รุ่นที่สนใจ/อาการ: " + (modelOrIssue || "-") + "\n" +
    "เบอร์ลูกค้า: " + (phone || "-") + "\n" +
    "เลขที่: " + refId;

  // เตือนซ้ำไปหาคนเดิมที่รับผิดชอบก่อน (ถ้ามีไลน์) เผื่อแค่พลาดไม่เห็นข้อความตอนแรก
  // พร้อมรวมงานอื่นที่ค้างไม่รับทราบของคนเดิมมาในข้อความเดียวกันด้วย (ใช้ปุ่มแยกทีละงาน กันงานเก่าหลุดไปเงียบๆ)
  const staff = staffName ? (await store.getActiveStaff()).find((s) => s.name === staffName && s.branchId === branchId) : null;
  const pending = staff ? await store.getPendingRefsForStaff(staff.name, staff.branchId, refId) : [];
  const fullText = buildPendingJobsSection(pending) + (pending.length ? `#${pending.length + 1}) ` : "") + text;
  const allIds = [...pending.map((p) => p.refId), refId];

  if (staff && staff.lineUserId) {
    try {
      await line.pushMessageWithAck(staff.lineUserId, fullText, allIds);
    } catch (err) {
      console.error("[escalation] re-notify staff error:", err.message);
    }
  }

  // และแจ้งหัวหน้าสาขาเสมอ ให้ช่วยตามงานต่อ (พร้อมปุ่มรับทราบผูกกับ ref เดียวกัน + งานค้างเก่าเดียวกัน)
  if (supervisor && supervisor.lineUserId) {
    try {
      await line.pushMessageWithAck(supervisor.lineUserId, fullText, allIds);
    } catch (err) {
      console.error("[escalation] notify supervisor error:", err.message);
    }
  } else {
    console.warn("[escalation] สาขา " + branchId + " ยังไม่ได้ลงทะเบียนหัวหน้าสาขา (role=supervisor) ข้ามการแจ้งเตือน");
  }
}

async function checkEscalations() {
  // นอกเวลาทำการ -> ยังไม่เตือนซ้ำตอนนี้ รอบถัดไป (ทุก 5 นาที) จะเช็คซ้ำเรื่อยๆ จนกว่าจะเข้าเวลาทำการแล้วค่อยแจ้งทันที
  // (lead/booking ที่ค้างจะยังไม่ถูก markEscalated ตอนนี้ เลยไม่หลุดจากการตรวจสอบไปไหน)
  if (!isBusinessHours()) return;
  try {
    const pending = await store.getPendingEscalations(ESCALATION_THRESHOLD_MIN);
    for (const lead of pending) {
      try {
        await notifyEscalation({
          refId: lead.leadId,
          branchId: lead.branchId,
          staffName: lead.staffName,
          customerName: lead.customerName,
          modelOrIssue: lead.modelOrIssue,
          phone: lead.phone,
          platform: lead.platform,
          label: "เซลตอบ lead ช้า",
        });
        await store.markLeadEscalated(lead.leadId);
      } catch (err) {
        console.error("[escalation] error handling lead " + lead.leadId + ":", err.message);
      }
    }
  } catch (err) {
    console.error("[escalation] checkEscalations error:", err.message);
  }
}

// เหมือน checkEscalations แต่ตรวจแท็บ Bookings (นัดซ่อม/ทีมอะไหล่) แทน
async function checkBookingEscalations() {
  if (!isBusinessHours()) return;
  try {
    const pending = await store.getPendingBookingEscalations(ESCALATION_THRESHOLD_MIN);
    for (const booking of pending) {
      try {
        await notifyEscalation({
          refId: booking.bookingId,
          branchId: booking.branchId,
          staffName: booking.staffName,
          customerName: booking.customerName,
          modelOrIssue: booking.issue,
          phone: booking.phone,
          platform: booking.platform,
          label: "ทีมอะไหล่ตอบนัดซ่อมช้า",
        });
        await store.markBookingEscalated(booking.bookingId);
      } catch (err) {
        console.error("[escalation] error handling booking " + booking.bookingId + ":", err.message);
      }
    }
  } catch (err) {
    console.error("[escalation] checkBookingEscalations error:", err.message);
  }
}

setInterval(checkEscalations, ESCALATION_CHECK_INTERVAL_MS);
setInterval(checkBookingEscalations, ESCALATION_CHECK_INTERVAL_MS);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Taveesub chatbot server listening on port ${PORT}`);
  console.log(`Facebook webhook: /webhook/facebook`);
  console.log(`LINE webhook: /webhook/line`);
  console.log(`Escalation check (lead + booking) ทุก ${ESCALATION_CHECK_INTERVAL_MS / 60000} นาที (threshold ${ESCALATION_THRESHOLD_MIN} นาที, เฉพาะในเวลาทำการ)`);
});
