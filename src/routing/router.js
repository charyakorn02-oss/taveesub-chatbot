// หัวใจของระบบ: ตัดสินใจว่าถามต่อ หรือจะส่งต่อ (handoff) ให้เซล/ช่าง พร้อมหาสาขา+พนักงานที่เหมาะสม
"use strict";

const store = require("../services/store");
const { geocode, isServiceArea, haversineKm } = require("../services/geocode");
const line = require("../services/line");
const bitrix24 = require("../services/bitrix24");

const HIGH_INTENT_KEYWORDS = ["จอง", "มัดจำ", "โอนเงิน", "จัดไฟแนนซ์", "ส่งเอกสาร"];
const FALLBACK_LIMIT = 2;
const BRANCH_CHANGE_KEYWORDS = /เปลี่ยนสาขา|เปลี่ยนที่ซ่อม|ขอเปลี่ยนสาขา|สาขาอื่นแทน|เปลี่ยนเป็นสาขา|เปลี่ยนไปสาขา/;

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

// พอลูกค้าบอกที่อยู่มาปุ๊บ (เฉพาะซื้อรถใหม่ ยังไม่ได้ระบุชื่อเซล ยังไม่ได้เลือกวิธีรับรถ) ให้รีบค้นหาสาขาที่ใกล้ที่สุดจริงๆ
// ด้วย Google Maps ทันที แทนที่จะให้ Claude เดาเองว่าอยู่ในเขตบริการไหม/สาขาไหนใกล้สุด ช่วยให้แม่นยำและไม่ต้องรอจนขั้นตอนสุดท้าย
// ทำครั้งเดียวต่อ session (เก็บ flag session.locationBranchIntroDone กันถามซ้ำ/แนะนำซ้ำ)
async function introduceNearestBranches(locationText) {
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
      return `แอดมินเช็คแผนที่ให้แล้วค่ะ 😊 สาขาที่ใกล้พี่ที่สุดคือ ${top2[0].name} ค่ะ พี่สะดวกมารับที่สาขานี้เอง หรือสนใจให้จัดส่งถึงบ้านดีคะ (จัดส่งฟรีในระยะ 25 กม. จากสาขา และทำสัญญาซื้อขายให้ฟรีทั่วประเทศค่ะ)`;
    }
    const names = top2.map((b) => b.name).join(" หรือ ");
    return `แอดมินเช็คแผนที่ให้แล้วค่ะ 😊 ใกล้พี่ที่สุดมี 2 สาขาเลยคือ ${names} พี่สะดวกไปสาขาไหนดีคะ หรือสนใจให้จัดส่งถึงบ้านแทนก็ได้นะคะ (จัดส่งฟรีในระยะ 25 กม. จากสาขา และทำสัญญาซื้อขายให้ฟรีทั่วประเทศค่ะ)`;
  }

  // นอกเขตบริการจริงๆ หรือหาพิกัดไม่ได้ (พิมพ์มาไม่ชัดเจน/geocode ล้มเหลว) -> ไม่เดาสาขา ให้สนญ. ดูแลแทน
  return "เข้าใจแล้วค่ะ พื้นที่ของพี่ทางสำนักงานใหญ่จะเป็นผู้ประสานงานดูแลให้นะคะ (ทำสัญญาซื้อขายให้ฟรีทั่วประเทศค่ะ) ขอทราบชื่อ-เบอร์ติดต่อกลับได้ไหมคะ 😊";
}

