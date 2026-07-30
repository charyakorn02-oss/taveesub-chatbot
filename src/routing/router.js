// หัวใจของระบบ: ตัดสินใจว่าถามต่อ หรือจะส่งต่อ (handoff) ให้เซล/ช่าง พร้อมหาสาขา+พนักงานที่เหมาะสม
"use strict";

const store = require("../services/store");
const { geocode, isServiceArea, haversineKm } = require("../services/geocode");
const line = require("../services/line");
const bitrix24 = require("../services/bitrix24");

const HIGH_INTENT_KEYWORDS = ["จอง", "มัดจำ", "โอนเงิน", "จัดไฟแนนซ์", "ส่งเอกสาร"];
const FALLBACK_LIMIT = 2;
// ขยายให้ครอบคลุมกรณีลูกค้าที่มี Lead อยู่แล้วถามถึงสาขาอื่น/สาขาใกล้ตัวเอง (เช่น "มีสาขาไหนบ้าง แถวๆ...ไปไหนใกล้สุด")
// แม้จะไม่ได้พิมพ์คำว่า "เปลี่ยนสาขา" ตรงๆ ก็ตาม เพราะเข้าเงื่อนไขนี้ได้เฉพาะตอนมี session.lastLead อยู่แล้วเท่านั้น (ลูกค้าเก่า) จึงปลอดภัยที่จะตีความกว้างขึ้น
const BRANCH_CHANGE_KEYWORDS = /เปลี่ยนสาขา|เปลี่ยนที่ซ่อม|ขอเปลี่ยนสาขา|สาขาอื่นแทน|เปลี่ยนเป็นสาขา|เปลี่ยนไปสาขา|สาขาไหนบ้าง|สาขาไหนใกล้|ใกล้ที่สุด|ใกล้สุด|สาขาอื่น/;
const WRONG_DEPARTMENT_KEYWORDS = /ส่งผิดแผนก|ส่งผิดคน|ผิดแผนก|ไม่ใช่ฝ่ายขาย|ไม่ใช่เซล|ไม่ใช่แผนกขาย|ส่งผิด/;
const SAME_AS_BEFORE_KEYWORDS = /เหมือนเดิม|ที่เดิม|เบอร์เดิม|สาขาเดิม|อันเดิม|ข้อมูลเดิม|^ใช่ค่ะ$|^ใช่ครับ$|^ใช่$|^ยืนยัน|^ตกลง|^โอเค|^ok/i;

function containsHighIntentKeyword(text) {
  if (!text) return false;
  return HIGH_INTENT_KEYWORDS.some((k) => text.includes(k));
}

function guessIntentFromText(text) {
  if (!text) return null;
  if (/ซ่อม|เช็คระยะ|อะไหล่|คิวซ่อม|นัดซ่อม|เข้าศูนย์/.test(text)) return "service";
  if (/เทิร์นรถ|เทิร์น|แลกรถ|ขายรถเก่า/.test(text)) return "trade_in";
  if (/ซื้อรถ|ออกรถ|จองรถ|ดาวน์รถ|สนใจรุ่น/.test(text)) return "buying_new";
  return null;
}

function intentKeywordMatches(intent, text) {
  if (!text) return false;
  if (intent === "service") return /ซ่อม|เช็คระยะ|อะไหล่|คิวซ่อม|นัดซ่อม|เข้าศูนย์/.test(text);
  if (intent === "trade_in") return /เทิร์นรถ|เทิร์น|แลกรถ|ขายรถเก่า/.test(text);
  if (intent === "buying_new") return /ซื้อรถ|ออกรถ|จองรถ|ดาวน์รถ|สนใจรุ่น|คันใหม่|รถใหม่/.test(text);
  return true;
}

function normalizeBranchNameForMatch(name) {
  return (name || "")
    .replace(/^สาขา/, "")
    .replace(/\(.*?\)/g, "")
    .trim();
}

