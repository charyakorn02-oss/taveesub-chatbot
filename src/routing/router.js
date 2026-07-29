// หัวใจของระบบ: ตัดสินใจว่าถามต่อ หรือจะส่งต่อ (handoff) ให้เซล/ช่าง พร้อมหาสาขา+พนักงานที่เหมาะสม
"use strict";

const store = require("../services/store");
const { geocode, isServiceArea, haversineKm } = require("../services/geocode");
const line = require("../services/line");
const bitrix24 = require("../services/bitrix24");

const HIGH_INTENT_KEYWORDS = ["จอง", "มัดจำ", "โอนเงิน", "จัดไฟแนนซ์", "ส่งเอกสาร"];
const FALLBACK_LIMIT = 2;
const BRANCH_CHANGE_KEYWORDS = /เปลี่ยนสาขา|เปลี่ยนที่ซ่อม|ขอเปลี่ยนสาขา|สาขาอื่นแทน|เปลี่ยนเป็นสาขา|เปลี่ยนไปสาขา/;
// ลูกค้าแจ้งว่า Lead ก่อนหน้านี้ถูกส่งผิดแผนก (เช่น ต้องการอะไหล่/บริการ แต่ดันไปเข้าคิวเซลฝ่ายขาย) ใช้คู่กับ session.lastLead
const WRONG_DEPARTMENT_KEYWORDS = /ส่งผิดแผนก|ส่งผิดคน|ผิดแผนก|ไม่ใช่ฝ่ายขาย|ไม่ใช่เซล|ไม่ใช่แผนกขาย|ส่งผิด/;
// ลูกค้าตอบยืนยันว่าจะใช้ข้อมูลเดิม (สาขา/เบอร์) ที่เคยติดต่อร้านไว้ก่อนหน้านี้ต่อ ใช้คู่กับ session.pendingHistoryConfirm
const SAME_AS_BEFORE_KEYWORDS = /เหมือนเดิม|ที่เดิม|เบอร์เดิม|สาขาเดิม|อันเดิม|ข้อมูลเดิม|^ใช่ค่ะ$|^ใช่ครับ$|^ใช่$|^ยืนยัน|^ตกลง|^โอเค|^ok/i;

function containsHighIntentKeyword(text) {
  if (!text) return false;
  return HIGH_INTENT_KEYWORDS.some((k) => text.includes(k));
}

// เดาหมวดจากคำสำคัญในข้อความดิบของลูกค้า ใช้เป็น "ตาข่ายนิรภัย" ตอน handoff เท่านั้น
// (เช่น เจอ high_intent_keyword อย่าง "จอง" จนต้อง handoff ทันที แต่รอบนั้น Claude ดันจัดหมวด intent_category ไม่สำเร็จ/ส่งมาว่าง
// เพราะ JSON parse ผิดพลาดชั่วคราว หรือข้อความที่ batch รวมมาดูสับสน) กันไม่ให้เคสชัดเจนอย่าง "ซ่อม/อะไหล่" หลุดไปเป็น general เฉยๆ
function guessIntentFromText(text) {
  if (!text) return null;
  if (/ซ่อม|เช็คระยะ|อะไหล่|คิวซ่อม|นัดซ่อม|เข้าศูนย์/.test(text)) return "service";
  if (/เทิร์นรถ|เทิร์น|แลกรถ|ขายรถเก่า/.test(text)) return "trade_in";
  if (/ซื้อรถ|ออกรถ|จองรถ|ดาวน์รถ|สนใจรุ่น/.test(text)) return "buying_new";
  return null;
}

// ใช้คู่กับการป้องกันหมวด (intent_category) ที่เคยชัดเจนแล้วถูกเปลี่ยนง่ายๆ ใน handleTurn ด้านล่าง: อนุญาตให้เปลี่ยนหมวดได้จริง
// ก็ต่อเมื่อข้อความดิบของลูกค้ามีคำสำคัญที่ตรงกับหมวดใหม่ชัดเจนเท่านั้น กันบั๊กที่เจอจริง: ลูกค้าคุยเรื่องอะไหล่/บริการ (service) อยู่
// แล้วพิมพ์ข้อความสั้นๆ กำกวมต่อมา (เช่น "สนใจแพคเกจ ใช้ lead สนใจ size L") ทำให้ Claude เดาหมวดสลับไปเป็น buying_new ทั้งที่ยังคุยเรื่องอะไหล่อยู่
// จนส่ง lead ไปผิดแผนก (ส่งไปหาเซลฝ่ายขายทั้งที่ควรเป็นทีมอะไหล่)
function intentKeywordMatches(intent, text) {
  if (!text) return false;
  if (intent === "service") return /ซ่อม|เช็คระยะ|อะไหล่|คิวซ่อม|นัดซ่อม|เข้าศูนย์/.test(text);
  if (intent === "trade_in") return /เทิร์นรถ|เทิร์น|แลกรถ|ขายรถเก่า/.test(text);
  if (intent === "buying_new") return /ซื้อรถ|ออกรถ|จองรถ|ดาวน์รถ|สนใจรุ่น|คันใหม่|รถใหม่/.test(text);
  return true; // general หรือหมวดอื่นที่ไม่ได้กำหนดคำเฉพาะ ให้เปลี่ยนได้เสมอ
}

// ตัดคำว่า "สาขา" นำหน้า และวงเล็บต่อท้าย (เช่น "(นวมินทร์24)") ออกจากชื่อสาขาเพื่อเทียบกับข้อความลูกค้าแบบยืดหยุ่น
// กันบั๊กที่เจอจริง: ชื่อสาขาในชีตเก็บเป็น "สำนักงานใหญ่(นวมินทร์24)" แต่ลูกค้าพิมพ์มาแค่ "สำนักงานใหญ่" เฉยๆ ทำให้จับคู่ไม่เจอ
function normalizeBranchNameForMatch(name) {
  return (name || "")
    .replace(/^สาขา/, "")
    .replace(/\(.*?\)/g, "")
    .trim();
}

// เอาชื่อสาขาไปหาว่าลูกค้าตอบกลับมาตรงกับตัวเลือกไหน (ใช้ตอนก่อนหน้าเคยถามลูกค้าว่า "สะดวกสาขาไหน" ไปแล้ว)
// เทียบแบบสองทาง (ข้อความลูกค้ามีชื่อสาขาอยู่ในนั้น หรือชื่อสาขาเต็มมีข้อความสั้นๆ ที่ลูกค้าพิมพ์อยู่ในนั้น) กันเคสชื่อสาขามีวงเล็บ/คำต่อท้าย
function matchBranchFromText(text, options) {
  if (!text) return null;
  const trimmed = text.trim();
  return (
    options.find((o) => {
      const full = o.branchName || "";
      const core = normalizeBranchNameForMatch(full);
      return (
        text.includes(full) ||
        (core && text.includes(core)) ||
        (core && trimmed.length >= 3 && full.includes(trimmed))
      );
    }) || null
  );
}

// พอลูกค้าบอกที่อยู่มาปุ๊บ (เฉพาะซื้อรถใหม่ ยังไม่ได้ระบุชื่อเซล ยังไม่ได้เลือกวิธีรับรถ) ให้รีบค้นหาสาขาที่ใกล้ที่สุดจริงๆ
// ด้วย Google Maps ทันที แทนที่จะให้ Claude เดาเองว่าอยู่ในเขตบริการไหม/สาขาไหนใกล้สุด ช่วยให้แม่นยำและไม่ต้องรอจนขั้นตอนสุดท้าย
// ทำครั้งเดียวต่อ session (เก็บ flag session.locationBranchIntroDone กันถามซ้ำ/แนะนำซ้ำ)
async function introduceNearestBranches(locationText, session) {
  const branches = await store.getActiveBranches();
  const geo = locationText ? await geocode(locationText) : null;

  if (geo && isServiceArea(geo.province)) {
    const ranked = branches
      .filter((b) => b.lat && b.long)
      .map((b) => ({ branch: b, distanceKm: haversineKm(geo.lat, geo.long, Number(b.lat), Number(b.long)) }))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    const top2 = ranked.slice(0, 2).map((r) => r.branch);
    if (top2.length > 0) {
      if (top2.length === 1) {
        if (session) session.pendingBranchChoiceIds = [top2[0].id];
        return `แอดมินเช็คแผนที่ให้แล้วค่ะ 😊 สาขาที่ใกล้พี่ที่สุดคือ ${top2[0].name} ค่ะ พี่สะดวกมารับที่สาขานี้เอง หรือสนใจให้จัดส่งถึงบ้านดีคะ (จัดส่งฟรีในระยะ 25 กม. จากสาขา และทำสัญญาซื้อขายให้ฟรีทั่วประเทศค่ะ)`;
      }
      // สำคัญมาก: ต้องจำไว้ว่าเสนอสาขาไหนไปบ้าง (session.pendingBranchChoiceIds) ไม่งั้นตอนลูกค้าตอบเลือกสาขามา
      // Claude จะแค่ตอบรับปากเปล่าเฉยๆ (ไม่ได้บันทึกจริงจังลง session/collected) พอคุยต่อไปอีกหลายข้อความ (ชื่อ/เบอร์)
      // ถึงขั้นตอน handoff สุดท้ายจะหาสาขาใหม่จากศูนย์ทั้งที่ลูกค้าตอบเลือกไปแล้ว กลายเป็นถามซ้ำ (บั๊กที่เจอจริง)
      if (session) session.pendingBranchChoiceIds = top2.map((b) => b.id);
      const names = top2.map((b) => b.name).join(" หรือ ");
      return `แอดมินเช็คแผนที่ให้แล้วค่ะ 😊 ใกล้พี่ที่สุดมี 2 สาขาเลยคือ ${names} พี่สะดวกไปสาขาไหนดีคะ หรือสนใจให้จัดส่งถึงบ้านแทนก็ได้นะคะ (จัดส่งฟรีในระยะ 25 กม. จากสาขา และทำสัญญาซื้อขายให้ฟรีทั่วประเทศค่ะ)`;
    }
    // มีพิกัดแต่หาไม่เจอเลยว่าสาขาไหนใกล้ (เช่น สาขายังไม่ได้ตั้งพิกัดในชีต) -> ตกไปโชว์ลิสต์สาขาทั้งหมดด้านล่างแทน
  }

  // หาพิกัดไม่ได้ชัดเจน หรือ Google Maps เดาที่อยู่กว้างเกินไปจนไม่รู้จังหวัด (เช่น ลูกค้าพิมพ์สั้นๆ กำกวมอย่าง "อนุสาวรีย์" เฉยๆ
  // ไม่ระบุว่าอนุสาวรีย์ไหน ทำให้ Google Maps เดาเป็นทั้งประเทศไทยไปเลย) -> ห้ามเดาส่งสำนักงานใหญ่แบบเงียบๆ อีกต่อไป (ลูกค้าอาจอยู่ในเขตบริการจริงๆ
  // แค่พิมพ์ที่อยู่ไม่ชัดพอ) ให้โชว์รายชื่อสาขาทั้งหมดให้ลูกค้าเลือกเอง พร้อมถามเรื่องจัดส่ง/มารับเองไปในคำถามเดียวกันเลย
  if (session) {
    session.pendingBranchChoiceIds = branches.map((b) => b.id);
  }
  const allNames = branches.map((b) => `- ${b.name}`).join("\n");
  return `ขอบคุณที่แจ้งพื้นที่มานะคะ 😊 พอดีแอดมินเช็คแผนที่จากข้อมูลที่พี่ให้มายังไม่ชัดเจนพอที่จะเช็คสาขาใกล้พี่ที่สุดได้เลยค่ะ ถ้าสะดวกรบกวนพี่บอกรายละเอียดเพิ่มอีกนิดได้ไหมคะ (เช่น ชื่อถนน แขวง/เขต หรือจุดสังเกตใกล้เคียง) แอดมินจะได้แนะนำสาขาที่ใกล้พี่ที่สุดให้ถูกต้องเลยค่ะ\n\nเบื้องต้นนี่คือสาขาทั้งหมดของทวีทรัพย์นะคะ:\n${allNames}\n\nพี่สะดวกไปรับรถที่สาขาไหนดีคะ หรือสนใจให้จัดส่งถึงบ้านแทนก็ได้นะคะ (จัดส่งฟรีในระยะ 25 กม. จากสาขา และทำสัญญาซื้อขายให้ฟรีทั่วประเทศค่ะ)`;
}

