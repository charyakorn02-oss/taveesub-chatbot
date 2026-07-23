// เก็บสถานะการคุยของลูกค้าแต่ละคนไว้ใน memory (เหมาะกับเริ่มต้น/เดโม)
// ⚠️ Production จริง: ถ้า deploy หลาย instance หรืออยากให้ข้อมูลไม่หายตอน restart
// ให้เปลี่ยนไปใช้ Redis หรือฐานข้อมูลแทน Map นี้ (โครงสร้างฟังก์ชันด้านล่างออกแบบให้สลับ backend ได้ง่าย)
"use strict";

const sessions = new Map();

function keyFor(platform, userId) {
  return `${platform}:${userId}`;
}

function getSession(platform, userId) {
  const key = keyFor(platform, userId);
  if (!sessions.has(key)) {
    sessions.set(key, {
      history: [], // [{role, content}]
      collected: {}, // ฟิลด์ที่เก็บสะสมจากการคุย
      fallbackCount: 0,
      handedOff: false,
    });
  }
  return sessions.get(key);
}

function saveSession(platform, userId, session) {
  sessions.set(keyFor(platform, userId), session);
}

function resetSession(platform, userId) {
  sessions.delete(keyFor(platform, userId));
}

module.exports = { getSession, saveSession, resetSession };