// ดึงเลขทั้งหมดที่ปรากฏในข้อความ/ชื่อสาขา (เช่น "นวมินทร์ 90" -> ["90"], "สาขา 90" -> ["90"])
function extractNumbers(str) {
  return (str || "").match(/\d+/g) || [];
}
function matchBranchFromText(rawText, options) {
  if (!rawText) return null;
  // กันบั๊กที่เจอจริง: ลูกค้าพิมพ์ย่อ "สนง." แทน "สำนักงาน" (เช่น "สนง.ใหญ่" แทน "สำนักงานใหญ่") ทำให้จับคู่ชื่อสาขาไม่เจอ
  // เดิมไม่มีการขยายคำย่อนี้เลย ทำให้ระบบต้องไปเดาจาก Google Maps แทน (ซึ่งบางทีเดาผิดไปสาขาอื่นที่ใกล้เคียงกันแทน)
  const text = rawText.replace(/สนง\./g, "สำนักงาน");
  const trimmed = text.trim();
  const direct = options.find((o) => {
      const full = o.branchName || "";
      const core = normalizeBranchNameForMatch(full);
      return (
        text.includes(full) ||
        (core && text.includes(core)) ||
        (core && trimmed.length >= 3 && full.includes(trimmed))
      );
  });
  if (direct) return direct;

  // กันบั๊กที่เจอจริง: ลูกค้าตอบสั้นๆ แค่เลขสาขา (เช่น "สาขา 90" หรือ "90" เฉยๆ) โดยไม่พิมพ์ชื่อเต็ม "นวมินทร์ 90"
  // ทำให้จับคู่แบบชื่อเต็มด้านบนไม่เจอเลย กลายเป็นถามซ้ำวนไม่จบ -> ลองเทียบเลขในข้อความลูกค้ากับเลขในชื่อแต่ละตัวเลือกแทน
  // ทำเฉพาะตอนมีตัวเลือกที่เลขตรงกันแค่ตัวเดียวเท่านั้น (กันเลขชนกันเวลามีหลายสาขาเลขซ้ำ)
  const textNumbers = extractNumbers(text);
  if (textNumbers.length > 0) {
    const numMatches = options.filter((o) => {
      const branchNumbers = extractNumbers(o.branchName || "");
      return branchNumbers.some((n) => textNumbers.includes(n));
    });
    if (numMatches.length === 1) return numMatches[0];
  }
  return null;
}

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
      if (session) session.pendingBranchChoiceIds = top2.map((b) => b.id);
      const names = top2.map((b) => b.name).join(" หรือ ");
      return `แอดมินเช็คแผนที่ให้แล้วค่ะ 😊 ใกล้พี่ที่สุดมี 2 สาขาเลยคือ ${names} พี่สะดวกไปสาขาไหนดีคะ หรือสนใจให้จัดส่งถึงบ้านแทนก็ได้นะคะ (จัดส่งฟรีในระยะ 25 กม. จากสาขา และทำสัญญาซื้อขายให้ฟรีทั่วประเทศค่ะ)`;
    }
  }

  if (session) {
    session.pendingBranchChoiceIds = branches.map((b) => b.id);
  }
  const allNames = branches.map((b) => `- ${b.name}`).join("\n");
  return `ขอบคุณที่แจ้งพื้นที่มานะคะ 😊 พอดีแอดมินเช็คแผนที่จากข้อมูลที่พี่ให้มายังไม่ชัดเจนพอที่จะเช็คสาขาใกล้พี่ที่สุดได้เลยค่ะ ถ้าสะดวกรบกวนพี่บอกรายละเอียดเพิ่มอีกนิดได้ไหมคะ (เช่น ชื่อถนน แขวง/เขต หรือจุดสังเกตใกล้เคียง) แอดมินจะได้แนะนำสาขาที่ใกล้พี่ที่สุดให้ถูกต้องเลยค่ะ\n\nเบื้องต้นนี่คือสาขาทั้งหมดของทวีทรัพย์นะคะ:\n${allNames}\n\nพี่สะดวกไปรับรถที่สาขาไหนดีคะ หรือสนใจให้จัดส่งถึงบ้านแทนก็ได้นะคะ (จัดส่งฟรีในระยะ 25 กม. จากสาขา และทำสัญญาซื้อขายให้ฟรีทั่วประเทศค่ะ)`;
}

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

  const hq = branches.find((b) => (b.name || "").includes("สำนักงานใหญ่")) || branches[0] || null;
  if (hq) session.confirmedServiceBranchId = hq.id;
  return null;
}