// เหมือน introduceNearestBranches แต่ใช้สำหรับ "ซ่อมรถ" (service) โดยเฉพาะ: ลูกค้าซ่อมรถต้องเลือกสาขาเสมอ (ไม่มีตัวเลือกจัดส่ง)
// เลยแนะนำ 1-2 สาขาที่ใกล้ที่สุดให้เลือกทันทีที่รู้ที่อยู่ลูกค้า เหมือนกับตอนซื้อรถใหม่ แล้วจำสาขาที่ยืนยันแล้วไว้ใน session.confirmedServiceBranchId
async function introduceNearestServiceBranch(locationText, session) {
  const branches = await store.getActiveBranches();
  const geo = locationText ? await geocode(locationText) : null;

  if (geo && isServiceArea(geo.province)) {
    const ranked = branches
      .filter((b) => b.lat && b.long)
      .map((b) => ({ branch: b, distanceKm: haversineKm(geo.lat, geo.long, Number(b.lat), Number(b.long)) }))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    const top2 = ranked.slice(0, 2).map((r) => r.branch);
    if (top2.length === 0) return null;

    if (top2.length === 1) {
      session.confirmedServiceBranchId = top2[0].id;
      return `แอดมินเช็คแผนที่ให้แล้วค่ะ 😊 สาขาที่ใกล้พี่ที่สุดคือ ${top2[0].name} ค่ะ สะดวกนำรถเข้าซ่อมที่สาขานี้เลยไหมคะ`;
    }
    session.pendingServiceBranchIds = top2.map((b) => b.id);
    const names = top2.map((b) => b.name).join(" หรือ ");
    return `แอดมินเช็คแผนที่ให้แล้วค่ะ 😊 ใกล้พี่ที่สุดมี 2 สาขาเลยคือ ${names} สะดวกนำรถเข้าซ่อมสาขาไหนดีคะ`;
  }

  // นอกเขตบริการ/หาพิกัดไม่ได้ -> ให้สำนักงานใหญ่ดูแลแทนไปเลย ไม่ต้องถามซ้ำ
  const hq = branches.find((b) => (b.name || "").includes("สำนักงานใหญ่")) || branches[0] || null;
  if (hq) session.confirmedServiceBranchId = hq.id;
  return null;
}

