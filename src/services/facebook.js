// ฟังก์ชันเรียก Facebook Graph API — ตอบคอมเมนต์, ส่ง Private Reply, ส่งข้อความ Messenger
"use strict";

const axios = require("axios");

const GRAPH_API = "https://graph.facebook.com/v19.0";

function pageToken() {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("ยังไม่ได้ตั้งค่า FB_PAGE_ACCESS_TOKEN ใน .env");
  return token;
}

// ตอบคอมเมนต์แบบสั้นๆ ใต้โพสต์
async function replyToComment(commentId, message) {
  return axios.post(`${GRAPH_API}/${commentId}/comments`, {
    message,
    access_token: pageToken(),
  });
}

// ส่ง Private Reply เข้า Inbox จากคอมเมนต์ (ตาม Facebook Private Replies)
async function privateReplyToComment(commentId, message) {
  return axios.post(`${GRAPH_API}/me/messages`, {
    recipient: { comment_id: commentId },
    message: { text: message },
    access_token: pageToken(),
  });
}

// ส่งข้อความใน Messenger ปกติ
async function sendMessage(recipientPsid, message) {
  return axios.post(`${GRAPH_API}/me/messages`, {
    recipient: { id: recipientPsid },
    message: { text: message },
    messaging_type: "RESPONSE",
    access_token: pageToken(),
  });
}

module.exports = { replyToComment, privateReplyToComment, sendMessage };