async function handleTurn({ session, analysis, rawMessage, platform, userId, customerName, replyContext }) {
  const collected = session.collected;
  const fieldsToMerge = [
    "intent_category",
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

  // เช็คทันทีที่มีที่อยู่ลูกค้าแล้ว (เฉพาะซื้อรถใหม่ ไม่มีชื่อเซลที่ระบุ ยังไม่ได้เลือกวิธีรับรถ) -> ค้นสาขาใกล้สุดจริงจาก Google Maps เลย
  if (
    collected.intent_category === "buying_new" &&
    collected.location_text &&
    !collected.requested_staff_name &&
    !collected.delivery_preference &&
    !session.locationBranchIntroDone
  ) {
    const introReply = await introduceNearestBranches(collected.location_text);
    if (introReply) {
      session.locationBranchIntroDone = true;
      session.fallbackCount = 0;
      return introReply;
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

  const highIntent = analysis.high_intent_keyword || containsHighIntentKeyword(rawMessage);

  // เรื่อง "ซ่อมรถ"/"เทิร์นรถ" ลูกค้าต้องมาที่สาขาจริงๆ เสมอ ต่อให้เจอคำ high_intent_keyword อย่าง "จอง" (ซึ่งมักแปลว่า "จองคิวซ่อม"
  // ไม่ใช่สัญญาณซื้อรถเร่งด่วนแบบที่ใช้กับ buying_new) ก็ห้าม handoff ข้ามขั้นไปเลยถ้ายังไม่รู้เลยว่าลูกค้าสะดวกสาขาไหน/มีช่างประจำไหม
  // ไม่งั้นระบบจะเดาส่งไปสำนักงานใหญ่แบบไม่มีมูลเหตุ (บั๊กที่เจอจริง: ลูกค้าพิมพ์ "จองคิวหน่อย" ทั้งที่ยังไม่เคยบอกที่อยู่เลย)
  const effectiveIntent = collected.intent_category || guessIntentFromText(rawMessage);
  const needsBranchInfo =
    (effectiveIntent === "service" || effectiveIntent === "trade_in") &&
    !collected.location_text &&
    !collected.requested_staff_name;

  // กันเหนียว: ถึง Claude จะบอกว่า data_complete = true ก็ตาม ห้าม handoff จริงถ้ายังไม่มีเบอร์โทรลูกค้าเก็บไว้เลย
  // (ป้องกันเคส Claude วิเคราะห์ผิดพลาดแล้วส่ง lead ที่ไม่มีเบอร์/ที่อยู่ให้เซลไปโดยไม่ได้ตั้งใจ)
  // ข้อยกเว้น: เจอคำที่บ่งชี้ high intent ชัดเจน (จอง/มัดจำ/โอนเงิน ฯลฯ) หรือค้างถามมาครบรอบ fallback แล้ว ถึงจะส่งเท่าที่มีได้
  const hasPhone = Boolean(collected.phone);
  const claudeSaysComplete = Boolean(analysis.data_complete) && hasPhone;
  const shouldHandoff = claudeSaysComplete || (highIntent && !needsBranchInfo) || session.fallbackCount >= FALLBACK_LIMIT;

  if (!shouldHandoff) {
    session.fallbackCount = (session.fallbackCount || 0) + 1;
    // ห้ามใช้ข้อความ default ที่ถามซ้ำเรื่องที่ลูกค้าตอบไปแล้ว (เช่นถามรุ่น/ถามที่อยู่ซ้ำ) เพราะ Claude อาจส่ง reply_text_to_customer
    // ว่างมาชั่วคราว (JSON parse ได้แต่ field นี้หลุด) -> ใช้ข้อความกลางๆ ที่ไม่ขัดกับบริบทที่คุยไปแล้วแทน
    return (
      analysis.reply_text_to_customer ||
      "ขอบคุณที่บอกแอดมินนะคะ 😊 รบกวนแอดมินขอทราบข้อมูลอีกนิดนะคะ พี่พิมพ์อีกครั้งได้ไหมคะ 🙏"
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
    return handleServiceHandoff({ collected, session, platform, userId, customerName, replyContext });
  }
  // general / ไม่รู้จะตอบยังไง (เช่น Claude ตอบไม่มั่นใจ ถามซ้ำจน fallback ครบ หรือลูกค้าขอคุยกับคนจริงแบบไม่เจาะจงหมวด)
  // ก่อนหน้านี้เคสนี้แค่ตอบลูกค้าเฉยๆ ไม่มีการสร้าง lead หรือแจ้งพนักงานเลย ทำให้เรื่องหลุดไปเงียบๆ -> แก้ให้สร้าง lead จริงและแจ้งหัวหน้าสาขาเสมอ
  return handleGeneralHandoff({ collected, rawMessage, platform, userId, customerName });
}

// เอาชื่อสาขาไปหาว่าลูกค้าตอบกลับมาตรงกับตัวเลือกไหน (ใช้ตอนก่อนหน้าเคยถามลูกค้าว่า "สะดวกสาขาไหน" ไปแล้ว)
function matchBranchFromText(text, options) {
  if (!text) return null;
  return (
    options.find((o) => {
      const shortName = (o.branchName || "").replace(/^สาขา/, "").trim();
      return text.includes(o.branchName) || (shortName && text.includes(shortName));
    }) || null
  );
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
      const names = options.map((o) => o.branchName).join(" หรือ ");
      return `รบกวนแอดมินขอทราบอีกครั้งนะคะ สะดวกไปสาขาไหนดีระหว่าง ${names} คะ 🙏`;
    }

    assignedBranch = await store.getBranchById(matchedOption.branchId);

    if (session.pendingStaffCandidateIds && session.pendingStaffCandidateIds.length > 0) {
      const candidates = await Promise.all(session.pendingStaffCandidateIds.map((id) => store.findStaffById(id)));
      const found = candidates.find(
        (s) => s && s.branchId === matchedOption.branchId && String(s.active).toUpperCase() === "TRUE"
      );
      if (found) {
        assignedStaff = found;
        routingMethod = "requested";
      }
    }

    session.pendingStaffBranchOptions = null;
    session.pendingStaffCandidateIds = null;
  }
  // เงื่อนไขที่ 1: ลูกค้าเจาะจงชื่อเซล -> ค้นหาเฉพาะ role=sales ในระบบ (รองรับพิมพ์ชื่อคลาดเคลื่อนเล็กน้อย เช่น ขวัญ/ขวัน)
  else if (collected.requested_staff_name) {
    const matches = await store.findStaffMatches(collected.requested_staff_name, "sales");

    if (matches.length === 1) {
      assignedStaff = matches[0];
      assignedBranch = await store.getBranchById(assignedStaff.branchId);
      routingMethod = "requested";
    } else if (matches.length > 1) {
      // ชื่อซ้ำ/คล้ายกันหลายคน -> ถามลูกค้าว่าสะดวกสาขาไหน แล้วค่อยเลือกคนที่ตรงสาขา
      const branches = await store.getActiveBranches();
      const branchIds = [...new Set(matches.map((s) => s.branchId))];
      const options = branchIds
        .map((id) => branches.find((b) => b.id === id))
        .filter(Boolean)
        .map((b) => ({ branchId: b.id, branchName: b.name }));

      if (options.length <= 1) {
        // ชื่อซ้ำแต่จริงๆ อยู่สาขาเดียวกัน -> เลือกคนแรกไปเลย ไม่ต้องถามซ้ำให้ลูกค้ารำคาญ
        assignedStaff = matches[0];
        assignedBranch = await store.getBranchById(assignedStaff.branchId);
        routingMethod = "requested";
      } else {
        session.pendingStaffBranchOptions = options;
        session.pendingStaffCandidateIds = matches.map((s) => s.id);
        const names = options.map((o) => o.branchName).join(" หรือ ");
        return `พบชื่อ "${collected.requested_staff_name}" มากกว่า 1 คนเลยค่ะ 😊 สะดวกไปสาขาไหนดีระหว่าง ${names} คะ`;
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
    // trade_in: ต้องมาสาขาเสมอ -> แค่ถามตรงๆ ว่าสะดวกนำรถเข้าสาขาไหน แล้ว match ชื่อสาขาจากคำตอบลูกค้า
    assignedBranch = await resolveBranchDirect(collected);
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
    "Lead ID: " + leadId;

  await notifyStaffDirect(assignedStaff, notifyText, leadId);

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
  const tradeInPriceNote =
    intent === "trade_in"
      ? ` สามารถส่งภาพรถคันเดิมเพื่อขอประเมินราคาเบื้องต้นได้ที่เซล ${assignedStaff.name} สาขา${assignedBranch.name}เลยนะคะ (ราคาที่ประเมินเป็นเพียงราคาเบื้องต้นเท่านั้นนะคะ ต้องนำรถเข้ามาตรวจเช็คสภาพจริงที่สาขาอีกครั้งเพื่อประเมินราคาสุดท้าย)`
      : "";

  return `เรียบร้อยค่ะ! แอดมินส่งข้อมูลของ${nameGreeting}ให้ทีมงานเรียบร้อยแล้วนะคะ 😊 ${deliveryLine}เดี๋ยวจะมีเซล ${assignedStaff.name} (${assignedStaff.phone || "รอเบอร์ติดต่อ"}) ติดต่อไปนะคะ กรุณารอสักครู่นะคะ${tradeInPriceNote}${addLineNote}\n\nขอบคุณมากๆ นะคะที่ไว้วางใจทวีทรัพย์ยานยนต์ค่ะ 🙏`;
}

// หาสาขาให้ลูกค้า -> ใช้ตอน (1) ระบุชื่อเซล/ขอคุยกับพนักงาน แต่ระบบไม่รู้จักตัวตน หรือ (2) ลูกค้าเทิร์นรถที่บอกตรงๆ
// ว่าสะดวกนำรถเข้าสาขาไหน -> match ชื่อสาขาจากข้อความลูกค้าก่อน ถ้าไม่เจอค่อย fallback ไปหาสาขาใกล้สุดจากพิกัด
async function resolveBranchDirect(collected) {
  const branches = await store.getActiveBranches();
  const hintText = `${collected.location_text || ""} ${collected.requested_staff_name || ""}`.trim();

  if (hintText) {
    const matchedByName = branches.find((b) => {
      if (!b.name) return false;
      const shortName = b.name.replace(/^สาขา/, "").trim();
      return hintText.includes(b.name) || (shortName && hintText.includes(shortName));
    });
    if (matchedByName) return matchedByName;
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

  // รอบก่อนเคยแนะนำ 2 สาขาให้เลือกไว้ (จากขั้นตอน introduceNearestBranches หรือจากรอบนี้เอง) -> รอบนี้เช็คว่าลูกค้าเลือกสาขาไหน
  if (session.pendingBranchChoiceIds && session.pendingBranchChoiceIds.length > 0) {
    const candidates = session.pendingBranchChoiceIds
      .map((id) => branches.find((b) => b.id === id))
      .filter(Boolean);
    const text = rawMessage || "";
    const matched = candidates.find((b) => {
      if (!b.name) return false;
      const shortName = b.name.replace(/^สาขา/, "").trim();
      return text.includes(b.name) || (shortName && text.includes(shortName));
    });
    if (matched) {
      session.pendingBranchChoiceIds = null;
      return { branch: matched };
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
// forcedBranch: ใช้ตอนลูกค้าขอเปลี่ยนสาขาภายหลัง (handleServiceBranchChange) จะได้ใช้สาขาที่ลูกค้าเพิ่งระบุตรงๆ ไม่ต้อง geocode ซ้ำ
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
    "(ทีมอะไหล่รบกวนเช็กสต๊อกอะไหล่/อุปกรณ์ที่ต้องใช้ล่วงหน้าให้ด้วยนะคะ)\n" +
    "Booking ID: " + bookingId;

  await notifyPartsDirect(assignedBranch, assignedPartsStaff, notifyText, bookingId);

  const nameGreeting = finalCustomerName ? `คุณ${finalCustomerName} ` : "";
  const partsAddLineNote = assignedPartsStaff && assignedPartsStaff.lineAddUrl
    ? `\n\nแอดไลน์ทีมอะไหล่ไว้คุยต่อได้เลยนะคะ: ${assignedPartsStaff.lineAddUrl}`
    : "";

  return `แอดมินรับข้อมูลนัดซ่อมของ${nameGreeting}เรียบร้อยแล้วนะคะ 😊 สาขา${assignedBranch.name}${dateStr ? " วันที่ " + dateStr : ""} เดี๋ยวทางศูนย์จะติดต่อกลับไปยืนยันคิวอีกครั้งเร็วๆ นี้นะคะ${partsAddLineNote}\n\nขอบคุณที่ไว้วางใจนะคะ 🙏`;
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
  return m ? m[0] : "";
}

// ส่งแจ้งเตือน Lead ตรงถึงไลน์ส่วนตัวเซล พร้อมปุ่ม "รับทราบแล้ว" (ผูกกับ leadId) ถ้าเซลยังไม่ได้ลงทะเบียนไลน์
// ให้ fallback ไปแจ้งหัวหน้าสาขา (role=supervisor ในแท็บ Staff) แทนทันที (พร้อมปุ่มรับทราบเช่นกัน ผูกกับ leadId เดียวกัน)
async function notifyStaffDirect(staff, text, leadId) {
  if (staff.lineUserId) {
    try {
      await line.pushMessageWithAck(staff.lineUserId, text, leadId);
      return;
    } catch (err) {
      console.error("[router] pushMessageWithAck error:", err.message);
    }
  } else {
    console.warn(`[router] พนักงาน ${staff.name} (${staff.id}) ยังไม่ได้ลงทะเบียน lineUserId`);
  }
  const supervisor = await store.getSupervisorForBranch(staff.branchId);
  if (supervisor && supervisor.lineUserId) {
    try {
      await line.pushMessageWithAck(supervisor.lineUserId, `⚠️ (เซล ${staff.name} ยังไม่ได้ลงทะเบียนไลน์) ` + text, leadId);
      return;
    } catch (err) {
      console.error("[router] notifyStaffDirect supervisor fallback error:", err.message);
    }
  } else {
    console.warn(`[router] สาขา ${staff.branchId} ยังไม่ได้ลงทะเบียนหัวหน้าสาขา (role=supervisor) ข้อความหลุด:`, text);
  }
}

// ส่งแจ้งเตือนนัดซ่อมตรงถึงไลน์ส่วนตัวทีมอะไหล่ที่ถูกเลือกจากคิว (role=parts) พร้อมปุ่ม "รับทราบแล้ว" (ผูกกับ bookingId)
// ถ้าคนนั้นยังไม่ได้ลงทะเบียนไลน์ หรือสาขานั้นไม่มีทีมอะไหล่เลย ให้ fallback ไปแจ้งหัวหน้าสาขาแทนทันที (พร้อมปุ่มรับทราบเช่นกัน)
async function notifyPartsDirect(branch, partsStaff, text, bookingId) {
  if (partsStaff && partsStaff.lineUserId) {
    try {
      await line.pushMessageWithAck(partsStaff.lineUserId, text, bookingId);
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
      await line.pushMessageWithAck(supervisor.lineUserId, "⚠️ (ทีมอะไหล่ยังไม่ได้ลงทะเบียนไลน์) " + text, bookingId);
      return;
    } catch (err) {
      console.error("[router] notifyPartsDirect supervisor fallback error:", err.message);
    }
  } else {
    console.warn(`[router] สาขา ${branch.name} (${branch.id}) ยังไม่ได้ลงทะเบียนหัวหน้าสาขา (role=supervisor) ข้อความหลุด:`, text);
  }
}

module.exports = { handleTurn };