async function handleTurn({ session, analysis, rawMessage, platform, userId, customerName, replyContext }) {
  const collected = session.collected;
  const fieldsToMerge = [
    "customer_name",
    "model_or_issue",
    "delivery_preference",
    "location_text",
    "requested_staff_name",
    "preferred_date",
    "phone",
  ];
  fieldsToMerge.forEach((f) => {
    if (analysis[f] !== undefined && analysis[f] !== null && analysis[f] !== "") {
      collected[f] = analysis[f];
    }
  });

  // จัดการ intent_category แยกจากฟิลด์อื่นด้านบน เพราะเจอบั๊กจริง: ข้อความลูกค้าที่กำกวมสั้นๆ (เช่น พิมพ์ต่อเรื่องอะไหล่แบบไม่ชัดเจน
  // "สนใจแพคเกจ ใช้ lead สนใจ size L") ทำให้ Claude เดาหมวดผิดพลาดสลับไปมา (เช่น จาก "service" กลายเป็น "buying_new" ทั้งที่ลูกค้ายังคุย
  // เรื่องอะไหล่/บริการอยู่) จนส่ง lead ไปผิดแผนก (ส่งไปหาเซลทั้งที่ควรเป็นทีมอะไหล่) -> ถ้าเคยมีหมวดที่ชัดเจนอยู่ก่อนแล้ว จะไม่ยอมให้เปลี่ยน
  // หมวดง่ายๆ เปลี่ยนได้ก็ต่อเมื่อหมวดใหม่ตรงกับหมวดเดิม หรือข้อความดิบมีคำสำคัญที่บ่งชี้หมวดใหม่จริงๆ ชัดเจนเท่านั้น (ดู intentKeywordMatches)
  if (analysis.intent_category) {
    const newIntent = analysis.intent_category;
    const oldIntent = collected.intent_category;
    if (!oldIntent || newIntent === oldIntent || intentKeywordMatches(newIntent, rawMessage)) {
      collected.intent_category = newIntent;
    }
  }

  // เก็บว่า location_text ตัวปัจจุบันถูกบันทึกไว้ตอนคุยหัวข้อไหน (ใช้แยกเคส "เพิ่งบอกที่อยู่ครั้งแรกในหัวข้อนี้เอง" สดๆ
  // ออกจากเคส "ที่อยู่ที่มีอยู่ตอนนี้เป็นของหัวข้ออื่นที่คุยไว้ก่อนหน้า" -> กันบั๊กที่เจอจริง: ลูกค้าเพิ่งตอบที่อยู่ไปหยกๆ
  // แต่ระบบกลับถามย้ำแบบงงๆ ว่า "ก่อนหน้านี้พี่แจ้งพื้นที่ไว้ว่า..." ทั้งที่เพิ่งพิมพ์มาในเทิร์นนี้เอง
  if (analysis.location_text) {
    session.locationSetForIntent = collected.intent_category;
  }

  // เคสลูกค้าที่เพิ่งมีนัดซ่อมอยู่แล้วในเซสชันนี้ (เก็บไว้ที่ session.lastServiceBooking) แล้วขอเปลี่ยนสาขาใหม่ภายหลัง
  // เช่น "เปลี่ยนสาขาคลองสามเป็นสำนักงานใหญ่" -> ต้องยกเลิกนัดเดิม แจ้งทีมอะไหล่/สาขาเดิมว่ายกเลิก แล้วจองใหม่ให้สาขาใหม่ทันที
  // ห้ามปล่อยให้มีนัดค้างซ้ำซ้อนที่สาขาเดิมโดยไม่มีใครรู้ว่าลูกค้าไม่มาแล้ว
  if (session.lastServiceBooking && BRANCH_CHANGE_KEYWORDS.test(rawMessage || "")) {
    session.fallbackCount = 0;
    return handleServiceBranchChange({ collected, session, rawMessage, platform, userId, customerName });
  }

  // เคสลูกค้าแจ้งว่า Lead ก่อนหน้านี้ (เก็บไว้ที่ session.lastLead) ถูกส่งผิดแผนกไป (เช่น ต้องการอะไหล่/บริการ แต่ระบบดันส่งเข้าคิวเซลฝ่ายขาย)
  // -> ต้องยกเลิก Lead เดิม คืนคิวให้เซลคนเดิม (ลดตัวนับที่เพิ่มไปตอนสร้าง lead) แจ้งเซลคนเดิมว่ายกเลิกแล้ว แล้วเริ่มจัดหมวดใหม่ให้ถูกต้อง
  if (session.lastLead && WRONG_DEPARTMENT_KEYWORDS.test(rawMessage || "")) {
    session.fallbackCount = 0;
    return handleLeadReroute({ collected, session, rawMessage, platform, userId, customerName });
  }

  // รอบก่อนเคยถามลูกค้าว่า "อยากเปลี่ยนไปสาขาไหน" ค้างไว้ (จาก handleLeadBranchChange ด้านล่าง) -> รอบนี้เช็คคำตอบก่อนอย่างอื่นทั้งหมด
  // กันบั๊กที่เจอจริง: ถ้าไปเข้าเงื่อนไข pendingBranchChoiceIds ทั่วไปด้านล่างก่อน จะแค่บันทึกสาขาไว้เฉยๆ ไม่ได้ยกเลิก Lead เดิม/สร้างใหม่ให้จริง
  if (session.pendingLeadBranchChange && session.pendingBranchChoiceIds && session.pendingBranchChoiceIds.length > 0) {
    const branchesForChange = await store.getActiveBranches();
    const candidates = session.pendingBranchChoiceIds.map((id) => branchesForChange.find((b) => b.id === id)).filter(Boolean);
    const matched = matchBranchFromText(rawMessage || "", candidates.map((b) => ({ branchId: b.id, branchName: b.name })));
    if (matched) {
      session.fallbackCount = 0;
      return finalizeLeadBranchChange({ collected, session, rawMessage, platform, userId, customerName, newBranchId: matched.branchId });
    }
    const names = candidates.map((b) => b.name).join(" หรือ ");
    return `รบกวนแอดมินขอทราบอีกครั้งนะคะ พี่สะดวกเปลี่ยนไปสาขาไหนดีระหว่าง ${names} คะ 🙏`;
  }

  // ลูกค้าที่มี Lead ซื้อรถใหม่/เทิร์นรถอยู่แล้ว (session.lastLead) แล้วขอ "เปลี่ยนสาขา" ภายหลัง (เช่น ไม่สะดวกสาขาที่ส่งไปให้)
  // -> ต้องยกเลิก Lead เดิมจริงๆ (คืนคิวให้เซลคนเดิม แจ้งเซลคนเดิมว่ายกเลิก) แล้วค่อยสร้างใหม่ที่สาขาที่ถูกต้อง ห้ามปล่อยให้มี Lead ซ้ำซ้อน
  // 2 ใบที่สาขาเดิมเหมือนเดิมทั้งที่ลูกค้าขอเปลี่ยนไปแล้ว (บั๊กที่เจอจริง)
  if (session.lastLead && BRANCH_CHANGE_KEYWORDS.test(rawMessage || "")) {
    session.fallbackCount = 0;
    return handleLeadBranchChange({ collected, session, rawMessage, platform, userId, customerName });
  }

  // เช็คประวัติลูกค้าเก่าจาก Sheets (ครั้งเดียวต่อเซสชัน) เผื่อลูกค้าคนนี้เคยติดต่อร้านมาก่อน (คนละวัน/คนละเซสชันกับตอนนี้)
  // เอาไว้ใช้ถามยืนยันสาขา/เบอร์เดิมด้านล่างเท่านั้น ไม่ได้เอามาข้ามคำถามไปเฉยๆ (ต้องถามยืนยันทุกครั้งเสมอ แม้เป็นลูกค้าประจำที่เคยมาแล้ว)
  if (!session.historyChecked) {
    session.historyChecked = true;
    try {
      session.knownHistory = await store.getLatestCustomerRecord(userId);
    } catch (err) {
      console.error("[router] getLatestCustomerRecord error:", err.message);
      session.knownHistory = null;
    }
  }

  // รอบก่อนเพิ่งถามยืนยันสาขา/เบอร์เดิมไป (จาก session.pendingHistoryConfirm ที่ตั้งไว้ด้านล่าง) -> เช็คคำตอบรอบนี้ก่อนไปต่อ
  // ลูกค้ายืนยันว่าใช้ของเดิม (และไม่ได้พิมพ์ข้อมูลใหม่มาแทนที่ในข้อความเดียวกัน) ให้เติมสาขา/เบอร์เดิมเข้า collected ให้เลย
  // ถ้าลูกค้าพิมพ์ข้อมูลใหม่มาแทน Claude จะ extract ใส่ collected ให้เองจาก analysis ที่ merge ไว้ด้านบนแล้วตามปกติ ไม่ต้องทำอะไรเพิ่ม
  if (session.pendingHistoryConfirm) {
    const pendingHist = session.pendingHistoryConfirm;
    session.pendingHistoryConfirm = null;
    if (SAME_AS_BEFORE_KEYWORDS.test(rawMessage || "")) {
      if (pendingHist.phone && !collected.phone) {
        collected.phone = pendingHist.phone;
      }
      if (pendingHist.branchId && !collected.location_text && !collected.requested_staff_name) {
        if (collected.intent_category === "service") {
          session.confirmedServiceBranchId = pendingHist.branchId;
          session.serviceBranchIntroDone = true;
        } else {
          session.confirmedGeneralBranchId = pendingHist.branchId;
          session.locationBranchIntroDone = true;
        }
      }
    }
  }

  // เช็คทันทีที่มีที่อยู่ลูกค้าแล้ว (เฉพาะซื้อรถใหม่ ไม่มีชื่อเซลที่ระบุ ยังไม่ได้เลือกวิธีรับรถ) -> ค้นสาขาใกล้สุดจริงจาก Google Maps เลย
  if (
    collected.intent_category === "buying_new" &&
    collected.location_text &&
    !collected.requested_staff_name &&
    !collected.delivery_preference &&
    !session.locationBranchIntroDone
  ) {
    // ลูกค้าอาจระบุชื่อสาขาที่ต้องการไปตรงๆ อยู่แล้ว (เช่น "คลอง4" "ลำลูกกา" "รังสิต" "สำนักงานใหญ่" "นวมินทร์90")
    // ไม่ต้องเดา/แนะนำสาขาใกล้เคียงจาก Google Maps อีกต่อไปในเคสนี้ ใช้สาขาที่ลูกค้าระบุมาตรงๆ ไปเลย (ถือว่ามารับเองที่สาขา)
    const branchesForDirectMatch = await store.getActiveBranches();
    const directMatch = matchBranchFromText(
      collected.location_text,
      branchesForDirectMatch.map((b) => ({ branchId: b.id, branchName: b.name }))
    );
    if (directMatch) {
      session.confirmedGeneralBranchId = directMatch.branchId;
      session.locationBranchIntroDone = true;
      collected.delivery_preference = collected.delivery_preference || "pickup_at_branch";
    } else {
      const introReply = await introduceNearestBranches(collected.location_text, session);
      if (introReply) {
        session.locationBranchIntroDone = true;
        session.fallbackCount = 0;
        return introReply;
      }
    }
  }

  // เคสเปลี่ยนหัวข้อคุยมาเป็น "ซ่อมรถ" หรือ "เทิร์นรถ" (ทั้งคู่ต้องให้ลูกค้ามาที่สาขาจริงๆ ไม่ใช่จัดส่ง)
  // แต่ที่อยู่ (location_text) ที่มีอยู่ตอนนี้เป็นของหัวข้ออื่นที่คุยไว้ก่อนหน้าในเซสชันเดียวกันจริงๆ (เช็คจาก session.locationSetForIntent
  // ว่าถูกบันทึกไว้ตอนหัวข้อไหน ถ้าคนละหัวข้อกับตอนนี้ถึงจะถือว่าเป็นของเก่าที่ต้องถามย้ำ ถ้าเพิ่งบันทึกในหัวข้อนี้เองไม่ต้องถาม)
  // ห้ามเอาที่อยู่เก่ามาผูกสาขาให้เงียบๆ เพราะลูกค้าอาจสะดวกคนละที่ (เช่น ให้จัดส่งรถที่บ้าน แต่จะนำรถเข้าซ่อมที่ใกล้ที่ทำงานแทน)
  const needsBranchVisit = collected.intent_category === "service" || collected.intent_category === "trade_in";
  const locationIsCarryOver =
    collected.location_text &&
    session.locationSetForIntent &&
    session.locationSetForIntent !== collected.intent_category;

  if (needsBranchVisit && locationIsCarryOver && session.locationConfirmedForIntent !== collected.intent_category) {
    if (session.pendingLocationReconfirmIntent === collected.intent_category) {
      // รอบนี้คือคำตอบของคำถามยืนยันที่อยู่ที่เพิ่งถามไป ไม่ว่าลูกค้าจะตอบว่าเหมือนเดิม หรือบอกที่ใหม่มา (ระบบ merge เป็น location_text ให้แล้วด้านบน)
      // ถือว่ายืนยันแล้ว เคลียร์ flag แล้วปล่อยให้ flow ปกติทำงานต่อจากตรงนี้ในเทิร์นเดียวกันได้เลย
      session.pendingLocationReconfirmIntent = null;
      session.locationConfirmedForIntent = collected.intent_category;
      session.locationSetForIntent = collected.intent_category;
    } else {
      session.pendingLocationReconfirmIntent = collected.intent_category;
      session.fallbackCount = 0;
      const actionLabel = collected.intent_category === "trade_in" ? "นำรถเข้ามาที่สาขา" : "นำรถเข้ารับบริการที่สาขา";
      return `แอดมินเห็นว่าก่อนหน้านี้พี่แจ้งพื้นที่ไว้ว่า "${collected.location_text}" ค่ะ 😊 ยังสะดวก${actionLabel}แถวนั้นเหมือนเดิมไหมคะ หรือจะเปลี่ยนพื้นที่ใหม่บอกแอดมินได้เลยนะคะ`;
    }
  }

  // ซ่อมรถ (service) ที่มีที่อยู่แล้ว ยังไม่ได้ระบุช่างประจำ และยังไม่เคยแนะนำสาขาใกล้บ้านมาก่อนในเซสชันนี้
  // -> แนะนำสาขาใกล้สุด 1-2 สาขาให้ลูกค้าเลือกก่อนเสมอ เหมือนตอนซื้อรถใหม่ (introduceNearestBranches) กันเคสระบบเดาส่งสาขาผิดไปเงียบๆ
  if (
    collected.intent_category === "service" &&
    collected.location_text &&
    !collected.requested_staff_name &&
    !session.serviceBranchIntroDone
  ) {
    const introReply = await introduceNearestServiceBranch(collected.location_text, session);
    if (introReply) {
      session.serviceBranchIntroDone = true;
      session.fallbackCount = 0;
      return introReply;
    }
  }

  // รอบก่อนเคยแนะนำ 1-2 สาขาซ่อมใกล้บ้านให้เลือกไว้ (จาก introduceNearestServiceBranch) -> รอบนี้เช็คว่าลูกค้าเลือกสาขาไหน
  if (session.pendingServiceBranchIds && session.pendingServiceBranchIds.length > 0) {
    const branches = await store.getActiveBranches();
    const candidates = session.pendingServiceBranchIds.map((id) => branches.find((b) => b.id === id)).filter(Boolean);
    const matched = matchBranchFromText(rawMessage || "", candidates.map((b) => ({ branchId: b.id, branchName: b.name })));
    if (matched) {
      session.pendingServiceBranchIds = null;
      session.confirmedServiceBranchId = matched.branchId;
      session.fallbackCount = 0;
      session.pendingServiceBranchAskCount = 0;
    } else {
      // สำคัญมาก: ห้ามถามคำถามเดิมวนซ้ำไม่จบไม่สิ้น (บั๊กที่เจอจริง: ลูกค้าพิมพ์เรื่องอื่นมาเรื่อยๆ แต่บอทสนใจแต่จะถามสาขาต่อไป
      // ไม่ยอมตอบสิ่งที่ลูกค้าถามเลย) ถามซ้ำได้แค่ 1 ครั้ง ถ้ายังไม่ตรงคำถามอีก ให้เลือกสาขาแรกที่แนะนำไปให้เลย แล้วปล่อยผ่านไปคุยเรื่องอื่นต่อ
      session.pendingServiceBranchAskCount = (session.pendingServiceBranchAskCount || 0) + 1;
      if (session.pendingServiceBranchAskCount <= 1) {
        const names = candidates.map((b) => b.name).join(" หรือ ");
        return `รบกวนแอดมินขอทราบอีกครั้งนะคะ สะดวกนำรถเข้าซ่อมสาขาไหนดีระหว่าง ${names} คะ 🙏`;
      }
      session.pendingServiceBranchIds = null;
      session.confirmedServiceBranchId = candidates[0] ? candidates[0].id : null;
      session.pendingServiceBranchAskCount = 0;
    }
  }

  // รอบก่อนเคยแนะนำ 1-2 สาขาซื้อรถใหม่ให้เลือกไว้แล้ว (จาก introduceNearestBranches) -> เช็คคำตอบทันทีตอนนี้เลย ไม่ต้องรอถึงขั้นตอน handoff สุดท้าย
  // กันบั๊กที่เจอจริง: ลูกค้าตอบเลือกสาขาไปแล้ว แต่ระบบไม่ได้บันทึกจริงจัง (แค่ Claude ตอบรับปากเปล่าเฉยๆ) พอคุยต่อไปอีกหลายข้อความ (ชื่อ/เบอร์)
  // ถึงขั้นตอน handoff สุดท้ายกลับหาสาขาใหม่จากศูนย์ ถามซ้ำอีกรอบ ทั้งที่ลูกค้าตอบไปแล้ว
  if (collected.intent_category === "buying_new" && session.pendingBranchChoiceIds && session.pendingBranchChoiceIds.length > 0) {
    const branchesForPending = await store.getActiveBranches();
    const candidates = session.pendingBranchChoiceIds.map((id) => branchesForPending.find((b) => b.id === id)).filter(Boolean);
    const matched = matchBranchFromText(rawMessage || "", candidates.map((b) => ({ branchId: b.id, branchName: b.name })));
    if (matched) {
      session.pendingBranchChoiceIds = null;
      session.confirmedGeneralBranchId = matched.branchId;
      collected.delivery_preference = collected.delivery_preference || "pickup_at_branch";
      session.fallbackCount = 0;
    }
    // ถ้าไม่ match ก็ปล่อยผ่านไปให้ Claude/flow ปกติจัดการต่อ (ลูกค้าอาจกำลังตอบเรื่องอื่นอยู่ เช่น บอกจัดส่งแทน ซึ่ง Claude จะ extract delivery_preference เองจาก field ปกติ)
  }

  const highIntent = analysis.high_intent_keyword || containsHighIntentKeyword(rawMessage);

  // เรื่อง "ซ่อมรถ"/"เทิร์นรถ" ลูกค้าต้องมาที่สาขาจริงๆ เสมอ ต่อให้เจอคำ high_intent_keyword อย่าง "จอง" (ซึ่งมักแปลว่า "จองคิวซ่อม"
  // ไม่ใช่สัญญาณซื้อรถเร่งด่วนแบบที่ใช้กับ buying_new) ก็ห้าม handoff ข้ามขั้นไปเลยถ้ายังไม่รู้เลยว่าลูกค้าสะดวกสาขาไหน/มีช่างประจำไหม
  // ไม่งั้นระบบจะเดาส่งไปสำนักงานใหญ่แบบไม่มีมูลเหตุ (บั๊กที่เจอจริง: ลูกค้าพิมพ์ "จองคิวหน่อย" ทั้งที่ยังไม่เคยบอกที่อยู่เลย)
  const effectiveIntent = collected.intent_category || guessIntentFromText(rawMessage);
  const needsBranchInfo =
    (effectiveIntent === "service" || effectiveIntent === "trade_in" || effectiveIntent === "buying_new") &&
    !collected.location_text &&
    !collected.requested_staff_name &&
    !session.confirmedServiceBranchId &&
    !session.confirmedGeneralBranchId;

  // มีประวัติลูกค้าเก่า (เคยติดต่อร้านมาก่อน) และตอนนี้ยังต้องการข้อมูลสาขา/เบอร์อยู่ แต่ยังไม่เคยถามยืนยันข้อมูลเดิมในเซสชันนี้เลย
  // -> ถามยืนยันก่อนเสมอทุกครั้ง (ไม่ปล่อยผ่านเงียบๆ แม้เป็นลูกค้าประจำที่เคยมาแล้ว) พร้อมโชว์รายละเอียดเดิมให้ลูกค้าดูประกอบการตัดสินใจ
  if (
    session.knownHistory &&
    !session.historyConfirmAsked &&
    (effectiveIntent === "service" || effectiveIntent === "trade_in" || effectiveIntent === "buying_new") &&
    (needsBranchInfo || !collected.phone)
  ) {
    session.historyConfirmAsked = true;
    const hist = session.knownHistory;
    const histBranch = hist.branchId ? await store.getBranchById(hist.branchId) : null;
    const detailParts = [];
    if (histBranch) detailParts.push(`สาขา ${histBranch.name}`);
    if (hist.phone) detailParts.push(`เบอร์ ${hist.phone}`);
    if (detailParts.length > 0) {
      session.fallbackCount = 0;
      session.pendingHistoryConfirm = { branchId: histBranch ? histBranch.id : null, phone: hist.phone || null };
      // สำคัญมาก: ห้ามทิ้งคำตอบ/คำถามที่ลูกค้าเพิ่งถามมาในข้อความเดียวกัน (เช่น "ใช้เอกสารอะไรบ้าง") ไปเฉยๆ
      // เอาคำตอบของ Claude ที่ตอบเรื่องนั้นไปแล้ว (analysis.reply_text_to_customer) มาต่อท้ายด้วยคำถามยืนยันข้อมูลเดิมเสมอ
      // ถ้า Claude ตอบเองไม่ได้ ก็ยังมีข้อความบอกลูกค้าอยู่แล้วว่าจะให้ทีมงานช่วยตอบ (ตามกฎ has_confident_answer ใน systemPrompt)
      const historyQuestion = `แอดมินเห็นว่าพี่เคยติดต่อร้านเรามาก่อนนะคะ 😊 ครั้งก่อนพี่ใช้ ${detailParts.join(" และ ")} ใช่ไหมคะ พี่สะดวกใช้ข้อมูลเดิมนี้ต่อเลย หรือมีอันใหม่สะดวกกว่าแจ้งแอดมินได้เลยค่ะ`;
      const baseReply = (analysis.reply_text_to_customer || "").trim();
      return baseReply ? `${baseReply}\n\n${historyQuestion}` : historyQuestion;
    }
  }

  // ซ่อมรถ (service) ต้องมีทั้งเบอร์โทร (phone) วันที่+ช่วงเวลาที่จะเข้า (preferred_date) และรู้สาขา/ช่างประจำ เก็บครบก่อนเสมอ 100% ทุกกรณี
  // ห้ามข้ามแม้เจอ high_intent_keyword หรือค้าง fallback ครบรอบแล้วก็ตาม กันเคสจองคิวซ่อมแบบไม่มีเบอร์/ไม่มีวันนัดที่ชัดเจน/ไม่รู้สาขาหลุดไปถึงทีมช่าง
  const needsServiceEssentials =
    effectiveIntent === "service" && (!collected.phone || !collected.preferred_date || needsBranchInfo);

  // ซื้อรถใหม่/เทิร์นรถ ก็ต้องรู้สาขา (หรือชื่อเซลประจำตัว) และเบอร์โทรลูกค้าก่อนเสมอเช่นกัน -> ก่อนหน้านี้เงื่อนไข fallbackCount ครบรอบ
  // จะบังคับ handoff ได้เลยแม้ยังไม่มีข้อมูลพวกนี้ ทำให้เคยเกิดบั๊กจริง: ส่ง lead ไปหาเซลแบบไม่เคยถามสาขา/เบอร์ลูกค้าเลยสักครั้ง
  const needsSalesEssentials =
    (effectiveIntent === "buying_new" || effectiveIntent === "trade_in") && (needsBranchInfo || !collected.phone);

  // กันเหนียว: ถึง Claude จะบอกว่า data_complete = true ก็ตาม ห้าม handoff จริงถ้ายังไม่มีเบอร์โทรลูกค้าเก็บไว้เลย
  // (ป้องกันเคส Claude วิเคราะห์ผิดพลาดแล้วส่ง lead ที่ไม่มีเบอร์/ที่อยู่ให้เซลไปโดยไม่ได้ตั้งใจ)
  // ข้อยกเว้น: เจอคำที่บ่งชี้ high intent ชัดเจน (จอง/มัดจำ/โอนเงิน ฯลฯ) หรือค้างถามมาครบรอบ fallback แล้ว ถึงจะส่งเท่าที่มีได้
  // (ยกเว้นหมวด service/buying_new/trade_in ที่ต้องเก็บข้อมูลจำเป็นให้ครบ 100% เสมอ ไม่มีข้อยกเว้นแม้เจอ high intent หรือค้าง fallback ก็ตาม)
  const hasPhone = Boolean(collected.phone);
  const claudeSaysComplete = Boolean(analysis.data_complete) && hasPhone;
  const shouldHandoff =
    !needsServiceEssentials &&
    !needsSalesEssentials &&
    (claudeSaysComplete || (highIntent && !needsBranchInfo) || session.fallbackCount >= FALLBACK_LIMIT);

  if (!shouldHandoff) {
    session.fallbackCount = (session.fallbackCount || 0) + 1;
    // ห้ามใช้ข้อความ default ที่ถามซ้ำเรื่องที่ลูกค้าตอบไปแล้ว (เช่นถามรุ่น/ถามที่อยู่ซ้ำ) เพราะ Claude อาจส่ง reply_text_to_customer
    // ว่างมาชั่วคราว (JSON parse ได้แต่ field นี้หลุด) -> ใช้ข้อความกลางๆ ที่ไม่ขัดกับบริบทที่คุยไปแล้วแทน
    return (
      analysis.reply_text_to_customer ||
      "ขอบคุณที่บอกแอดมินนะคะ 😊 เดี๋ยวแอดมินรับเรื่องต่อให้เลยนะคะ ขอทราบเบอร์ติดต่อกลับได้ไหมคะ 🙏"
    );
  }

  session.fallbackCount = 0;
  return performHandoff({ collected, session, rawMessage, platform, userId, customerName, replyContext, highIntent });
}

