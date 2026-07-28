// เก็บสถานะบทสนทนาของลูกค้าแต่ละคน (collected/history/flags ต่างๆ) — เก็บใน memory (Map) เป็น fast path หลัก
// แต่ก็อปสำรองไว้ใน Google Sheets ด้วย (แท็บ Sessions) เผื่อเซิร์ฟเวอร์รีสตาร์ทกลางคัน (เช่น deploy โค้ดใหม่ หรือแพลนฟรีของ Render
// พักเครื่องอัตโนมัติตอนไม่มีคนใช้ 15 นาที) เดิมเก็บแค่ใน memory เฉยๆ พอรีสตาร์ทปุ๊บ session หายหมดทันที ทำให้บอทลืมบทสนทนาที่คุยค้างอยู่
// กลางคัน ถามซ้ำคำถามพื้นฐานที่เพิ่งถามไปแล้ว (เช่น "สนใจเรื่องไหนคะ") ทั้งที่ลูกค้าคุยไปไกลแล้ว
"use strict";

const store = require("../services/store");

const sessions = new Map();

function keyFor(platform, userId) {
  return `${platform}:${userId}`;
}

function defaultSession() {
  return { history: [], collected: {}, fallbackCount: 0, handedOff: false };
}

// ตัด history ให้เหลือแค่ท้ายสุด 20 ข้อความก่อนเซฟลง Sheets (พอสำหรับให้ Claude มี context ต่อเนื่อง) กัน cell ยาวเกินไป
function trimHistoryForPersist(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-20);
}

async function getSession(platform, userId) {
  const key = keyFor(platform, userId);
  if (sessions.has(key)) return sessions.get(key);

  // ไม่มีใน memory (อาจเพิ่งรีสตาร์ทเซิร์ฟเวอร์ไป หรือเป็นลูกค้าใหม่จริงๆ) -> ลองโหลดจาก Sheets ก่อนสร้างใหม่
  let session = null;
  try {
    const saved = await store.getSessionData(key);
    if (saved) session = saved;
  } catch (err) {
    console.error("[sessionStore] โหลด session จาก Sheets ไม่สำเร็จ:", err.message);
  }
  if (!session) session = defaultSession();

  sessions.set(key, session);
  return session;
}

function saveSession(platform, userId, session) {
  const key = keyFor(platform, userId);
  sessions.set(key, session);

  // เซฟลง Sheets แบบ fire-and-forget (ไม่รอผลลัพธ์ กันหน่วงเวลาก่อนตอบลูกค้า) เพื่อให้บทสนทนารอดจากการรีสตาร์ทเซิร์ฟเวอร์
  const toPersist = { ...session, history: trimHistoryForPersist(session.history) };
  store.saveSessionData(key, toPersist).catch((err) => {
    console.error("[sessionStore] เซฟ session ลง Sheets ไม่สำเร็จ:", err.message);
  });
}

function resetSession(platform, userId) {
  const key = keyFor(platform, userId);
  sessions.delete(key);
  store.deleteSessionData(key).catch((err) => {
    console.error("[sessionStore] ลบ session ใน Sheets ไม่สำเร็จ:", err.message);
  });
}

module.exports = { getSession, saveSession, resetSession };
