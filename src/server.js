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
// เดิมแจ้งแค่หัวหน้าสาขาอย่างเดียว -> แก้ให้แจ้งทั้งเซล/ทีมอะไหล่คนเดิม (เตือนซ้ำ) และหัวหน้าสาขาไปพร้อมกัน
// ทั้งคู่ได้ปุ่ม "รับทราบแล้ว" ผูกกับ lead/booking เดียวกัน ใครกดก่อนก็บันทึกเป็นอันนั้น ไม่ปนกับ lead อื่น
const ESCALATION_THRESHOLD_MIN = 30;
const ESCALATION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

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
    "Ref ID: " + refId;

  // เตือนซ้ำไปหาคนเดิมที่รับผิดชอบก่อน (ถ้ามีไลน์) เผื่อแค่พลาดไม่เห็นข้อความตอนแรก
  const staff = staffName ? (await store.getActiveStaff()).find((s) => s.name === staffName && s.branchId === branchId) : null;
  if (staff && staff.lineUserId) {
    try {
      await line.pushMessageWithAck(staff.lineUserId, text, refId);
    } catch (err) {
      console.error("[escalation] re-notify staff error:", err.message);
    }
  }

  // และแจ้งหัวหน้าสาขาเสมอ ให้ช่วยตามงานต่อ (พร้อมปุ่มรับทราบผูกกับ ref เดียวกัน)
  if (supervisor && supervisor.lineUserId) {
    try {
      await line.pushMessageWithAck(supervisor.lineUserId, text, refId);
    } catch (err) {
      console.error("[escalation] notify supervisor error:", err.message);
    }
  } else {
    console.warn("[escalation] สาขา " + branchId + " ยังไม่ได้ลงทะเบียนหัวหน้าสาขา (role=supervisor) ข้ามการแจ้งเตือน");
  }
}

async function checkEscalations() {
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

// เหมือน checkEscalations แต่ตรวจแท็บ Bookings (นัดซ่อม/ทีมอะไหล่) แทน — เดิมนัดซ่อมไม่มีการ escalate เลย
async function checkBookingEscalations() {
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
  console.log(`Escalation check (lead + booking) ทุก ${ESCALATION_CHECK_INTERVAL_MS / 60000} นาที (threshold ${ESCALATION_THRESHOLD_MIN} นาที)`);
});
