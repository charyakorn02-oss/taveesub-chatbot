// เรียก Claude API เพื่อวิเคราะห์ข้อความลูกค้า + ดึงข้อมูล + ตัดสินใจ
// ปรับให้ประหยัด token/ค่าใช้จ่ายให้มากที่สุด: ใช้โมเดล Haiku (เร็ว+ถูก), เปิด prompt caching สำหรับ system prompt
// (ก้อนใหญ่ที่ไม่ค่อยเปลี่ยน เช่น FAQ/สาขา/รุ่นรถ), และจำกัดความยาวประวัติแชทที่ส่งไปแต่ละรอบไม่ให้บวมไม่มีที่สิ้นสุด
"use strict";

const axios = require("axios");
const { buildSystemPrompt } = require("../config/systemPrompt");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_ATTEMPTS = 3; // เผื่อ network สะดุดตอน server เพิ่งตื่นจาก cold start (free tier ของ Render)

// Haiku ถูกและเร็วกว่า Sonnet มาก งานนี้แค่จัดหมวด/ดึงข้อมูล/ตอบ JSON สั้นๆ ไม่จำเป็นต้องใช้ Sonnet
// ตั้งค่า CLAUDE_MODEL ใน env ได้ถ้าอยากเปลี่ยนกลับไปใช้รุ่นอื่นภายหลัง
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// จำกัดประวัติแชทที่ส่งไปให้ Claude แต่ละรอบ (นับเป็นจำนวนข้อความ ไม่ใช่จำนวนเทิร์น) กันไม่ให้ input token
// โตขึ้นเรื่อยๆ ตามความยาวการสนทนา ข้อมูลสำคัญ (collected fields) ถูกเก็บแยกไว้ใน session.collected อยู่แล้ว
// ไม่ได้ผูกกับ history ตรงนี้ ตัดประวัติเก่าทิ้งจึงไม่กระทบความแม่นยำของข้อมูลที่เก็บสะสมไว้
const MAX_HISTORY_MESSAGES = 12;

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
  const trimmedHistory = history.length > MAX_HISTORY_MESSAGES ? history.slice(-MAX_HISTORY_MESSAGES) : history;
  const messages = [
    ...trimmedHistory,
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
          model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
          max_tokens: 512, // JSON ตอบกลับสั้นๆ พอ ไม่จำเป็นต้องเผื่อ 1024 ลด output token ที่คิดเงินแพงกว่า input
          // เปิด prompt caching: system prompt (FAQ/สาขา/รุ่นรถ/กติกาทั้งหมด) เปลี่ยนไม่บ่อย แคชไว้ 5 นาที
          // ทำให้ข้อความถัดๆ ไปของลูกค้าคนเดียวกัน (หรือคนอื่นที่ทักเข้ามาใกล้ๆ กัน) ไม่ต้องจ่ายเต็มราคาซ้ำทุกครั้ง
          system: [
            {
              type: "text",
              text: system,
              cache_control: { type: "ephemeral" },
            },
          ],
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
      // เดิมแค่ parse JSON สำเร็จก็ return เลย ทำให้เคส Claude ตอบ JSON ถูกต้องแต่ลืมใส่ reply_text_to_customer
      // (หรือใส่มาเป็นสตริงว่าง) หลุดผ่านไปได้ แล้วไปโผล่เป็นข้อความ fallback กลางๆ ที่ router.js ที่ลูกค้าเห็นซ้ำๆ
      // แก้ให้เช็คว่ามี reply_text_to_customer เป็นข้อความจริงด้วย ไม่งั้นถือว่าล้มเหลว วนลอง attempt ถัดไป
      if (parsed && typeof parsed.reply_text_to_customer === "string" && parsed.reply_text_to_customer.trim()) {
        return parsed;
      }

      console.warn(
        `[claude] JSON parse ได้แต่ reply_text_to_customer ว่าง/หาย หรือ parse ไม่สำเร็จ (ครั้งที่ ${attempt}/${MAX_ATTEMPTS}):`,
        raw
      );
    } catch (err) {
      console.error(`[claude] เรียก API ไม่สำเร็จ (ครั้งที่ ${attempt}/${MAX_ATTEMPTS}):`, err.message);
    }
  }

  console.error("[claude] ไม่ได้คำตอบที่ใช้ได้หลังลองครบ", MAX_ATTEMPTS, "ครั้ง raw text ล่าสุด:", lastRawText);
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
  // เผื่อ Claude ตอบมามีข้อความอื่นแนบมาก่อน/หลัง JSON (เช่น พูดนำก่อนแล้วค่อยตามด้วย ```json { ... } ```)
  // ทั้งที่ system prompt สั่งให้ตอบ JSON ล้วนๆ แล้ว แต่บางครั้ง Claude ก็ยังแถมข้อความมาด้วยอยู่ดี
  // ตัด code fence แบบ ```json ... ``` หรือ ``` ... ``` ออกก่อนเสมอ ก่อนพยายาม parse ตรงๆ
  const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, "$1").trim();

  try {
    return JSON.parse(stripped);
  } catch (err) {
    // เผื่อยังมีข้อความอื่นปนอยู่นอก code fence ด้วย (ไม่ได้ใช้ code fence เลย) ลองดึงเฉพาะส่วนที่เป็น { ... } ออกมา
    // ใช้ตัวสุดท้ายของ "}" ที่แมตช์กับ "{" ตัวแรกแบบ non-greedy เพื่อกันเคสมี "{" ปนอยู่ในข้อความพูดคุยก่อนหน้า JSON จริง
    const match = stripped.match(/\{[\s\S]*\}/);
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