async function performHandoff({ collected, session, rawMessage, platform, userId, customerName, replyContext, highIntent }) {
  // ถ้า Claude ไม่ได้จัดหมวดไว้เลย (เช่น รอบนี้ JSON หลุด/ไม่มั่นใจ) แต่ต้อง handoff แล้วเพราะเจอ high_intent_keyword
  // ให้เดาหมวดจากคำในข้อความดิบก่อน กันเคสชัดเจนอย่าง "ซ่อม/อะไหล่/จองคิว" หลุดไปเป็น general เฉยๆ ทั้งที่ควรเข้าคิวช่าง
  const intent = collected.intent_category || guessIntentFromText(rawMessage) || "general";
  if (intent !== collected.intent_category) {
    collected.intent_category = intent;
  }

  if (intent === "buying_new" || intent === "trade_in") {
    return handleSalesHandoff({ collected, session, rawMessage, intent, platform, userId, customerName, replyContext, highIntent });
  }
  if (intent === "service") {
    // ถ้ารอบก่อนเคยแนะนำ/ยืนยันสาขาซ่อมใกล้บ้านลูกค้าไว้แล้ว (session.confirmedServiceBranchId) ให้ใช้สาขานั้นตรงๆ
    // ไม่ต้อง geocode ซ้ำ กันเคสสาขาที่แนะนำไปกับสาขาที่จองจริงไม่ตรงกัน
    let forcedBranch = null;
    if (session.confirmedServiceBranchId) {
      forcedBranch = await store.getBranchById(session.confirmedServiceBranchId);
    }
    return handleServiceHandoff({ collected, session, platform, userId, customerName, replyContext, forcedBranch });
  }
  // general / ไม่รู้จะตอบยังไง (เช่น Claude ตอบไม่มั่นใจ ถามซ้ำจน fallback ครบ หรือลูกค้าขอคุยกับคนจริงแบบไม่เจาะจงหมวด)
  // ก่อนหน้านี้เคสนี้แค่ตอบลูกค้าเฉยๆ ไม่มีการสร้าง lead หรือแจ้งพนักงานเลย ทำให้เรื่องหลุดไปเงียบๆ -> แก้ให้สร้าง lead จริงและแจ้งหัวหน้าสาขาเสมอ
  return handleGeneralHandoff({ collected, rawMessage, platform, userId, customerName });
}

// ชื่อลูกค้าที่จะใช้ในข้อความแจ้งเตือน/บันทึกลง lead: เอาชื่อจริงที่ลูกค้าพิมพ์บอกมาก่อน (customer_name)
// ถ้ายังไม่มีค่อย fallback ไปใช้ชื่อโปรไฟล์ไลน์ (customerName ที่ดึงมาอัตโนมัติ)
function resolveCustomerName(collected, customerName) {
  return collected.customer_name || customerName || "";
}

// หาสาขาที่เหมาะสมให้เคส general (ใช้ location_text ถ้ามี ไม่งั้น fallback ไปสำนักงานใหญ่)
async function resolveGeneralBranch(collected) {
  const branches = await store.getActiveBranches();
  const geo = collected.location_text ? await geocode(collected.location_text) : null;
  if (geo && isServiceArea(geo.province)) {
    const ranked = branches
      .filter((b) => b.lat && b.long)
      .map((b) => ({ branch: b, distanceKm: haversineKm(geo.lat, geo.long, Number(b.lat), Number(b.long)) }))
      .sort((a, b) => a.distanceKm - b.distanceKm);
    if (ranked.length > 0) return ranked[0].branch;
  }
  return branches.find((b) => (b.name || "").includes("สำนักงานใหญ่")) || branches[0] || null;
}

