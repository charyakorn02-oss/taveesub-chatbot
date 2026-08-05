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

const ANALYSIS_TOOL = {
  name: "submit_customer_analysis",
  description:
    "ส่งผลวิเคราะห์ข้อความล่าสุดของลูกค้า พร้อมข้อความที่จะตอบกลับ ต้องเรียกเครื่องมือนี้ทุกครั้งเพื่อสรุปสถานะบทสนทนาเป็นข้อมูลที่ระบบไปใช้ต่อ",
  input_schema: {
    type: "object",
    properties: {
      reply_text_to_customer: {
        type: "string",
        description: "ข้อความที่จะตอบกลับลูกค้า เป็นภาษาไทยธรรมชาติ ไม่มี markdown",
      },
      intent_category: {
        type: ["string", "null"],
        enum: ["buying_new", "trade_in", "service", "general", null],
      },
      customer_name: { type: ["string", "null"] },
      model_or_issue: { type: ["string", "null"] },
      delivery_preference: {
        type: ["string", "null"],
        enum: ["pickup_at_branch", "home_delivery", null],
      },
      location_text: { type: ["string", "null"] },
      requested_staff_name: { type: ["string", "null"] },
      preferred_date: { type: ["string", "null"] },
      phone: { type: ["string", "null"] },
      high_intent_keyword: { type: "boolean" },
      in_scope: { type: "boolean" },
      has_confident_answer: { type: "boolean" },
      data_complete: { type: "boolean" },
      fallback: { type: "boolean" },
    },
    required: [
      "reply_text_to_customer",
      "intent_category",
      "in_scope",
      "has_confident_answer",
      "data_complete",
    ],
  },
};


// จำกัดประวัติแชทที่ส่งไปให้ Claude แต่ละรอบ (นับเป็นจำนวนข้อความ ไม่ใช่จำนวนเทิร์น) กันไม่ให้ input token
// โตขึ้นเรื่อยๆ ตามความยาวการสนทนา ข้อมูลสำคัญ (collected fields) ถูกเก็บแยกไว้ใน session.collected อยู่แล้ว
// ไม่ได้ผูกกับ history ตรงนี้ ตัดประวัติเก่าทิ้งจึงไม่กระทบความแม่นยำของข้อมูลที่เก็บสะสมไว้
const MAX_HISTORY_MESSAGES = 12;

/**
 * @param {Array<{role: "user"|"assistant", content: string}>} history ประวัติแชท (ไม่รวมข้อความล่าสุด)
 * @param {string} latestMessage ข้อความล่าสุดจากลูกค้า
 * @param {number} fallbackCount จำนวนครั้งที่บอทงงมาก่อนหน้า (ส่งไปให้ Claude รับรู้บริบท)
 * @param {object} collected ข้อมูลที่เก็บสะสมไว้แล้วใน session (เช่น ชื่อ/เบอร์/สาขา/รุ่นรถ) กันลืมตอน history ถูกตัดทิ้งไปเพราะยาวเกิน
 * @param {{base64: string, mediaType: string}|null} imagePart รูปภาพที่ลูกค้าแนบมา (ถ้ามี) - ส่งให้ Claude ดูภาพประกอบการตอบ (vision)
 * @returns {Promise<object>} JSON ที่ Claude ตอบกลับมา (parse แล้ว)
 */
