// เรียก Claude API เพื่อวิเคราะห์ข้อความลูกค้า + ดึงข้อมูล + ตัดสินใจ
"use strict";

const axios = require("axios");
const { buildSystemPrompt } = require("../config/systemPrompt");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

/**
 * @param {Array<{role: "user"|"assistant", content: string}>} history ประวัติแชท (ไม่รวมข้อความล่าสุด)
 * @param {string} latestMessage ข้อความล่าสุดจากลูกค้า
 * @param {number} fallbackCount จำนวนครั้งที่บอทงงมาก่อนหน้า (ส่งไปให้ Claude รับรู้บริบท)
 * @returns {Promise<object>} JSON ที่ Claude ตอบกลับมา (parse แล้ว)
 */
async function analyzeMessage(history, latestMessage, fallbackCount = 0) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน .env");
  }

  const system = buildSystemPrompt();
  const messages = [
    ...history,
    {
      role: "user",
      content:
        fallbackCount > 0
          ? `[หมายเหตุ: บอทตอบไม่เข้าใจมาแล้ว ${fallbackCount} ครั้ง ถ้ายังไม่เข้าใจอีก ให้ตั้ง fallback = true]\n${latestMessage}`
          : latestMessage,
    },
  ];

  const res = await axios.post(
    ANTHROPIC_API_URL,
    {
      model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
      max_tokens: 1024,
      system,
      messages,
    },
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      timeout: 20000,
    }
  );

  const textBlock = res.data.content.find((c) => c.type === "text");
  const raw = textBlock ? textBlock.text : "{}";
  return safeParseJson(raw);
}

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    // เผื่อ Claude ตอบมามีข้อความอื่นแนบมาด้วย ลองดึงเฉพาะส่วนที่เป็น { ... } ออกมา
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (err2) {
        console.error("[claude] parse JSON ไม่สำเร็จ:", err2.message, raw);
      }
    }
    return {
      reply_text_to_customer: "ขอโทษครับ ขอเวลาสักครู่นะครับ เดี๋ยวทีมงานจะติดต่อกลับไป",
      intent_category: null,
      fallback: true,
      data_complete: false,
      in_scope: true,
      has_confident_answer: false,
    };
  }
}

module.exports = { analyzeMessage };
