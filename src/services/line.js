// ฟังก์ชันเรียก LINE Messaging API — ตอบลูกค้า (Reply) และแจ้งกลุ่มสาขา (Push)
"use strict";

const axios = require("axios");
const crypto = require("crypto");

const LINE_API = "https://api.line.me/v2/bot/message";

function channelToken() {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN ใน .env");
  return token;
}

function headers() {
  return {
    Authorization: `Bearer ${channelToken()}`,
    "Content-Type": "application/json",
  };
}

// ตอบกลับลูกค้าโดยตรง (ใช้ replyToken ที่ได้จาก webhook event — ใช้ได้ครั้งเดียว)
async function replyMessage(replyToken, text) {
  return axios.post(
    `${LINE_API}/reply`,
    { replyToken, messages: [{ type: "text", text }] },
    { headers: headers() }
  );
}

// ยิงข้อความเข้ากลุ่ม LINE ของสาขา (ต้องมี Group ID ที่แอดมินเพิ่มบอทเข้ากลุ่มไว้ก่อน)
async function pushMessage(toGroupId, text) {
  return axios.post(
    `${LINE_API}/push`,
    { to: toGroupId, messages: [{ type: "text", text }] },
    { headers: headers() }
  );
}

// ตรวจลายเซ็นของ Webhook จาก LINE เพื่อความปลอดภัย (ป้องกันคนอื่นปลอมยิง request เข้ามา)
function verifySignature(rawBody, signature) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return true; // ถ้ายังไม่ตั้งค่า secret จะข้ามการเช็ค (ใช้ตอน dev เท่านั้น — ห้ามขึ้น production แบบนี้)
  const hash = crypto.createHmac("SHA256", secret).update(rawBody).digest("base64");
  return hash === signature;
}

module.exports = { replyMessage, pushMessage, verifySignature };