// เคส "ไม่รู้จะตอบยังไง" / ถามซ้ำจนครบ fallback / นอกขอบเขตแต่ลูกค้าขอคุยกับคน -> ต้องมี lead จริงให้พนักงานเห็นเสมอ ห้ามเงียบหาย
async function handleGeneralHandoff({ collected, rawMessage, platform, userId, customerName }) {
  const finalCustomerName = resolveCustomerName(collected, customerName);
  const branch = await resolveGeneralBranch(collected);

  if (!branch) {
    return "แอดมินรับเรื่องไว้แล้วนะคะ เดี๋ยวให้ทีมงานติดต่อกลับไปนะคะ ขอบคุณที่ทักมาคุยกับแอดมินนะคะ 🙏";
  }

  const lead = {
    platform,
    customerId: userId,
    customerName: finalCustomerName,
    intentCategory: "general",
    modelOrIssue: collected.model_or_issue || rawMessage || "(คำถามที่แอดมินตอบเองไม่ได้ ดูข้อความลูกค้าประกอบ)",
    branchId: branch.id,
    staffName: "",
    staffPhone: "",
    phone: collected.phone || null,
    locationText: collected.location_text || null,
    status: "new",
  };
  const leadId = await store.appendLead(lead);
  try {
    await bitrix24.createLead({ ...lead, id: leadId });
  } catch (err) {
    console.error("[router] bitrix24.createLead (general) error:", err.message);
  }

  const notifyText =
    "❓ เรื่องที่แอดมิน (บอท) ตอบเองไม่ได้ (" + platform + ")\n" +
    (finalCustomerName ? "ชื่อลูกค้า: " + finalCustomerName + "\n" : "") +
    "สาขาที่ใกล้ลูกค้า: " + branch.name + "\n" +
    "คำถาม/ข้อความล่าสุดจากลูกค้า: " + (collected.model_or_issue || rawMessage || "-") + "\n" +
    "เบอร์ลูกค้า: " + (collected.phone || "-") + "\n" +
    (collected.hasMediaAttachment ? "📎 ลูกค้าส่ง" + collected.hasMediaAttachment + "มาด้วย (เปิดดูในแชท LINE ของลูกค้าโดยตรง)\n" : "") +
    "Lead ID: " + leadId;

  // เคส general ไม่มีเซล/ทีมอะไหล่เจาะจงรับผิดชอบ ให้แจ้งหัวหน้าสาขาโดยตรงเลย พร้อมปุ่มรับทราบ
  const supervisor = await store.getSupervisorForBranch(branch.id);
  if (supervisor && supervisor.lineUserId) {
    try {
      await line.pushMessageWithAck(supervisor.lineUserId, notifyText, leadId);
    } catch (err) {
      console.error("[router] handleGeneralHandoff notify supervisor error:", err.message);
    }
  } else {
    console.warn(`[router] สาขา ${branch.id} ยังไม่ได้ลงทะเบียนหัวหน้าสาขา (role=supervisor) ข้อความหลุด:`, notifyText);
  }

  return "แอดมินรับเรื่องไว้แล้วนะคะ 😊 เดี๋ยวให้ทีมงานที่ดูแลเรื่องนี้ช่วยตอบละเอียดอีกทีนะคะ ขอบคุณที่ทักมาคุยกับแอดมินนะคะ 🙏";
}

async function handleSalesHandoff({ collected, session, rawMessage, intent, platform, userId, customerName, replyContext, highIntent }) {
  let assignedStaff = null;
  let assignedBranch = null;
  let routingMethod = "round_robin";
  const finalCustomerName = resolveCustomerName(collected, customerName);

  // เคสค้าง: รอบก่อนเคยถามลูกค้าไปแล้วว่า "สะดวกสาขาไหน" (เพราะชื่อเซลซ้ำ/คล้ายกันหลายคน หรือหาชื่อไม่เจอเลย) -> รอบนี้เช็คคำตอบ
  if (session.pendingStaffBranchOptions && session.pendingStaffBranchOptions.length > 0) {
    const options = session.pendingStaffBranchOptions;
    const matchedOption = matchBranchFromText(rawMessage || "", options);

    if (!matchedOption) {
      // สำคัญมาก: ห้ามถามคำถามเดิมวนซ้ำไม่จบไม่สิ้น (บั๊กที่เจอจริง: ลูกค้าพิมพ์เรื่องอื่นมาเรื่อยๆ เช่น ถามราคา/วิธีชำระเงิน
      // แต่บอทสนใจแต่จะถามสาขาต่อไปเรื่อยๆ ไม่ยอมตอบสิ่งที่ลูกค้าถามเลยสักคำ) ถามซ้ำได้แค่ 1 ครั้ง ถ้ายังไม่ตรงคำถามอีก
      // ให้เลิกตามหาเซลที่ระบุ (อาจพิมพ์ชื่อตัวเองมาโดยไม่ได้ตั้งใจ หรือแค่ทักทายเฉยๆ) แล้วปล่อยให้ระบบจัดหาสาขา/เซลให้แบบปกติแทน
      session.pendingStaffBranchAskCount = (session.pendingStaffBranchAskCount || 0) + 1;
      if (session.pendingStaffBranchAskCount <= 1) {
        const names = options.map((o) => o.branchName).join(" หรือ ");
        return `รบกวนแอดมินขอทราบอีกครั้งนะคะ สะดวกไปสาขาไหนดีระหว่าง ${names} คะ 🙏`;
      }
      session.pendingStaffBranchOptions = null;
      session.pendingStaffCandidateIds = null;
      session.pendingStaffBranchAskCount = 0;
      collected.requested_staff_name = null;
      assignedBranch = await resolveBranchDirect(collected);
    } else {
      assignedBranch = await store.getBranchById(matchedOption.branchId);

      if (session.pendingStaffCandidateIds && session.pendingStaffCandidateIds.length > 0) {
        const candidates = await Promise.all(session.pendingStaffCandidateIds.map((id) => store.findStaffById(id)));
        // ใช้ staffServesBranch แทนเทียบ branchId ตรงๆ เพราะพนักงาน 1 คนอาจดูแลได้หลายสาขา (branchId เก็บเป็น "NM90,LL4")
        const found = candidates.find(
          (s) => s && store.staffServesBranch(s, matchedOption.branchId) && String(s.active).toUpperCase() === "TRUE"
        );
        if (found) {
          assignedStaff = found;
          routingMethod = "requested";
        }
      }

      session.pendingStaffBranchOptions = null;
      session.pendingStaffCandidateIds = null;
      session.pendingStaffBranchAskCount = 0;
    }
  }
  // เงื่อนไขที่ 1: ลูกค้าเจาะจงชื่อเซล -> ค้นหาเฉพาะ role=sales ในระบบ (รองรับพิมพ์ชื่อคลาดเคลื่อนเล็กน้อย เช่น ขวัญ/ขวัน)
  else if (collected.requested_staff_name) {
    const matches = await store.findStaffMatches(collected.requested_staff_name, "sales");

    if (matches.length === 1 && store.getStaffBranchIds(matches[0]).length <= 1) {
      // เจอคนเดียวและดูแลแค่สาขาเดียว -> ไม่ต้องถามอะไรเพิ่ม
      assignedStaff = matches[0];
      assignedBranch = await store.getBranchById(store.getStaffBranchIds(matches[0])[0]);
      routingMethod = "requested";
    } else if (matches.length >= 1) {
      // เคสที่ต้องถามสาขา 2 แบบ: (1) ชื่อซ้ำ/คล้ายกันหลายคนอยู่คนละสาขา หรือ (2) เจอคนเดียวแต่คนนั้นดูแลหลายสาขา
      // รวมสาขาที่เป็นไปได้ทั้งหมดจากทุก match เข้าด้วยกัน (กันชื่อซ้ำหลายคน + บางคนดูแลหลายสาขาพร้อมกัน)
      const branches = await store.getActiveBranches();
      const branchIds = [...new Set(matches.flatMap((s) => store.getStaffBranchIds(s)))];
      const options = branchIds
        .map((id) => branches.find((b) => b.id === id))
        .filter(Boolean)
        .map((b) => ({ branchId: b.id, branchName: b.name }));

      if (options.length <= 1) {
        // จริงๆ แล้วมีตัวเลือกสาขาเดียว (เช่น ชื่อซ้ำแต่อยู่สาขาเดียวกัน) -> เลือกคนแรกไปเลย ไม่ต้องถามซ้ำให้ลูกค้ารำคาญ
        assignedStaff = matches[0];
        assignedBranch = await store.getBranchById(store.getStaffBranchIds(matches[0])[0]);
        routingMethod = "requested";
      } else {
        session.pendingStaffBranchOptions = options;
        session.pendingStaffCandidateIds = matches.map((s) => s.id);
        const names = options.map((o) => o.branchName).join(" หรือ ");
        const intro =
          matches.length > 1
            ? `พบชื่อ "${collected.requested_staff_name}" มากกว่า 1 คนเลยค่ะ 😊`
            : `คุณ ${matches[0].name} ดูแลหลายสาขาเลยค่ะ 😊`;
        return `${intro} สะดวกไปสาขาไหนดีระหว่าง ${names} คะ`;
      }
    } else {
      // ไม่พบชื่อนี้ในระบบเลย -> แจ้งลูกค้าตรงๆ แล้วถามว่าสะดวกสาขาไหน แทนที่จะเงียบแล้วสุ่มให้เอง
      const branches = await store.getActiveBranches();
      const options = branches.map((b) => ({ branchId: b.id, branchName: b.name }));
      session.pendingStaffBranchOptions = options;
      session.pendingStaffCandidateIds = null;
      const names = options.map((o) => o.branchName).join(" หรือ ");
      return `เบื้องต้นแอดมินไม่พบชื่อ "${collected.requested_staff_name}" ในระบบนะคะ 🙏 ขอทราบก่อนได้ไหมคะว่าพี่สะดวกไปสาขาไหนระหว่าง ${names} คะ`;
    }
  } else if (intent === "buying_new") {
    const resolved = await resolveAssignedBranchForBuyingNew({ collected, session, rawMessage });
    if (resolved.clarifyingReply) {
      return resolved.clarifyingReply;
    }
    assignedBranch = resolved.branch;
  } else {
    // trade_in: ต้องมาสาขาเสมอ -> ถ้าเพิ่งยืนยันใช้สาขาเดิมจากประวัติลูกค้าไปแล้ว (session.confirmedGeneralBranchId) ใช้สาขานั้นตรงๆ ไม่ต้องถามซ้ำ
    // ไม่งั้นแค่ถามตรงๆ ว่าสะดวกนำรถเข้าสาขาไหน แล้ว match ชื่อสาขาจากคำตอบลูกค้า
    if (session.confirmedGeneralBranchId) {
      const branches = await store.getActiveBranches();
      assignedBranch = branches.find((b) => b.id === session.confirmedGeneralBranchId) || (await resolveBranchDirect(collected));
    } else {
      assignedBranch = await resolveBranchDirect(collected);
    }
  }

  if (!assignedStaff && assignedBranch) {
    // เทิร์นรถรันคิวแยกจากคิวขายรถใหม่ ไม่ใช้ตัวนับร่วมกัน (ทั้งคู่ดึงเฉพาะ role=sales)
    assignedStaff =
      intent === "trade_in" ? await store.pickNextInTradeInQueue(assignedBranch.id) : await store.pickNextInQueue(assignedBranch.id);
  }

  if (!assignedStaff || !assignedBranch) {
    return "ขอโทษด้วยนะคะ ตอนนี้คิวเซลเต็มชั่วคราว แอดมินจะรีบให้ทีมงานติดต่อกลับไปโดยเร็วที่สุดเลยค่ะ 🙏";
  }

  if (intent === "trade_in") {
    await store.incrementOpenTradeInCount(assignedStaff.id);
  } else {
    await store.incrementOpenLeadsCount(assignedStaff.id);
  }

  const lead = {
    platform,
    customerId: userId,
    customerName: finalCustomerName,
    intentCategory: intent,
    modelOrIssue: collected.model_or_issue || null,
    branchId: assignedBranch.id,
    staffName: assignedStaff.name,
    staffPhone: assignedStaff.phone,
    phone: collected.phone || null,
    locationText: collected.location_text || null,
    status: "new",
  };

  const leadId = await store.appendLead(lead);
  try {
    await bitrix24.createLead({ ...lead, id: leadId, routingMethod, highIntentKeyword: Boolean(highIntent) });
  } catch (err) {
    console.error("[router] bitrix24.createLead error:", err.message);
  }

  // จำ lead ล่าสุดไว้ใน session เผื่อลูกค้าแจ้งภายหลังว่าส่งผิดแผนก (ดู handleLeadReroute) จะได้ยกเลิก/คืนคิวให้เซลคนนี้ได้ถูกต้อง
  if (session) {
    session.lastLead = {
      leadId,
      intentCategory: intent,
      branchId: assignedBranch.id,
      staffId: assignedStaff.id,
      staffName: assignedStaff.name,
    };
  }

  const badge = routingMethod === "requested" ? `🌟 ลูกค้าประจำของ ${assignedStaff.name}\n` : "";
  const deliveryNote = collected.delivery_preference ? `วิธีรับรถ: ${collected.delivery_preference}\n` : "";
  const customerNameNote = finalCustomerName ? `ชื่อลูกค้า (${platform}): ${finalCustomerName}\n` : "";
  const tradeInNote =
    intent === "trade_in" ? "⚠️ เทิร์นรถ: แจ้งลูกค้าได้แค่ราคาประเมินเบื้องต้น ห้ามฟันธงราคาสุดท้ายทางแชท ลูกค้าอาจส่งภาพรถคันเดิมมาให้ดูประกอบการประเมิน\n" : "";
  const notifyText =
    badge +
    "🔔 Lead ใหม่ (" + platform + ")\n" +
    customerNameNote +
    tradeInNote +
    "สาขา: " + assignedBranch.name + "\n" +
    "รุ่นที่สนใจ: " + (collected.model_or_issue || "-") + "\n" +
    deliveryNote +
    "ที่อยู่ลูกค้า: " + (collected.location_text || "-") + "\n" +
    "เบอร์ลูกค้า: " + (collected.phone || "-") + "\n" +
    (collected.hasMediaAttachment ? "📎 ลูกค้าส่ง" + collected.hasMediaAttachment + "มาด้วย (เปิดดูในแชท LINE ของลูกค้าโดยตรง)\n" : "") +
    "Lead ID: " + leadId;

  await notifyStaffDirect(assignedStaff, notifyText, leadId, assignedBranch.id);

  const deliveryLine =
    collected.delivery_preference === "home_delivery"
      ? "เรื่องจัดส่งถึงบ้าน "
      : collected.delivery_preference === "pickup_at_branch"
      ? "เรื่องรับรถที่สาขา "
      : "";
  const nameGreeting = finalCustomerName ? `คุณ${finalCustomerName} ` : "";
  const addLineNote = assignedStaff.lineAddUrl
    ? `\n\nแอดไลน์ ${assignedStaff.name} ไว้คุยต่อได้เลยนะคะ: ${assignedStaff.lineAddUrl}`
    : "";

  // เทิร์นรถ: ชวนลูกค้าส่งภาพรถคันเดิมให้เซลประจำสาขาดูเพื่อประเมินราคาเบื้องต้น
  // ย้ำเสมอว่าเป็นแค่ราคาประเมินเบื้องต้น ไม่ใช่ราคาสุดท้าย ต้องนำรถเข้ามาตรวจที่สาขาอีกครั้ง
  // ชื่อสาขาที่เก็บในชีตมักมีคำว่า "สาขา" ต่อหน้าอยู่แล้ว (เช่น "สาขานวมินทร์ 90") เลยไม่ใส่คำว่า "สาขา" ซ้ำอีกตรงนี้ กันบั๊ก "สาขาสาขา..."
  const tradeInPriceNote =
    intent === "trade_in"
      ? ` สามารถส่งภาพรถคันเดิมเพื่อขอประเมินราคาเบื้องต้นได้ที่เซล ${assignedStaff.name} ${assignedBranch.name}เลยนะคะ (ราคาที่ประเมินเป็นเพียงราคาเบื้องต้นเท่านั้นนะคะ ต้องนำรถเข้ามาตรวจเช็คสภาพจริงที่สาขาอีกครั้งเพื่อประเมินราคาสุดท้าย)`
      : "";

  // ปรับให้อบอุ่น เป็นกันเองมากขึ้นตามหลักจิตวิทยาการขาย ระบุชื่อสาขาให้ชัดเจนด้วย (ไม่ใช่แค่ชื่อ+เบอร์เซลลอยๆ ห้วนๆ)
  return `เรียบร้อยค่ะ${nameGreeting ? " " + nameGreeting : ""}! 🙏 ขอบคุณมากๆ นะคะที่ไว้วางใจทวีทรัพย์ยานยนต์ค่ะ 😊 แอดมินส่งข้อมูลของพี่ให้ทีมงาน${assignedBranch.name}เรียบร้อยแล้วนะคะ ${deliveryLine}เดี๋ยวจะมีเซลชื่อ ${assignedStaff.name} จากสาขานี้ติดต่อกลับไปหาพี่เร็วๆ นี้เลยนะคะ (เบอร์เซล: ${assignedStaff.phone || "รอเบอร์ติดต่อ"}) รบกวนรอสักครู่นะคะ${tradeInPriceNote}${addLineNote}`;
}

