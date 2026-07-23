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
    Authorization: "Bearer " + channelToken(),
    "Content-Type": "application/json",
  };
}

async function replyMessage(replyToken, text) {
  return axios.post(
    LINE_API + "/reply",
    { replyToken, messages: [{ type: "text", text }] },
    { headers: headers() }
  );
}

// ดึงชื่อ LINE display name ของลูกค้า (เก็บไว้ตอนสร้าง lead เพื่อรู้ว่าคนนี้ทักมาจาก LINE ชื่ออะไร)
async function getProfile(userId) {
  try {
    const res = await axios.get(LINE_API.replace("/message", "") + "/profile/" + userId, {
      headers: headers(),
    });
    return res.data && res.data.displayName ? res.data.displayName : "";
  } catch (err) {
    console.error("[line] getProfile error:", err.message);
    return "";
  }
}

async function pushMessage(to, text) {
  return axios.post(
    LINE_API + "/push",
    { to, messages: [{ type: "text", text }] },
    { headers: headers() }
  );
}

// ยิงข้อความหาเซล พร้อมปุ่ม Quick Reply "รับทราบแล้ว" ผูกกับ leadId
async function pushMessageWithAck(userId, text, leadId) {
  return axios.post(
    LINE_API + "/push",
    {
      to: userId,
      messages: [
        {
          type: "text",
          text,
          quickReply: {
            items: [
              {
                type: "action",
                action: {
                  type: "postback",
                  label: "รับทราบแล้ว",
                  data: "ack:" + leadId,
                  displayText: "รับทราบแล้ว",
                },
              },
            ],
          },
        },
      ],
    },
    { headers: headers() }
  );
}

function verifySignature(rawBody, signature) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return true;
  const hash = crypto.createHmac("SHA256", secret).update(rawBody).digest("base64");
  return hash === signature;
}

module.exports = { replyMessage, pushMessage, pushMessageWithAck, getProfile, verifySignature };