async function analyzeMessage(history, latestMessage, fallbackCount = 0, collected = null, imagePart = null) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน .env");
  }

  const system = await buildSystemPrompt();
  const trimmedHistory = history.length > MAX_HISTORY_MESSAGES ? history.slice(-MAX_HISTORY_MESSAGES) : history;

  // สรุปข้อมูลที่เก็บไว้แล้วใน session ให้ Claude เห็นชัดๆ ทุกรอบ ไม่ต้องพึ่งแค่ history (ที่ถูกตัดทิ้งได้ถ้าคุยยาว)
  // กันบั๊ก "บอทลืม" ที่แท้จริงคือ Claude ไม่เห็นว่ามีข้อมูลนี้เก็บไว้แล้ว เลยถามซ้ำ/สับสนว่าคุยถึงไหนแล้ว
  const knownFacts = [];
  if (collected) {
    if (collected.customer_name) knownFacts.push(`ชื่อลูกค้า: ${collected.customer_name}`);
    if (collected.phone) knownFacts.push(`เบอร์โทร: ${collected.phone}`);
    if (collected.intent_category) knownFacts.push(`เรื่องที่คุย: ${collected.intent_category}`);
    if (collected.location_text) knownFacts.push(`พื้นที่/ที่อยู่ที่แจ้งไว้: ${collected.location_text}`);
    if (collected.model_or_issue) knownFacts.push(`รุ่นรถ/อาการที่สนใจ: ${collected.model_or_issue}`);
    if (collected.delivery_preference) knownFacts.push(`วิธีรับรถ: ${collected.delivery_preference}`);
    if (collected.requested_staff_name) knownFacts.push(`ชื่อพนักงานที่ลูกค้าระบุ: ${collected.requested_staff_name}`);
    if (collected.preferred_date) knownFacts.push(`วันที่นัดหมาย: ${collected.preferred_date}`);
  }
  const knownFactsNote =
    knownFacts.length > 0
      ? `[ข้อมูลที่เก็บไว้แล้วจากการคุยก่อนหน้า อย่าถามซ้ำเรื่องที่มีอยู่แล้วในนี้:\n${knownFacts.join("\n")}]\n\n`
      : "";

  const textContent =
    knownFactsNote +
    (fallbackCount > 0
      ? `[หมายเหตุ: บอทตอบไม่เข้าใจมาแล้ว ${fallbackCount} ครั้ง ถ้ายังไม่เข้าใจอีก ให้ตั้ง fallback = true]\n${latestMessage}`
      : latestMessage);

  // ถ้ามีรูปภาพแนบมาด้วย (ลูกค้าส่งรูปผ่าน LINE) ต้องส่ง content เป็น array ผสมรูป+ข้อความ (Claude vision รูปแบบ multimodal)
  // แทนที่จะเป็น string ธรรมดา ถึงจะให้ Claude "เห็น" ภาพจริงๆ ได้ ไม่ใช่แค่อ่านคำบรรยาย
  const userContent = imagePart
    ? [
        { type: "image", source: { type: "base64", media_type: imagePart.mediaType, data: imagePart.base64 } },
        { type: "text", text: textContent },
      ]
    : textContent;

  // ตามที่ผู้ใช้ระบบขอ: อยาก "อ่านประวัติแชทเก่า" แบบประหยัดเครดิต ไม่ต้องจ่ายเต็มราคาซ้ำทุกข้อความในเซสชันเดียวกัน
  // Anthropic เปิดให้แคช (prompt caching) ได้จริง แต่ระยะเวลาที่เลือกได้มีแค่ 2 แบบคือ 5 นาที (ปกติ) กับ 1 ชั่วโมง (extended, ต้องเปิด beta header)
  // ไม่มีตัวเลือก "30 นาทีพอดี" ให้เลือกตรงๆ เลือกใช้ 1 ชั่วโมงเพราะใกล้เคียงและครอบคลุมพอสำหรับความยาวเซสชันคุยทั่วไป
  // -> ถ้าลูกค้าคุยต่อเนื่องภายใน 1 ชม. ประวัติแชทเดิม (ที่เคยส่งไปแล้ว) จะถูกคิดราคาถูกลงมาก (แคช hit) แทนที่จะจ่ายเต็มราคาซ้ำทุกรอบ
  // ถ้าห่างเกิน 1 ชม. แคชจะหมดอายุเอง รอบถัดไปจะ "อ่านใหม่" (เขียนแคชใหม่) ตามธรรมชาติ ไม่ต้องเขียนโค้ดจับเวลาเองเพิ่ม
  // สำคัญ: นี่คือการลดต้นทุน ไม่ใช่การลดข้อมูลที่ Claude เห็น -> Claude ยังเห็นประวัติแชทครบเหมือนเดิมทุกประการทุกครั้ง แค่ราคาที่ AWS/Anthropic คิดถูกลง
  const messages = [...trimmedHistory];
  if (messages.length > 0) {
    const lastIdx = messages.length - 1;
    const lastMsg = messages[lastIdx];
    const lastContent =
      typeof lastMsg.content === "string" ? [{ type: "text", text: lastMsg.content }] : lastMsg.content;
    const markedContent = lastContent.map((block, i) =>
      i === lastContent.length - 1 ? { ...block, cache_control: { type: "ephemeral", ttl: "1h" } } : block
    );
    messages[lastIdx] = { ...lastMsg, content: markedContent };
  }
  messages.push({
    role: "user",
    content: userContent,
  });

  let lastRawText = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.post(
        ANTHROPIC_API_URL,
        {
          model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
          // เพิ่มจาก 512 เป็น 1024: บั๊กที่เจอจริง - ตอนต้องตอบยาว (เช่น รายชื่อสาขาหลายบรรทัด + ชื่อสถานที่เต็มๆ)
          // โดน max_tokens ตัดกลางคำ/กลางประโยคพอดี (เช่น "แฟชั่นไอ" ที่ควรเป็น "แฟชั่นไอส์แลนด์") ทำให้ข้อความไม่ครบและอาจทำ JSON ไม่สมบูรณ์ไปด้วย
          max_tokens: 1024,
          // เปิด prompt caching: system prompt (FAQ/สาขา/รุ่นรถ/กติกาทั้งหมด) เปลี่ยนไม่บ่อย แคชไว้ 5 นาที
          // ทำให้ข้อความถัดๆ ไปของลูกค้าคนเดียวกัน (หรือคนอื่นที่ทักเข้ามาใกล้ๆ กัน) ไม่ต้องจ่ายเต็มราคาซ้ำทุกครั้ง
          system: [
            {
              type: "text",
              text: system,
              // ขยายจาก 5 นาทีเป็น 1 ชั่วโมง (ttl: "1h") เหมือนกับจุดแคชประวัติแชทด้านบน ให้สอดคล้องกันเป็นเซสชันเดียว
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
          tools: [ANALYSIS_TOOL],
          tool_choice: { type: "tool", name: "submit_customer_analysis" },
          messages,
        },
        {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            // ต้องเปิด beta header นี้ถึงจะใช้ cache_control ttl "1h" ได้ (ปกติ ephemeral cache แค่ 5 นาทีเฉยๆ)
            "anthropic-beta": "extended-cache-ttl-2025-04-11",
          },
          timeout: 20000,
        }
      );

      const toolBlock = res.data.content.find(
        (c) => c.type === "tool_use" && c.name === "submit_customer_analysis"
      );
      if (
        toolBlock &&
        toolBlock.input &&
        typeof toolBlock.input.reply_text_to_customer === "string" &&
        toolBlock.input.reply_text_to_customer.trim()
      ) {
        return toolBlock.input;
      }

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

// Claude บางครั้งตอบ reply_text_to_customer เป็นข้อความหลายย่อหน้าโดยใช้ตัวขึ้นบรรทัดใหม่จริง แทนที่จะ escape ตามที่ JSON ต้องการ
// ทำให้ JSON.parse พังทุกครั้ง (บั๊กที่เจอจริง: ลูกค้าถามหลายเรื่องในข้อความเดียว Claude ตอบยาวหลายย่อหน้า)
// ฟังก์ชันนี้แปลง newline/carriage-return ที่อยู่ "ภายในสตริง" JSON ให้เป็น escape sequence ที่ถูกต้อง
function sanitizeJsonNewlines(text) {
  let result = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      result += ch;
      escape = false;
      continue;
    }
    if (ch === String.fromCharCode(92)) {
      result += ch;
      escape = true;
      continue;
    }
    if (ch === String.fromCharCode(34)) {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && (ch === "\n" || ch === "\r")) {
      result += ch === "\n" ? "\\n" : "\\r";
      continue;
    }
    result += ch;
  }
  return result;
}
function tryParseJson(raw) {
  // เผื่อ Claude ตอบมามีข้อความอื่นแนบมาก่อน/หลัง JSON (เช่น พูดนำก่อนแล้วค่อยตามด้วย ```json { ... } ```)
  // ทั้งที่ system prompt สั่งให้ตอบ JSON ล้วนๆ แล้ว แต่บางครั้ง Claude ก็ยังแถมข้อความมาด้วยอยู่ดี
  // ตัด code fence แบบ ```json ... ``` หรือ ``` ... ``` ออกก่อนเสมอ ก่อนพยายาม parse ตรงๆ
  const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, "$1").trim();

  try {
    return JSON.parse(sanitizeJsonNewlines(stripped));
  } catch (err) {
    // เผื่อยังมีข้อความอื่นปนอยู่นอก code fence ด้วย (ไม่ได้ใช้ code fence เลย) ลองดึงเฉพาะส่วนที่เป็น { ... } ออกมา
    // ใช้ตัวสุดท้ายของ "}" ที่แมตช์กับ "{" ตัวแรกแบบ non-greedy เพื่อกันเคสมี "{" ปนอยู่ในข้อความพูดคุยก่อนหน้า JSON จริง
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(sanitizeJsonNewlines(match[0]));
      } catch (err2) {
        return null;
      }
    }
    // กันเหนียวชั้นสุดท้าย: บั๊กที่เจอจริง - บางครั้ง Claude เผลอตอบเป็นข้อความธรรมดาล้วนๆ ไม่มี { } เลยสักตัว
    // (ทั้งที่ system prompt สั่งให้ตอบ JSON เสมอ เช่น ตอนพิมพ์รายชื่อสาขาหลายบรรทัดแล้วลืมห่อ JSON) เดิมเคสนี้ parse
    // ไม่ผ่านทั้ง 3 รอบ ลูกค้าเห็นข้อความ fallback ซ้ำๆ ทั้งที่จริงๆ Claude ตอบคำถามมาถูกต้องแล้ว แค่ลืมห่อ JSON เฉยๆ
    // ถ้าข้อความดิบดูเป็นคำตอบภาษาไทยจริงๆ (ไม่ใช่ error/ว่างเปล่า) ให้ห่อเป็น JSON ให้เองแทนที่จะทิ้งคำตอบไปเฉยๆ
    if (stripped && stripped.length > 0 && !stripped.includes("{")) {
      return {
        reply_text_to_customer: stripped,
        intent_category: null,
        customer_name: null,
        model_or_issue: null,
        delivery_preference: null,
        location_text: null,
        requested_staff_name: null,
        preferred_date: null,
        phone: null,
        high_intent_keyword: false,
        in_scope: true,
        has_confident_answer: true,
        data_complete: false,
        fallback: false,
      };
    }
    return null;
  }
}

module.exports = { analyzeMessage };