// หาสาขาให้ลูกค้า -> ใช้ตอน (1) ระบุชื่อเซล/ขอคุยกับพนักงาน แต่ระบบไม่รู้จักตัวตน หรือ (2) ลูกค้าเทิร์นรถที่บอกตรงๆ
// ว่าสะดวกนำรถเข้าสาขาไหน -> match ชื่อสาขาจากข้อความลูกค้าก่อน ถ้าไม่เจอค่อย fallback ไปหาสาขาใกล้สุดจากพิกัด
async function resolveBranchDirect(collected) {
  const branches = await store.getActiveBranches();
  const hintText = `${collected.location_text || ""} ${collected.requested_staff_name || ""}`.trim();

  if (hintText) {
    const matched = matchBranchFromText(
      hintText,
      branches.map((b) => ({ branchId: b.id, branchName: b.name }))
    );
    if (matched) {
      const matchedBranch = branches.find((b) => b.id === matched.branchId);
      if (matchedBranch) return matchedBranch;
    }
  }

  const geo = collected.location_text ? await geocode(collected.location_text) : null;
  if (geo) {
    const ranked = branches
      .filter((b) => b.lat && b.long)
      .map((b) => ({ branch: b, distanceKm: haversineKm(geo.lat, geo.long, Number(b.lat), Number(b.long)) }))
      .sort((a, b) => a.distanceKm - b.distanceKm);
    if (ranked.length > 0) return ranked[0].branch;
  }

  return branches.find((b) => (b.name || "").includes("สำนักงานใหญ่")) || branches[0] || null;
}

// หาสาขาให้ลูกค้าที่สนใจซื้อรถใหม่ (ไม่ได้ระบุชื่อเซล) ตามเงื่อนไข:
// - อยู่ กทม./ปทุมธานี + จัดส่ง -> สาขาใกล้สุด (ส่งฟรีไม่เกิน 25 กม.)
// - อยู่ กทม./ปทุมธานี + มารับหน้าร้าน -> แนะนำ 2 สาขาใกล้สุดให้เลือก แล้วรอลูกค้าตอบ
// - อยู่นอก กทม./ปทุมธานี (หรือหาพิกัดไม่ได้) -> ส่งสำนักงานใหญ่ (สนญ) รันคิวทันที ไม่ถามต่อ
async function resolveAssignedBranchForBuyingNew({ collected, session, rawMessage }) {
  const branches = await store.getActiveBranches();

  // เพิ่งยืนยันใช้สาขาเดิมจากประวัติลูกค้าไปแล้ว (ดู session.pendingHistoryConfirm ใน handleTurn) -> ใช้สาขานั้นตรงๆ ไม่ต้องเดา/ถามซ้ำ
  if (session.confirmedGeneralBranchId) {
    const forced = branches.find((b) => b.id === session.confirmedGeneralBranchId);
    if (forced) return { branch: forced };
  }

  // รอบก่อนเคยแนะนำ 2 สาขาให้เลือกไว้ (จากขั้นตอน introduceNearestBranches หรือจากรอบนี้เอง) -> รอบนี้เช็คว่าลูกค้าเลือกสาขาไหน
  if (session.pendingBranchChoiceIds && session.pendingBranchChoiceIds.length > 0) {
    const candidates = session.pendingBranchChoiceIds
      .map((id) => branches.find((b) => b.id === id))
      .filter(Boolean);
    const matched = matchBranchFromText(
      rawMessage || "",
      candidates.map((b) => ({ branchId: b.id, branchName: b.name }))
    );
    if (matched) {
      session.pendingBranchChoiceIds = null;
      return { branch: candidates.find((b) => b.id === matched.branchId) };
    }
    const names = candidates.map((b) => b.name).join(" หรือ ");
    return { clarifyingReply: `รบกวนบอกแอดมินอีกครั้งนะคะ สะดวกไปสาขาไหนดีระหว่าง ${names} คะ 🙏` };
  }

  const geo = collected.location_text ? await geocode(collected.location_text) : null;

  if (geo && isServiceArea(geo.province)) {
    const ranked = branches
      .filter((b) => b.lat && b.long)
      .map((b) => ({ branch: b, distanceKm: haversineKm(geo.lat, geo.long, Number(b.lat), Number(b.long)) }))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    if (collected.delivery_preference === "home_delivery") {
      if (ranked.length > 0) return { branch: ranked[0].branch };
    } else {
      // pickup_at_branch หรือยังไม่ระบุความต้องการจัดส่ง -> ให้เลือกจาก 2 สาขาใกล้สุด
      const top2 = ranked.slice(0, 2).map((r) => r.branch);
      if (top2.length >= 2) {
        session.pendingBranchChoiceIds = top2.map((b) => b.id);
        const names = top2.map((b) => b.name).join(" หรือ ");
        return { clarifyingReply: `แอดมินเช็คให้แล้วค่ะ ใกล้พี่สุดมี 2 สาขาเลยคือ ${names} สะดวกไปสาขาไหนดีคะ 😊` };
      }
      if (top2.length === 1) return { branch: top2[0] };
    }
  }

  // นอกพื้นที่ กทม./ปทุมธานี หรือหาพิกัดไม่ได้ -> ส่งสำนักงานใหญ่ (สนญ) รันคิวทันที
  const hq = branches.find((b) => (b.name || "").includes("สำนักงานใหญ่")) || branches[0] || null;
  return { branch: hq };
}

