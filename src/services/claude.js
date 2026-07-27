// เรียก Claude API เพื่อวิเคราะห์ข้อความลูกค้า + ดึงข้อมูล + ตัดสินใจ
"use strict";

const axios = require("axios");
const { buildSystemPrompt } = require("../config/systemPrompt");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_ATTEMPTS = 3; // เผื่อ network สะดุดตอน server เพิ่งตื่นจาก cold start (free tier ของ Render)

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

  const system = await buildSystemPrompt();
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

  let lastRawText = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
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
      lastRawText = raw;

      const parsed = tryParseJson(raw);
      if (parsed) return parsed;

      console.warn(`[claude] parse JSON ไม่สำเร็จ (ครั้งที่ ${attempt}/${MAX_ATTEMPTS}):`, raw);
    } catch (err) {
      console.error(`[claude] เรียก API ไม่สำเร็จ (ครั้งที่ ${attempt}/${MAX_ATTEMPTS}):`, err.message);
    }
  }

  console.error("[claude] parse JSON ไม่สำเร็จหลังลองครบ", MAX_ATTEMPTS, "ครั้ง raw text ล่าสุด:", lastRawText);
  // ข้อความนี้ต้องไม่พูดเกินจริงว่า "ทีมงานจะติดต่อกลับ" เพราะรอบนี้ยังไม่มีการสร้าง lead หรือแจ้งเตือนพนักงานคนไหนเลย
  // (data_complete: false ทำให้ router.js ไม่ handoff ในรอบนี้ แค่รอลูกค้าพิมพ์อีกครั้ง)
  return {
    reply_text_to_customer: "ขอโทษด้วยนะคะ แอดมินอ่านข้อความไม่ครบถ้วนชั่วคราว รบกวนพิมพ์อีกครั้งได้ไหมคะ 🙏",
    intent_category: null,
    fallback: true,
    data_complete: false,
    in_scope: true,
    has_confident_answer: false,
  };
}

function tryParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    // เผื่อ Claude ตอบมามีข้อความอื่นแนบมาด้วย ลองดึงเฉพาะส่วนที่เป็น { ... } ออกมา
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (err2) {
        return null;
      }
    }
    return null;
  }
}

module.exports = { analyzeMessage };