async function handleTurn({ session, analysis, rawMessage, platform, userId, customerName, replyContext }) {
  const collected = session.collected;
  const oldLocationTextBeforeMerge = collected.location_text || null;
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
      let v = analysis[f];
      // บั๊กที่เจอจริง: บางครั้ง Claude ตัดเลข 0 หน้าเบอร์โทรทิ้ง (เช่น "0809369836" กลายเป็น "809369836")
      // เช็คว่าถ้าเป็นเลขล้วน 9 หลัก ขึ้นต้นด้วย 6/8/9 (รูปแบบเบอร์มือถือไทยที่ขาด 0 นำหน้า) ให้เติม 0 กลับให้อัตโนมัติ
      if (f === "phone" && typeof v === "string") {
        const digitsOnly = v.replace(/\D/g, "");
        if (/^[689]\d{8}$/.test(digitsOnly)) v = "0" + digitsOnly;
        else v = digitsOnly || v;
      }
      collected[f] = v;
    }
  });

  if (analysis.intent_category) {
    const newIntent = analysis.intent_category;
    const oldIntent = collected.intent_category;
    if (!oldIntent || newIntent === oldIntent || intentKeywordMatches(newIntent, rawMessage)) {
      collected.intent_category = newIntent;
    }
  }

  if (analysis.location_text) {
    session.locationSetForIntent = collected.intent_category;
  }

  // บั๊กที่เจอจริง: ลูกค้าเคยบอกที่อยู่/พื้นที่ไว้แล้ว ระบบยึดสาขาที่เคยจับคู่ไว้ (session.confirmedGeneralBranchId/confirmedServiceBranchId)
  // ต่อไปเรื่อยๆ แม้ลูกค้าจะพิมพ์บอกที่อยู่ใหม่ที่ "ไม่ใช่ที่เดิม" มาในภายหลัง -> ต้องล้างสาขาที่เคยจับคู่ไว้ทิ้ง แล้วปล่อยให้ระบบ
  // ค้นหา/แนะนำสาขาใหม่จากที่อยู่ล่าสุดที่ลูกค้าเพิ่งบอกแทน (ยึดที่อยู่ล่าสุดเสมอ ไม่ใช่ที่อยู่แรกที่เคยพิมพ์มา)
  if (
    analysis.location_text &&
    oldLocationTextBeforeMerge &&
    analysis.location_text.trim() !== oldLocationTextBeforeMerge.trim() &&
    !SAME_AS_BEFORE_KEYWORDS.test(rawMessage || "")
  ) {
    session.confirmedGeneralBranchId = null;
    session.confirmedServiceBranchId = null;
    session.locationBranchIntroDone = false;
    session.serviceBranchIntroDone = false;
    session.pendingBranchChoiceIds = null;
    session.pendingServiceBranchIds = null;
  }

  if (session.lastServiceBooking && BRANCH_CHANGE_KEYWORDS.test(rawMessage || "")) {
    session.fallbackCount = 0;
    return handleServiceBranchChange({ collected, session, rawMessage, platform, userId, customerName });
  }

  if (session.lastLead && WRONG_DEPARTMENT_KEYWORDS.test(rawMessage || "")) {
    session.fallbackCount = 0;
    return handleLeadReroute({ collected, session, rawMessage, platform, userId, customerName });
  }

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

  if (session.lastLead && BRANCH_CHANGE_KEYWORDS.test(rawMessage || "")) {
    session.fallbackCount = 0;
    return handleLeadBranchChange({ collected, session, rawMessage, platform, userId, customerName });
  }

  if (!session.historyChecked) {
    session.historyChecked = true;
    try {
      session.knownHistory = await store.getLatestCustomerRecord(userId);
    } catch (err) {
      console.error("[router] getLatestCustomerRecord error:", err.message);
      session.knownHistory = null;
    }
  }

  if (session.pendingHistoryConfirm) {
    const pendingHist = session.pendingHistoryConfirm;
    session.pendingHistoryConfirm = null;
    if (SAME_AS_BEFORE_KEYWORDS.test(rawMessage || "")) {
      if (pendingHist.phone && !collected.phone) {
        collected.phone = pendingHist.phone;
      }
      if (pendingHist.staffId) {
        session.pinnedStaffId = pendingHist.staffId;
      } else if (pendingHist.branchId && !collected.location_text && !collected.requested_staff_name) {
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

  if (
    collected.intent_category === "buying_new" &&
    collected.location_text &&
    !collected.requested_staff_name &&
    !collected.delivery_preference &&
    !session.locationBranchIntroDone
  ) {
    const branchesForDirectMatch = await store.getActiveBranches();
    const directMatch = matchBranchFromText(
      collected.location_text,
      branchesForDirectMatch.map((b) => ({ branchId: b.id, branchName: b.name }))
    );
    if (directMatch) {
      session.confirmedGeneralBranchId = directMatch.branchId;
      session.locationBranchIntroDone = true;
      // บั๊กที่เจอจริง: เดิมตรงนี้ auto-default เป็น "pickup_at_branch" ทันทีเงียบๆ โดยไม่เคยถามลูกค้าเลยว่าจะมารับเองหรือให้จัดส่ง
      // ทำให้ระบบข้ามคำถามสำคัญนี้ไปตลอด (ดูเงื่อนไข needsSalesEssentials ด้านล่างที่บังคับให้ถามก่อน handoff เสมอ)
    } else {
      const introReply = await introduceNearestBranches(collected.location_text, session);
      if (introReply) {
        session.locationBranchIntroDone = true;
        session.fallbackCount = 0;
        return introReply;
      }
    }
  }

  const needsBranchVisit = collected.intent_category === "service" || collected.intent_category === "trade_in";
  const locationIsCarryOver =
    collected.location_text &&
    session.locationSetForIntent &&
    session.locationSetForIntent !== collected.intent_category;

  if (needsBranchVisit && locationIsCarryOver && session.locationConfirmedForIntent !== collected.intent_category) {
    if (session.pendingLocationReconfirmIntent === collected.intent_category) {
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

  if (
    collected.intent_category === "service" &&
    collected.location_text &&
    !collected.requested_staff_name &&
    !session.serviceBranchIntroDone
  ) {
    // บั๊กที่เจอจริง: ลูกค้าระบุชื่อสาขาตรงๆ อยู่แล้ว (เช่น "สนง.ใหญ่" "สำนักงานใหญ่" "คลอง4") แต่ระบบไม่เช็คชื่อตรงๆ ก่อน
    // ไปเข้า Google Maps geocode ทันที ซึ่งบางครั้งเดาที่อยู่ผิดเพี้ยนไปสาขาอื่นที่ใกล้เคียงกันแทน (ส่งซ่อมผิดสาขาไปจากที่ลูกค้าขอ)
    // -> เช็คชื่อสาขาตรงๆ จากข้อความลูกค้าก่อนเสมอ เหมือนที่ทำกับ buying_new ด้านบน ถ้าเจอให้ใช้เลย ไม่ต้อง geocode เดาอีก
    const branchesForServiceDirectMatch = await store.getActiveBranches();
    const serviceDirectMatch = matchBranchFromText(
      collected.location_text,
      branchesForServiceDirectMatch.map((b) => ({ branchId: b.id, branchName: b.name }))
    );
    if (serviceDirectMatch) {
      session.confirmedServiceBranchId = serviceDirectMatch.branchId;
      session.serviceBranchIntroDone = true;
    } else {
      const introReply = await introduceNearestServiceBranch(collected.location_text, session);
      if (introReply) {
        session.serviceBranchIntroDone = true;
        session.fallbackCount = 0;
        return introReply;
      }
    }
  }

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
      session.pendingServiceBranchAskCount = (session.pendingServiceBranchAskCount || 0) + 1;
      if (session.pendingServiceBranchAskCount <= 1) {
        const names = candidates.map((b) => b.name).join(" หรือ ");
        return `รบกวนแอดมินขอทราบอีกครั้งนะคะ สะดวกนำรถเข้าซ่อมสาขาไหนดีระหว่าง ${names} คะ 🙏`;
      }
      session.pendingServiceBranchIds = null;
      session.pendingServiceBranchAskCount = 0;
      return analysis.reply_text_to_customer || "รับทราบค่ะ 😊 มีอะไรให้แอดมินช่วยเพิ่มเติมไหมคะ";
    }
  }

  if (collected.intent_category === "buying_new" && session.pendingBranchChoiceIds && session.pendingBranchChoiceIds.length > 0) {
    const branchesForPending = await store.getActiveBranches();
    const candidates = session.pendingBranchChoiceIds.map((id) => branchesForPending.find((b) => b.id === id)).filter(Boolean);
    const matched = matchBranchFromText(rawMessage || "", candidates.map((b) => ({ branchId: b.id, branchName: b.name })));
    if (matched) {
      session.pendingBranchChoiceIds = null;
      session.confirmedGeneralBranchId = matched.branchId;
      // บั๊กที่เจอจริง: เดิมตรงนี้ก็ auto-default delivery_preference เงียบๆ เช่นกัน ไม่เคยถามลูกค้า (ดู needsSalesEssentials ด้านล่าง)
      session.fallbackCount = 0;
    }
  }

  const highIntent = analysis.high_intent_keyword || containsHighIntentKeyword(rawMessage);

  const effectiveIntent = collected.intent_category || guessIntentFromText(rawMessage);
  const needsBranchInfo =
    (effectiveIntent === "service" || effectiveIntent === "trade_in" || effectiveIntent === "buying_new") &&
    !collected.location_text &&
    !collected.requested_staff_name &&
    !session.confirmedServiceBranchId &&
    !session.confirmedGeneralBranchId;

  if (
    session.knownHistory &&
    !session.historyConfirmAsked &&
    (effectiveIntent === "service" || effectiveIntent === "trade_in" || effectiveIntent === "buying_new") &&
    (needsBranchInfo || !collected.phone)
  ) {
    session.historyConfirmAsked = true;
    const hist = session.knownHistory;
    const histBranch = hist.branchId ? await store.getBranchById(hist.branchId) : null;
    const histStaff = hist.staffId ? await store.findStaffById(hist.staffId) : null;
    const histStaffActive = histStaff && String(histStaff.active).toUpperCase() === "TRUE";
    const detailParts = [];
    if (histStaffActive) {
      detailParts.push(`เซล ${histStaff.name}`);
    } else if (histBranch) {
      detailParts.push(`สาขา ${histBranch.name}`);
    }
    if (hist.phone) detailParts.push(`เบอร์ ${hist.phone}`);
    if (detailParts.length > 0) {
      session.fallbackCount = 0;
      session.pendingHistoryConfirm = {
        branchId: histBranch ? histBranch.id : null,
        phone: hist.phone || null,
        staffId: histStaffActive ? hist.staffId : null,
      };
      const historyQuestion = histStaffActive
        ? `แอดมินเห็นว่าพี่เคยคุยกับเซล ${histStaff.name} มาก่อนนะคะ 😊 สนใจคุยกับคนเดิมที่สาขานี้เลยไหมคะ`
        : `แอดมินเห็นว่าพี่เคยติดต่อร้านเรามาก่อนนะคะ 😊 ครั้งก่อนพี่ใช้ ${detailParts.join(" และ ")} ใช่ไหมคะ พี่สะดวกใช้ข้อมูลเดิมนี้ต่อเลย หรือมีอันใหม่สะดวกกว่าแจ้งแอดมินได้เลยค่ะ`;
      const baseReply = (analysis.reply_text_to_customer || "").trim();
      return baseReply ? `${baseReply}\n\n${historyQuestion}` : historyQuestion;
    }
  }

  const needsServiceEssentials =
    effectiveIntent === "service" && (!collected.phone || !collected.preferred_date || needsBranchInfo);

  const needsSalesEssentials =
    (effectiveIntent === "buying_new" || effectiveIntent === "trade_in") &&
    (needsBranchInfo || !collected.phone || (effectiveIntent === "buying_new" && !collected.delivery_preference));

  const hasPhone = Boolean(collected.phone);
  const claudeSaysComplete = Boolean(analysis.data_complete) && hasPhone;
  // บั๊กที่เจอจริง: เคย handoff ส่ง lead ไปแล้วรอบนึง (ข้อมูลลูกค้า/สาขา/เบอร์ครบหมดแล้วจากตอนนั้น) พอลูกค้าทักมาใหม่ถามคำถามธรรมดา
  // (เช่น "เช็คระยะกี่กิโล") ระบบเห็นว่า data ครบอยู่แล้ว (claudeSaysComplete) เลยส่ง lead ซ้ำอัตโนมัติทันทีโดยไม่ได้ตอบคำถามลูกค้าเลย
  // -> ถ้าเคย handoff ไปแล้ว จะ handoff ซ้ำได้อีกครั้งเฉพาะตอนที่ "รอบนี้" มีสัญญาณ high-intent ใหม่จริงๆ เท่านั้น (เช่น "จอง", "โอนเงิน")
  // ไม่ใช่แค่เพราะข้อมูลเก่ายังครบอยู่เฉยๆ กรณีอื่นให้ตอบคำถามลูกค้าไปตามปกติก่อน ไม่ต้องส่ง lead ซ้ำ
  // สำคัญมาก: ใช้ session.leadEverSent (ไม่ใช่ session.handedOff!) เพราะ session.handedOff เป็นฟิลด์คนละความหมายที่มีอยู่แล้ว
  // ใน lineWebhook.js/facebookWebhook.js (เช็คว่า "พนักงานรับช่วงคุยเองแล้ว ให้บอทหยุดตอบถาวร") ถ้าตั้งชื่อชนกันจะทำให้บอทเงียบไม่ตอบอะไรเลย
  // ทุกข้อความถัดไปหลัง handoff ครั้งแรก (บั๊กที่เจอจริงหลัง deploy fix นี้ครั้งก่อน — พิมพ์ไปไม่มีอะไรตอบกลับเลย)
  const alreadyHandedOff = Boolean(session.leadEverSent);
  // สำคัญมาก: ตอน alreadyHandedOff แล้ว ห้ามใช้ analysis.high_intent_keyword (ที่ Claude ประเมินเอง) เด็ดขาด เพราะเจอบั๊กจริง
  // Claude มักประเมิน high_intent_keyword=true ผิดพลาดให้กับคำถามธรรมดา (เช่น "เช็คระยะกี่กิโล") ทำให้ยังส่ง lead ซ้ำอยู่ดี
  // ต้องใช้แค่ containsHighIntentKeyword (regex คำชัดเจนตายตัวอย่าง "จอง"/"โอนเงิน") เท่านั้นถึงจะยอมส่งซ้ำได้
  const explicitHighIntent = containsHighIntentKeyword(rawMessage);
  const shouldHandoff =
    !needsServiceEssentials &&
    !needsSalesEssentials &&
    hasPhone &&
    (alreadyHandedOff
      ? explicitHighIntent
      : (claudeSaysComplete || (highIntent && !needsBranchInfo) || session.fallbackCount >= FALLBACK_LIMIT));

  if (!shouldHandoff) {
    session.fallbackCount = (session.fallbackCount || 0) + 1;
    return (
      analysis.reply_text_to_customer ||
      "ขอบคุณที่บอกแอดมินนะคะ 😊 เดี๋ยวแอดมินรับเรื่องต่อให้เลยนะคะ ขอทราบเบอร์ติดต่อกลับได้ไหมคะ 🙏"
    );
  }

  session.fallbackCount = 0;
  return performHandoff({
    collected,
    session,
    rawMessage,
    platform,
    userId,
    customerName,
    replyContext,
    highIntent,
    naturalReply: analysis.reply_text_to_customer,
  });
}

async function performHandoff({ collected, session, rawMessage, platform, userId, customerName, replyContext, highIntent, naturalReply }) {
  const intent = collected.intent_category || guessIntentFromText(rawMessage) || "general";
  if (intent !== collected.intent_category) {
    collected.intent_category = intent;
  }
  // จำไว้ว่าเคย handoff (ส่ง lead) ไปแล้วในเซสชันนี้ กันบั๊กส่ง lead ซ้ำจากข้อมูลเก่า (ดูเงื่อนไข alreadyHandedOff ด้านบน)
  session.leadEverSent = true;

  if (intent === "buying_new" || intent === "trade_in") {
    return handleSalesHandoff({ collected, session, rawMessage, intent, platform, userId, customerName, replyContext, highIntent, naturalReply });
  }
  if (intent === "service") {
    let forcedBranch = null;
    if (session.confirmedServiceBranchId) {
      forcedBranch = await store.getBranchById(session.confirmedServiceBranchId);
    }
    return handleServiceHandoff({ collected, session, platform, userId, customerName, replyContext, forcedBranch, naturalReply });
  }
  return handleGeneralHandoff({ collected, session, rawMessage, platform, userId, customerName });
}

function resolveCustomerName(collected, customerName) {
  return collected.customer_name || customerName || "";
}

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

async function handleGeneralHandoff({ collected, session, rawMessage, platform, userId, customerName }) {
  const finalCustomerName = resolveCustomerName(collected, customerName);
  const branch = await resolveGeneralBranch(collected);

  if (!branch) {
    return "แอดมินรับเรื่องไว้แล้วนะคะ เดี๋ยวให้ทีมงานติดต่อกลับไปนะคะ ขอบคุณที่ทักมาคุยกับแอดมินนะคะ 🙏";
  }

  let assignedStaff = null;
  if (session && session.pinnedStaffId) {
    const pinned = await store.findStaffById(session.pinnedStaffId);
    session.pinnedStaffId = null;
    if (pinned && String(pinned.active).toUpperCase() === "TRUE") {
      assignedStaff = pinned;
    }
  }
  if (!assignedStaff) {
    assignedStaff = await store.getSupervisorForBranch(branch.id);
  }

  const lead = {
    platform,
    customerId: userId,
    customerName: finalCustomerName,
    intentCategory: "general",
    modelOrIssue: collected.model_or_issue || rawMessage || "(คำถามที่แอดมินตอบเองไม่ได้ ดูข้อความลูกค้าประกอบ)",
    branchId: branch.id,
    staffId: assignedStaff ? assignedStaff.id : "",
    staffName: assignedStaff ? assignedStaff.name : "",
    staffPhone: assignedStaff ? assignedStaff.phone : "",
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

  if (assignedStaff && assignedStaff.lineUserId) {
    try {
      await line.pushMessageWithAck(assignedStaff.lineUserId, notifyText, leadId);
    } catch (err) {
      console.error("[router] handleGeneralHandoff notify error:", err.message);
    }
  } else {
    console.warn(`[router] สาขา ${branch.id} ไม่มีคนรับผิดชอบที่ลงทะเบียน LINE ไว้ ข้อความหลุด:`, notifyText);
  }

  if (assignedStaff) {
    return (
      `รับทราบค่ะ 😊 เดี๋ยวแอดมินให้คุณ ${assignedStaff.name} ติดต่อกลับไปนะคะ\n` +
      `เบอร์ติดต่อ: ${assignedStaff.phone || "รอเบอร์ติดต่อ"}\n\n` +
      `ขอบคุณที่ไว้วางใจทวีทรัพย์ยานยนต์ค่ะ 🙏`
    );
  }
  return "แอดมินรับเรื่องไว้แล้วนะคะ 😊 เดี๋ยวให้ทีมงานที่ดูแลสาขานี้ช่วยตอบละเอียดอีกทีนะคะ ขอบคุณที่ทักมาคุยกับแอดมินนะคะ 🙏";
}

async function handleSalesHandoff({ collected, session, rawMessage, intent, platform, userId, customerName, replyContext, highIntent, naturalReply }) {
  let assignedStaff = null;
  let assignedBranch = null;
  let routingMethod = "round_robin";
  const finalCustomerName = resolveCustomerName(collected, customerName);

  if (session.pinnedStaffId) {
    const pinned = await store.findStaffById(session.pinnedStaffId);
    session.pinnedStaffId = null;
    if (pinned && String(pinned.active).toUpperCase() === "TRUE") {
      const pinnedBranchIds = store.getStaffBranchIds(pinned);
      if (pinnedBranchIds.length > 0) {
        const pinnedBranch = await store.getBranchById(pinnedBranchIds[0]);
        if (pinnedBranch) {
          assignedStaff = pinned;
          assignedBranch = pinnedBranch;
          routingMethod = "requested";
        }
      }
    }
  }

  if (!assignedStaff && session.pendingStaffBranchOptions && session.pendingStaffBranchOptions.length > 0) {
    const options = session.pendingStaffBranchOptions;
    const matchedOption = matchBranchFromText(rawMessage || "", options);

    if (!matchedOption) {
      session.pendingStaffBranchAskCount = (session.pendingStaffBranchAskCount || 0) + 1;
      if (session.pendingStaffBranchAskCount <= 1) {
        const names = options.map((o) => o.branchName).join(" หรือ ");
        return `รบกวนแอดมินขอทราบอีกครั้งนะคะ สะดวกไปสาขาไหนดีระหว่าง ${names} คะ 🙏`;
      }
      session.pendingStaffBranchOptions = null;
      session.pendingStaffCandidateIds = null;
      session.pendingStaffBranchAskCount = 0;
      collected.requested_staff_name = null;
      return naturalReply || "รับทราบค่ะ 😊 มีอะไรให้แอดมินช่วยเพิ่มเติมไหมคะ";
    } else {
      assignedBranch = await store.getBranchById(matchedOption.branchId);

      if (session.pendingStaffCandidateIds && session.pendingStaffCandidateIds.length > 0) {
        const candidates = await Promise.all(session.pendingStaffCandidateIds.map((id) => store.findStaffById(id)));
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
  // กันบั๊กที่เจอจริง: requested_staff_name ดันเป็นชื่อเดียวกับชื่อลูกค้าเอง (เช่น ลูกค้าชื่อ "มาร์ค" บังเอิญมีเซลชื่อ "มาร์ค" ในระบบด้วย)
  // ทำให้ระบบเข้าใจผิดว่าลูกค้ากำลังขอเซลคนนั้น ทั้งที่จริงๆ แค่ลูกค้าแนะนำชื่อตัวเองหรือ Claude สับสนดึงชื่อลูกค้ามาใส่ผิดฟิลด์
  // ถ้าชื่อที่ระบุตรงกับชื่อลูกค้าเป๊ะๆ ให้ถือว่าไม่ได้ระบุชื่อเซลจริง (ปล่อยผ่านไปหาสาขาให้แบบปกติแทน)
  else if (
    !assignedStaff &&
    collected.requested_staff_name &&
    (!finalCustomerName || collected.requested_staff_name.trim().toLowerCase() !== finalCustomerName.trim().toLowerCase())
  ) {
    const matches = await store.findStaffMatches(collected.requested_staff_name, "sales");

    if (matches.length === 1 && store.getStaffBranchIds(matches[0]).length <= 1) {
      assignedStaff = matches[0];
      assignedBranch = await store.getBranchById(store.getStaffBranchIds(matches[0])[0]);
      routingMethod = "requested";
    } else if (matches.length >= 1) {
      const branches = await store.getActiveBranches();
      const branchIds = [...new Set(matches.flatMap((s) => store.getStaffBranchIds(s)))];
      const options = branchIds
        .map((id) => branches.find((b) => b.id === id))
        .filter(Boolean)
        .map((b) => ({ branchId: b.id, branchName: b.name }));

      if (options.length <= 1) {
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
      const branches = await store.getActiveBranches();
      const options = branches.map((b) => ({ branchId: b.id, branchName: b.name }));
      session.pendingStaffBranchOptions = options;
      session.pendingStaffCandidateIds = null;
      const names = options.map((o) => o.branchName).join(" หรือ ");
      return `เบื้องต้นแอดมินไม่พบชื่อ "${collected.requested_staff_name}" ในระบบนะคะ 🙏 ขอทราบก่อนได้ไหมคะว่าพี่สะดวกไปสาขาไหนระหว่าง ${names} คะ`;
    }
  } else if (!assignedStaff && intent === "buying_new") {
    const resolved = await resolveAssignedBranchForBuyingNew({ collected, session, rawMessage });
    if (resolved.clarifyingReply) {
      return resolved.clarifyingReply;
    }
    assignedBranch = resolved.branch;
  } else if (!assignedStaff) {
    if (session.confirmedGeneralBranchId) {
      const branches = await store.getActiveBranches();
      assignedBranch = branches.find((b) => b.id === session.confirmedGeneralBranchId) || (await resolveBranchDirect(collected));
    } else {
      assignedBranch = await resolveBranchDirect(collected);
    }
  }

  if (!assignedStaff && assignedBranch) {
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
    staffId: assignedStaff.id,
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
  // แปล delivery_preference เป็นภาษาไทยให้พนักงานอ่านง่าย (เดิมโชว์เป็นค่าดิบภาษาอังกฤษ เช่น "pickup_at_branch")
  const deliveryPrefThaiMap = { pickup_at_branch: "รับที่สาขา", home_delivery: "จัดส่งถึงบ้าน" };
  const deliveryNote = collected.delivery_preference
    ? `วิธีรับรถ: ${deliveryPrefThaiMap[collected.delivery_preference] || collected.delivery_preference}\n`
    : "";
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
    ? `\n\nแอดไลน์เซล ${assignedStaff.name} ไว้คุยต่อได้เลยนะคะ: ${assignedStaff.lineAddUrl}`
    : "";

  const tradeInPriceNote =
    intent === "trade_in"
      ? ` สามารถส่งภาพรถคันเดิมเพื่อขอประเมินราคาเบื้องต้นได้ที่เซล ${assignedStaff.name} ${assignedBranch.name}เลยนะคะ (ราคาที่ประเมินเป็นเพียงราคาเบื้องต้นเท่านั้นนะคะ ต้องนำรถเข้ามาตรวจเช็คสภาพจริงที่สาขาอีกครั้งเพื่อประเมินราคาสุดท้าย)`
      : "";

  return (
    `เรียบร้อยค่ะ${nameGreeting ? " " + nameGreeting : ""}! 🙏 ขอบคุณมากๆ นะคะที่ไว้วางใจทวีทรัพย์ยานยนต์ค่ะ 😊\n\n` +
    `แอดมินส่งข้อมูลของพี่ให้ทีมงาน${assignedBranch.name}เรียบร้อยแล้วนะคะ ${deliveryLine}\n` +
    `เดี๋ยวจะมีเซลชื่อ ${assignedStaff.name} จากสาขานี้ติดต่อกลับไปหาพี่เร็วๆ นี้เลยนะคะ\n` +
    `เบอร์เซล: ${assignedStaff.phone || "รอเบอร์ติดต่อ"}\n\n` +
    `รบกวนรอสักครู่นะคะ${tradeInPriceNote}${addLineNote}`
  );
}

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

async function resolveAssignedBranchForBuyingNew({ collected, session, rawMessage }) {
  const branches = await store.getActiveBranches();

  if (session.confirmedGeneralBranchId) {
    const forced = branches.find((b) => b.id === session.confirmedGeneralBranchId);
    if (forced) return { branch: forced };
  }

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
      const top2 = ranked.slice(0, 2).map((r) => r.branch);
      if (top2.length >= 2) {
        session.pendingBranchChoiceIds = top2.map((b) => b.id);
        const names = top2.map((b) => b.name).join(" หรือ ");
        return { clarifyingReply: `แอดมินเช็คให้แล้วค่ะ ใกล้พี่สุดมี 2 สาขาเลยคือ ${names} สะดวกไปสาขาไหนดีคะ 😊` };
      }
      if (top2.length === 1) return { branch: top2[0] };
    }
  }

  const hq = branches.find((b) => (b.name || "").includes("สำนักงานใหญ่")) || branches[0] || null;
  return { branch: hq };
}

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

  return `แอดมินรับข้อมูลนัดซ่อมของ${nameGreeting}เรียบร้อยแล้วนะคะ 😊 ${assignedBranch.name}${dateStr ? " วันที่ " + dateStr : ""} เดี๋ยวทางศูนย์จะติดต่อกลับไปยืนยันคิวอีกครั้งเร็วๆ นี้นะคะ${partsAddLineNote}\n\nขอบคุณที่ไว้วางใจนะคะ 🙏`;
}

async function handleServiceBranchChange({ collected, session, rawMessage, platform, userId, customerName }) {
  const oldBooking = session.lastServiceBooking;
  const branches = await store.getActiveBranches();

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

  await store.cancelBooking(oldBooking.bookingId);
  const cancelText =
    "❌ ยกเลิกนัดซ่อม (ลูกค้าขอเปลี่ยนไปสาขาอื่นแทน)\n" +
    "สาขาเดิม: " + oldBooking.branchName + "\n" +
    "Booking ID เดิม: " + oldBooking.bookingId;
  const oldPartsStaff = oldBooking.partsStaffId ? await store.findStaffById(oldBooking.partsStaffId) : null;
  const oldBranch = branches.find((b) => b.id === oldBooking.branchId) || { id: oldBooking.branchId, name: oldBooking.branchName };
  await notifyPartsDirect(oldBranch, oldPartsStaff, cancelText, oldBooking.bookingId);

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

function normalizeDate(text) {
  if (!text) return "";
  const m = text.match(/\d{4}-\d{2}-\d{2}/);
  if (!m) return text.trim();
  const timeMatch = text.match(/ช่วงเช้า|ช่วงบ่าย|ช่วงเย็น|เช้า|บ่าย|เย็น|\d{1,2}[:.]\d{2}|\d{1,2}\s*โมง/);
  return timeMatch ? `${m[0]} ${timeMatch[0]}` : m[0];
}

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

  collected.intent_category = null;
  session.lastLead = null;
  session.fallbackCount = 0;
  session.locationBranchIntroDone = false;
  session.serviceBranchIntroDone = false;

  return "ขอโทษด้วยนะคะ 🙏 แอดมินยกเลิกคิวเดิมที่ส่งผิดแผนกให้แล้วนะคะ รบกวนแจ้งอีกครั้งได้ไหมคะว่าต้องการเรื่องอะไหล่/บริการซ่อม หรือเรื่องซื้อ-เทิร์นรถคะ แอดมินจะส่งให้ทีมที่ถูกต้องทันทีเลยค่ะ";
}

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
