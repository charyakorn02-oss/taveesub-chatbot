"use strict";

require("dotenv").config();

const express = require("express");
const facebookWebhook = require("./webhooks/facebookWebhook");
const lineWebhook = require("./webhooks/lineWebhook");

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Taveesub chatbot server listening on port ${PORT}`);
  console.log(`Facebook webhook: /webhook/facebook`);
  console.log(`LINE webhook: /webhook/line`);
});
