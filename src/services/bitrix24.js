// ตัวเชื่อม Bitrix24 REST API แบบไม่บังคับ (optional) — ทำงานก็ต่อเมื่อตั้งค่า BITRIX24_WEBHOOK_URL ใน .env
// ถ้ายังไม่ตั้งค่า ฟังก์ชันเหล่านี้จะไม่ทำอะไร (no-op) ระบบจะใช้ local JSON (store.js) เป็นฐานข้อมูลหลักไปก่อน
"use strict";

const axios = require("axios");

function isConfigured() {
  return Boolean(process.env.BITRIX24_WEBHOOK_URL);
}

// สร้าง Lead ใน Bitrix24 SPA (ต้องตั้งค่า BITRIX24_LEADS_ENTITY_TYPE_ID ตาม entityTypeId ของ SPA "Leads" ที่คุณสร้างไว้)
async function createLead(fields) {
  if (!isConfigured()) return null;
  const entityTypeId = process.env.BITRIX24_LEADS_ENTITY_TYPE_ID;
  if (!entityTypeId) {
    console.warn("[bitrix24] ยังไม่ได้ตั้งค่า BITRIX24_LEADS_ENTITY_TYPE_ID — ข้ามการบันทึกลง Bitrix24");
    return null;
  }
  try {
    const url = `${process.env.BITRIX24_WEBHOOK_URL}/crm.item.add`;
    const res = await axios.post(url, {
      entityTypeId,
      fields,
    });
    return res.data;
  } catch (err) {
    console.error("[bitrix24] createLead error:", err.message);
    return null;
  }
}

module.exports = { isConfigured, createLead };
