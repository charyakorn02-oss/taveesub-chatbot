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
  res.send("Taveesub Yanyont chatbot server กำลังทำงานอยู่ครับ ✅");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.use("/webhook", facebookWebhook);
app.use("/webhook", lineWebhook);

// ตรวจทุกกี่นาทีว่า lead ไหนเซลยังไม่รับทราบเกินเวลาที่กำหนด แล้วแจ้งเตือนหัวหน้าสาขา
// หัวหน้าสาขาตอนนี้อยู่ในแท็บ Staff (role=supervisor) แล้ว ไม่ได้อยู่ที่ Branches.supervisorLineUserId อีกต่อไป
const ESCALATION_THRESHOLD_MIN = 30;
const ESCALATION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

async function checkEscalations() {
  try {
    const pending = await store.getPendingEscalations(ESCALATION_THRESHOLD_MIN);
    for (const lead of pending) {
      try {
        const branch = await store.getBranchById(lead.branchId);
        const supervisor = await store.getSupervisorForBranch(lead.branchId);
        if (supervisor && supervisor.lineUserId) {
          const text =
            "⏰ แจ้งเตือน: เซลตอบ lead ช้าเกิน " + ESCALATION_THRESHOLD_MIN + " นาที\n" +
            "สาขา: " + (branch ? branch.name : lead.branchId) + "\n" +
            "เซลที่รับผิดชอบ: " + (lead.staffName || "-") + "\n" +
            "ลูกค้า (" + (lead.platform || "-") + "): " + (lead.customerName || "-") + "\n" +
            "รุ่นที่สนใจ/อาการ: " + (lead.modelOrIssue || "-") + "\n" +
            "เบอร์ลูกค้า: " + (lead.phone || "-") + "\n" +
            "Lead ID: " + lead.leadId;
          await line.pushMessage(supervisor.lineUserId, text);
        } else {
          console.warn("[escalation] สาขา " + lead.branchId + " ยังไม่ได้ลงทะเบียนหัวหน้าสาขา (role=supervisor) ข้ามการแจ้งเตือน");
        }
        await store.markLeadEscalated(lead.leadId);
      } catch (err) {
        console.error("[escalation] error handling lead " + lead.leadId + ":", err.message);
      }
    }
  } catch (err) {
    console.error("[escalation] checkEscalations error:", err.message);
  }
}

setInterval(checkEscalations, ESCALATION_CHECK_INTERVAL_MS);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Taveesub chatbot server listening on port ${PORT}`);
  console.log(`Facebook webhook: /webhook/facebook`);
  console.log(`LINE webhook: /webhook/line`);
  console.log(`Escalation check ทุก ${ESCALATION_CHECK_INTERVAL_MS / 60000} นาที (threshold ${ESCALATION_THRESHOLD_MIN} นาที)`);
});