// นัดซ่อม: ลูกค้าพิมพ์รุ่นรถ/อาการเข้ามา บอทหาสาขาที่ใกล้ที่สุด แล้วดึงคิวทีมอะไหล่ (role=parts) ของสาขานั้น
// มาแบบหมุนคิวเหมือนเซล ถ้าไม่มีทีมอะไหล่ในสาขานั้นเลย fallback ไปหาหัวหน้าสาขาแทน
// forcedBranch: ใช้ตอนลูกค้าเคยยืนยัน/เลือกสาขาไว้แล้วในเซสชันนี้ (จาก introduceNearestServiceBranch หรือ handleServiceBranchChange)
// จะได้ใช้สาขานั้นตรงๆ ไม่ต้อง geocode ซ้ำ กันเคสสาขาที่แนะนำไปกับสาขาที่จองจริงไม่ตรงกัน
async function handleServiceHandoff({ collected, session, platform, userId, customerName, replyContext, forcedBranch }) {
  const branches = await store.getActiveBranches();
  let assignedBranch = forcedBranch || null;
  const finalCustomerName = resolveCustomerName(collected, customerName);

  if (!assignedBranch) {
    const geo = collected.location_text ? await geocode(collected.location_text) : null;
    if (geo && isServiceArea(geo.province)) {
      const ranked = branches
        .filter((b) => b.lat && b.long)
        .map((b) => ({ branch: b, distanceKm: haversineKm(geo.lat, geo.long, Number(b.lat), Number(b.long)) }))
        .sort((a, b) => a.distanceKm - b.distanceKm);
      assignedBranch = ranked.length > 0 ? ranked[0].branch : null;
    }
  }
  if (!assignedBranch) {
    // เดิม fallback ไปที่ branches[0] เฉยๆ (แถวแรกในชีต Branches) ทำให้ลูกค้าที่อยู่นอกเขตบริการโดนส่งไปสาขาแรกในชีตแบบสุ่มๆ
    // แก้ให้ fallback ไปสำนักงานใหญ่เหมือนฟังก์ชันอื่นๆ ในไฟล์นี้ทั้งหมด
    assignedBranch = branches.find((b) => (b.name || "").includes("สำนักงานใหญ่")) || branches[0] || null;
  }
  if (!assignedBranch) {
    return "ขอโทษด้วยนะคะ ตอนนี้แอดมินหาสาขาที่รับนัดซ่อมให้ไม่ได้ชั่วคราว เดี๋ยวทีมงานจะติดต่อกลับไปโดยเร็วที่สุดเลยค่ะ 🙏";
  }

  const dateStr = normalizeDate(collected.preferred_date || "");

  const assignedPartsStaff = await store.pickNextInPartsQueue(assignedBranch.id);
  if (assignedPartsStaff) {
    await store.incrementOpenPartsCount(assignedPartsStaff.id);
  }

  const booking = {
    platform,
    customerId: userId,
    branchId: assignedBranch.id,
    serviceDate: dateStr,
    issue: collected.model_or_issue || null,
    phone: collected.phone || null,
    status: "new",
    staffName: assignedPartsStaff ? assignedPartsStaff.name : "",
    staffPhone: assignedPartsStaff ? assignedPartsStaff.phone : "",
    customerName: finalCustomerName,
  };
  const bookingId = await store.appendBooking(booking);

  // จำนัดล่าสุดไว้ใน session เผื่อลูกค้าขอเปลี่ยนสาขาภายหลังในเซสชันเดียวกัน (ดู handleServiceBranchChange)
  if (session) {
    session.lastServiceBooking = {
      bookingId,
      branchId: assignedBranch.id,
      branchName: assignedBranch.name,
      partsStaffId: assignedPartsStaff ? assignedPartsStaff.id : null,
      partsStaffName: assignedPartsStaff ? assignedPartsStaff.name : "",
    };
  }

  const customerNameNote = finalCustomerName ? `ชื่อลูกค้า (${platform}): ${finalCustomerName}\n` : "";
  const notifyText =
    "🔧 นัดซ่อมใหม่ (" + platform + ")\n" +
    customerNameNote +
    "สาขา: " + assignedBranch.name + "\n" +
    "วันที่นัด: " + (dateStr || "ยังไม่ระบุ") + "\n" +
    "รุ่นรถ/อาการ: " + (collected.model_or_issue || "-") + "\n" +
    "เบอร์ลูกค้า: " + (collected.phone || "-") + "\n" +
    (collected.hasMediaAttachment ? "📎 ลูกค้าส่ง" + collected.hasMediaAttachment + "มาด้วย (เปิดดูในแชท LINE ของลูกค้าโดยตรง)\n" : "") +
    "(ทีมอะไหล่รบกวนเช็กสต๊อกอะไหล่/อุปกรณ์ที่ต้องใช้ล่วงหน้าให้ด้วยนะคะ)\n" +
    "Booking ID: " + bookingId;

  await notifyPartsDirect(assignedBranch, assignedPartsStaff, notifyText, bookingId);

  const nameGreeting = finalCustomerName ? `คุณ${finalCustomerName} ` : "";
  const partsAddLineNote = assignedPartsStaff && assignedPartsStaff.lineAddUrl
    ? `\n\nแอดไลน์ทีมอะไหล่ไว้คุยต่อได้เลยนะคะ: ${assignedPartsStaff.lineAddUrl}`
    : "";

  // ชื่อสาขาที่เก็บในชีตมักมีคำว่า "สาขา" นำหน้าอยู่แล้ว (เช่น "สาขานวมินทร์ 90") เลยไม่ใส่คำว่า "สาขา" ซ้ำอีกตรงนี้ กันบั๊ก "สาขาสาขา..."
  return `แอดมินรับข้อมูลนัดซ่อมของ${nameGreeting}เรียบร้อยแล้วนะคะ 😊 ${assignedBranch.name}${dateStr ? " วันที่ " + dateStr : ""} เดี๋ยวทางศูนย์จะติดต่อกลับไปยืนยันคิวอีกครั้งเร็วๆ นี้นะคะ${partsAddLineNote}\n\nขอบคุณที่ไว้วางใจนะคะ 🙏`;
}

// ลูกค้าที่มีนัดซ่อมอยู่แล้ว (session.lastServiceBooking) ขอเปลี่ยนไปสาขาอื่นภายหลัง
// -> ยกเลิกนัดเดิม แจ้งทีมอะไหล่/สาขาเดิมว่ายกเลิก (พร้อมปุ่มรับทราบเหมือนแจ้งเตือนอื่นๆ ทุกกรณี) แล้วจองใหม่ให้สาขาใหม่ทันที
async function handleServiceBranchChange({ collected, session, rawMessage, platform, userId, customerName }) {
  const oldBooking = session.lastServiceBooking;
  const branches = await store.getActiveBranches();

  // หาสาขาใหม่จากชื่อสาขาที่ปรากฏในข้อความลูกค้าก่อน (ไม่รวมสาขาเดิม กันเคสลูกค้าพิมพ์ทั้งสาขาเดิม+ใหม่ในประโยคเดียวกัน
  // เช่น "เปลี่ยนสาขาคลองสามเป็นสำนักงานใหญ่" -> ต้องจับ "สำนักงานใหญ่" ไม่ใช่ไปแมตช์ "คลองสาม" ซ้ำ)
  const options = branches.filter((b) => b.id !== oldBooking.branchId).map((b) => ({ branchId: b.id, branchName: b.name }));
  let newBranch = matchBranchFromText(rawMessage || "", options);

  if (!newBranch && collected.location_text) {
    const resolved = await resolveBranchDirect(collected);
    if (resolved && resolved.id !== oldBooking.branchId) {
      newBranch = { branchId: resolved.id, branchName: resolved.name };
    }
  }

  if (!newBranch) {
    const names = options.map((o) => o.branchName).join(" หรือ ");
    return `รบกวนแอดมินขอทราบอีกครั้งนะคะ อยากเปลี่ยนไปสาขาไหนดีระหว่าง ${names} คะ 🙏`;
  }

  // ยกเลิกนัดเดิม แจ้งทีมอะไหล่/สาขาเดิมทันที
  await store.cancelBooking(oldBooking.bookingId);
  const cancelText =
    "❌ ยกเลิกนัดซ่อม (ลูกค้าขอเปลี่ยนไปสาขาอื่นแทน)\n" +
    "สาขาเดิม: " + oldBooking.branchName + "\n" +
    "Booking ID เดิม: " + oldBooking.bookingId;
  const oldPartsStaff = oldBooking.partsStaffId ? await store.findStaffById(oldBooking.partsStaffId) : null;
  const oldBranch = branches.find((b) => b.id === oldBooking.branchId) || { id: oldBooking.branchId, name: oldBooking.branchName };
  await notifyPartsDirect(oldBranch, oldPartsStaff, cancelText, oldBooking.bookingId);

  // จองใหม่ทันทีที่สาขาใหม่ (ใช้ forcedBranch ตรงๆ ไม่ต้อง geocode ซ้ำ เพราะลูกค้าเพิ่งเจาะจงชื่อสาขามาแล้ว)
  const newBranchFull = branches.find((b) => b.id === newBranch.branchId);
  session.locationSetForIntent = "service";
  session.locationConfirmedForIntent = "service";
  session.confirmedServiceBranchId = newBranchFull ? newBranchFull.id : null;
  session.pendingServiceBranchIds = null;
  return handleServiceHandoff({
    collected,
    session,
    platform,
    userId,
    customerName,
    replyContext: null,
    forcedBranch: newBranchFull,
  });
}

// แปลงข้อความวันที่/ช่วงเวลาดิบจาก Claude ให้เป็นรูปแบบที่เก็บลงชีตได้: ถ้ามีวันที่แบบ YYYY-MM-DD ให้ดึงออกมา
// แล้วต่อท้ายด้วยช่วงเวลา (เช้า/บ่าย/เย็น หรือเวลาโดยประมาณ) ถ้ามีระบุมาด้วย กันไม่ให้ข้อมูลช่วงเวลาที่ลูกค้าบอกหายไปเงียบๆ
// ถ้ายังไม่มีรูปแบบวันที่ชัดเจนเลย (เช่น Claude ยังแปลงไม่ได้) ให้เก็บข้อความดิบไว้ก่อน ดีกว่าทิ้งไปเฉยๆ
// ลูกค้าแจ้งว่า Lead ที่ส่งไปก่อนหน้านี้ (session.lastLead) ผิดแผนก (เช่น ต้องการอะไหล่/บริการ แต่ระบบดันส่งเข้าคิวเซลฝ่ายขาย)
// -> ยกเลิก Lead เดิม คืนคิวให้เซลคนเดิม (ลดตัวนับ openLeadsCount/openTradeInCount ที่เพิ่มไปตอนสร้าง lead ผิดพลาด)
// แจ้งเซลคนเดิมว่ายกเลิกแล้ว (พร้อมปุ่มรับทราบเหมือนแจ้งเตือนอื่นๆ) แล้วเคลียร์หมวดเดิมทั้งหมดให้เริ่มจัดหมวดใหม่จากข้อความถัดไปล้วนๆ
async function handleLeadReroute({ collected, session, rawMessage, platform, userId, customerName }) {
  const oldLead = session.lastLead;
  if (!oldLead) {
    return "ขอโทษด้วยนะคะ 🙏 รบกวนแจ้งอีกครั้งได้ไหมคะว่าต้องการเรื่องอะไหล่/บริการซ่อม หรือเรื่องซื้อ-เทิร์นรถคะ แอดมินจะรีบส่งให้ทีมที่ถูกต้องทันทีเลยค่ะ";
  }

  await store.cancelLead(oldLead.leadId);
  if (oldLead.intentCategory === "trade_in") {
    await store.decrementOpenTradeInCount(oldLead.staffId);
  } else {
    await store.decrementOpenLeadsCount(oldLead.staffId);
  }

  const cancelText =
    "❌ ยกเลิก Lead (ส่งผิดแผนก ลูกค้าแจ้งว่าจริงๆ เป็นเรื่องอื่น)\n" +
    "Lead ID เดิม: " + oldLead.leadId;
  const oldStaff = await store.findStaffById(oldLead.staffId);
  if (oldStaff) {
    await notifyStaffDirect(oldStaff, cancelText, oldLead.leadId, oldLead.branchId);
  }

  // เคลียร์หมวดเดิมทั้งหมด ให้เริ่มจัดหมวดใหม่จากข้อความถัดไปของลูกค้าล้วนๆ กันหลุดมาเป็นหมวดผิดซ้ำอีก
  collected.intent_category = null;
  session.lastLead = null;
  session.fallbackCount = 0;
  session.locationBranchIntroDone = false;
  session.serviceBranchIntroDone = false;

  return "ขอโทษด้วยนะคะ 🙏 แอดมินยกเลิกคิวเดิมที่ส่งผิดแผนกให้แล้วนะคะ รบกวนแจ้งอีกครั้งได้ไหมคะว่าต้องการเรื่องอะไหล่/บริการซ่อม หรือเรื่องซื้อ-เทิร์นรถคะ แอดมินจะส่งให้ทีมที่ถูกต้องทันทีเลยค่ะ";
}

// ลูกค้าที่มี Lead ซื้อรถใหม่/เทิร์นรถอยู่แล้ว (session.lastLead) ขอเปลี่ยนไปสาขาอื่น (เช่น "ขอเปลี่ยนสาขา" ตามด้วย "มีที่ไหนใกล้ผมสุด")
// เดิมไม่มีการจัดการเคสนี้เลย ทำให้ระบบเงียบๆ สร้าง Lead ใหม่ซ้ำที่ "สาขาเดิม" อีกใบ (ไม่ตอบคำถามเรื่องสาขาใกล้สุดเลยด้วย) -> แก้ให้ยกเลิก
// Lead เดิมจริงๆ ก่อน แล้วค่อยหาสาขาใหม่ให้ (จับชื่อสาขาตรงๆ ก่อน ถ้าไม่มีค่อยหาใกล้สุดจากพิกัดที่เคยแจ้งไว้ ไม่นับสาขาเดิม)
async function handleLeadBranchChange({ collected, session, rawMessage, platform, userId, customerName }) {
  const oldLead = session.lastLead;
  const branches = await store.getActiveBranches();
  const otherBranches = branches.filter((b) => b.id !== oldLead.branchId);

  let newBranch = matchBranchFromText(rawMessage || "", otherBranches.map((b) => ({ branchId: b.id, branchName: b.name })));

  if (!newBranch && collected.location_text) {
    const geo = await geocode(collected.location_text);
    if (geo && isServiceArea(geo.province)) {
      const ranked = otherBranches
        .filter((b) => b.lat && b.long)
        .map((b) => ({ branch: b, distanceKm: haversineKm(geo.lat, geo.long, Number(b.lat), Number(b.long)) }))
        .sort((a, b) => a.distanceKm - b.distanceKm);
      const top2 = ranked.slice(0, 2).map((r) => r.branch);
      if (top2.length === 1) {
        newBranch = { branchId: top2[0].id, branchName: top2[0].name };
      } else if (top2.length > 1) {
        session.pendingLeadBranchChange = true;
        session.pendingBranchChoiceIds = top2.map((b) => b.id);
        const names = top2.map((b) => b.name).join(" หรือ ");
        return `แอดมินเช็คแผนที่ให้แล้วค่ะ 😊 ใกล้พี่ที่สุด (ไม่นับสาขาเดิม) มี 2 สาขาเลยคือ ${names} พี่สะดวกเปลี่ยนไปสาขาไหนดีคะ`;
      }
    }
  }

  if (!newBranch) {
    const names = otherBranches.map((b) => b.name).join(" หรือ ");
    session.pendingLeadBranchChange = true;
    session.pendingBranchChoiceIds = otherBranches.map((b) => b.id);
    return `รบกวนแอดมินขอทราบอีกครั้งนะคะ พี่อยากเปลี่ยนไปสาขาไหนดีระหว่าง ${names} คะ 🙏`;
  }

  return finalizeLeadBranchChange({ collected, session, rawMessage, platform, userId, customerName, newBranchId: newBranch.branchId });
}

// ยกเลิก Lead เดิมจริงๆ (คืนคิวให้เซลคนเดิม แจ้งเซลคนเดิมว่ายกเลิกแล้ว) แล้วสร้าง Lead ใหม่ที่สาขาที่ลูกค้าเพิ่งเลือก
async function finalizeLeadBranchChange({ collected, session, rawMessage, platform, userId, customerName, newBranchId }) {
  const oldLead = session.lastLead;

  await store.cancelLead(oldLead.leadId);
  if (oldLead.intentCategory === "trade_in") {
    await store.decrementOpenTradeInCount(oldLead.staffId);
  } else {
    await store.decrementOpenLeadsCount(oldLead.staffId);
  }
  const oldStaff = await store.findStaffById(oldLead.staffId);
  if (oldStaff) {
    await notifyStaffDirect(
      oldStaff,
      "❌ ยกเลิก Lead (ลูกค้าขอเปลี่ยนไปสาขาอื่นแทน)\nLead ID เดิม: " + oldLead.leadId,
      oldLead.leadId,
      oldLead.branchId
    );
  }

  session.confirmedGeneralBranchId = newBranchId;
  session.pendingBranchChoiceIds = null;
  session.pendingLeadBranchChange = false;
  session.lastLead = null;
  session.fallbackCount = 0;

  return handleSalesHandoff({
    collected,
    session,
    rawMessage,
    intent: oldLead.intentCategory || collected.intent_category || "buying_new",
    platform,
    userId,
    customerName,
    replyContext: null,
    highIntent: false,
  });
}

function normalizeDate(text) {
  if (!text) return "";
  const m = text.match(/\d{4}-\d{2}-\d{2}/);
  if (!m) return text.trim();
  const timeMatch = text.match(/ช่วงเช้า|ช่วงบ่าย|ช่วงเย็น|เช้า|บ่าย|เย็น|\d{1,2}[:.]\d{2}|\d{1,2}\s*โมง/);
  return timeMatch ? `${m[0]} ${timeMatch[0]}` : m[0];
}

// สร้างข้อความสรุปงานค้างเก่าที่ยังไม่มีใครกดรับทราบ (ถ้ามี) แปะไว้ก่อนงานใหม่เสมอ พร้อมเลขที่งานแต่ละอันแยกชัดเจน
// ใช้คู่กับปุ่ม quick reply หลายปุ่มใน pushMessageWithAck เพื่อให้กดรับทราบแต่ละงานแยกกันได้จริงแม้เป็นงานเก่าที่เคยแจ้งไปแล้วก่อนหน้านี้
// (กันบั๊กที่เจอจริง: LINE โชว์ปุ่ม quick reply แค่ของข้อความล่าสุดเท่านั้น พองานใหม่เข้ามาปุ่มของงานเก่าที่ยังไม่รับทราบจะกดไม่ได้อีกเลย)
function buildPendingJobsSection(pendingRefs) {
  if (!pendingRefs.length) return "";
  const lines = pendingRefs
    .map((p, i) => {
      const typeLabel = p.type === "booking" ? "นัดซ่อม" : "Lead";
      return `#${i + 1}) [${typeLabel}] ลูกค้า: ${p.customerName || "-"} | เรื่อง: ${p.detail || "-"} | เลขที่: ${p.refId}`;
    })
    .join("\n");
  return (
    "⚠️ มีงานค้างที่ยังไม่มีใครกดรับทราบอยู่ก่อนหน้านี้ด้วยนะคะ (" + pendingRefs.length + " งาน):\n" +
    lines +
    "\n\n———————————\n\n"
  );
}

// ส่งแจ้งเตือน Lead ตรงถึงไลน์ส่วนตัวเซล พร้อมปุ่ม "รับทราบแล้ว" (ผูกกับ leadId) ถ้าเซลยังไม่ได้ลงทะเบียนไลน์
// ให้ fallback ไปแจ้งหัวหน้าสาขา (role=supervisor ในแท็บ Staff) แทนทันที (พร้อมปุ่มรับทราบเช่นกัน ผูกกับ leadId เดียวกัน)
// ก่อนส่งจะเช็คก่อนว่าเซลคนนี้มีงานอื่นค้างไม่รับทราบอยู่ไหม ถ้ามีจะรวมมาแสดงในข้อความเดียวกันพร้อมปุ่มรับทราบแยกทุกงาน
// branchId: สาขาที่งาน/lead นี้ผูกอยู่จริงๆ (ต้องระบุชัดเจน ห้ามใช้ staff.branchId ตรงๆ เพราะพนักงาน 1 คนอาจดูแลได้หลายสาขา
// ("NM90,LL4") ถ้าไม่ระบุมา จะ fallback ไปใช้สาขาแรกของพนักงานคนนั้น (เผื่อเรียกจากจุดเก่าที่ยังไม่ได้ส่งมา)
async function notifyStaffDirect(staff, text, leadId, branchId) {
  const effectiveBranchId = branchId || store.getStaffBranchIds(staff)[0] || staff.branchId;
  const pending = await store.getPendingRefsForStaff(staff.name, effectiveBranchId, leadId);
  const newJobLabel = pending.length ? `#${pending.length + 1}) ` : "";
  const fullText = buildPendingJobsSection(pending) + newJobLabel + text;
  const allIds = [...pending.map((p) => p.refId), leadId];

  if (staff.lineUserId) {
    try {
      await line.pushMessageWithAck(staff.lineUserId, fullText, allIds);
      return;
    } catch (err) {
      console.error("[router] pushMessageWithAck error:", err.message);
    }
  } else {
    console.warn(`[router] พนักงาน ${staff.name} (${staff.id}) ยังไม่ได้ลงทะเบียน lineUserId`);
  }
  const supervisor = await store.getSupervisorForBranch(effectiveBranchId);
  if (supervisor && supervisor.lineUserId) {
    try {
      await line.pushMessageWithAck(supervisor.lineUserId, `⚠️ (เซล ${staff.name} ยังไม่ได้ลงทะเบียนไลน์) ` + fullText, allIds);
      return;
    } catch (err) {
      console.error("[router] notifyStaffDirect supervisor fallback error:", err.message);
    }
  } else {
    console.warn(`[router] สาขา ${effectiveBranchId} ยังไม่ได้ลงทะเบียนหัวหน้าสาขา (role=supervisor) ข้อความหลุด:`, text);
  }
}

// ส่งแจ้งเตือนนัดซ่อมตรงถึงไลน์ส่วนตัวทีมอะไหล่ที่ถูกเลือกจากคิว (role=parts) พร้อมปุ่ม "รับทราบแล้ว" (ผูกกับ bookingId)
// ถ้าคนนั้นยังไม่ได้ลงทะเบียนไลน์ หรือสาขานั้นไม่มีทีมอะไหล่เลย ให้ fallback ไปแจ้งหัวหน้าสาขาแทนทันที (พร้อมปุ่มรับทราบเช่นกัน)
// เช็คงานค้างเก่าของทีมอะไหล่คนนี้เหมือนกับ notifyStaffDirect ก่อนส่งเสมอ
async function notifyPartsDirect(branch, partsStaff, text, bookingId) {
  const pending = partsStaff ? await store.getPendingRefsForStaff(partsStaff.name, branch.id, bookingId) : [];
  const newJobLabel = pending.length ? `#${pending.length + 1}) ` : "";
  const fullText = buildPendingJobsSection(pending) + newJobLabel + text;
  const allIds = [...pending.map((p) => p.refId), bookingId];

  if (partsStaff && partsStaff.lineUserId) {
    try {
      await line.pushMessageWithAck(partsStaff.lineUserId, fullText, allIds);
      return;
    } catch (err) {
      console.error("[router] notifyPartsDirect pushMessageWithAck error:", err.message);
    }
  } else if (partsStaff) {
    console.warn(`[router] ทีมอะไหล่ ${partsStaff.name} (${partsStaff.id}) ยังไม่ได้ลงทะเบียน lineUserId`);
  } else {
    console.warn(`[router] สาขา ${branch.name} (${branch.id}) ไม่มีทีมอะไหล่ (role=parts) ในระบบเลย`);
  }
  const supervisor = await store.getSupervisorForBranch(branch.id);
  if (supervisor && supervisor.lineUserId) {
    try {
      await line.pushMessageWithAck(supervisor.lineUserId, "⚠️ (ทีมอะไหล่ยังไม่ได้ลงทะเบียนไลน์) " + fullText, allIds);
      return;
    } catch (err) {
      console.error("[router] notifyPartsDirect supervisor fallback error:", err.message);
    }
  } else {
    console.warn(`[router] สาขา ${branch.name} (${branch.id}) ยังไม่ได้ลงทะเบียนหัวหน้าสาขา (role=supervisor) ข้อความหลุด:`, text);
  }
}

module.exports = { handleTurn };
