// หัวใจของระบบ: ตัดสินใจว่าถามต่อ หรือจะส่งต่อ (handoff) ให้เซล/ช่าง พร้อมหาสาขา+พนักงานที่เหมาะสม
"use strict";

const store = require("../services/store");
const { geocode, isServiceArea, haversineKm } = require("../services/geocode");
const line = require("../services/line");
const bitrix24 = require("../services/bitrix24");

const HIGH_INTENT_KEYWORDS = ["จอง", "มัดจำ", "โอนเงิน", "จัดไฟแนนซ์", "ส่งเอกสาร"];
const FALLBACK_LIMIT = 2;

function containsHighIntentKeyword(text) {
  if (!text) return false;
  return HIGH_INTENT_KEYWORDS.some((k) => text.includes(k));
}

async function handleTurn({ session, analysis, rawMessage, platform, userId, customerName, replyContext }) {
  const collected = session.collected;
  const fieldsToMerge = [
    "intent_category",
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

  const highIntent = containsHighIntentKeyword(rawMessage);
  const shouldHandoff = Boolean(analysis.data_complete) || highIntent || session.fallbackCount >= FALLBACK_LIMIT;

  if (!shouldHandoff) {
    session.fallbackCount = (session.fallbackCount || 0) + 1;
    return analysis.reply_text_to_customer || "ขอบคุณที่ทักมานะครับ แอดมินขอสอบถามเพิ่มเติมนิดนึงนะครับ พี่สนใจรุ่นไหน หรืออยากนัดซ่อมแบบไหนครับ";
  }

  session.fallbackCount = 0;
  return performHandoff({ collected, session, rawMessage, platform, userId, customerName, replyContext, highIntent });
}

async function performHandoff({ collected, session, rawMessage, platform, userId, customerName, replyContext, highIntent }) {
  const intent = collected.intent_category || "general";
  if (intent === "buying_new" || intent === "trade_in") {
    return handleSalesHandoff({ collected, session, rawMessage, intent, platform, userId, customerName, replyContext, highIntent });
  }
  if (intent === "service") {
    return handleServiceHandoff({ collected, platform, userId, customerName, replyContext });
  }
  return "แอดมินรับเรื่องไว้แล้วนะครับ เดี๋ยวให้ทีมงานติดต่อกลับไปนะครับ ขอบคุณที่ทักมาคุยกับแอดมินนะครับ 🙏";
}

async function handleSalesHandoff({ collected, session, rawMessage, intent, platform, userId, customerName, replyContext, highIntent }) {
  let assignedStaff = null;
  let assignedBranch = null;
  let routingMethod = "round_robin";

  // เงื่อนไขที่ 1: ลูกค้าเจาะจงชื่อเซล -> ถ้าเจอในระบบจริง ส่งให้คนนั้นเลย ไม่ต้องหมุนคิว
  if (collected.requested_staff_name) {
    const staff = await store.findStaffByNameFuzzy(collected.requested_staff_name);
    if (staff) {
      assignedStaff = staff;
      assignedBranch = await store.getBranchById(staff.branchId);
      routingMethod = "requested";
    } else {
      // ระบุชื่อมาแต่ไม่รู้จัก หรือขอคุยกับพนักงาน/เซลเฉยๆ -> ส่งไปสาขาที่ลูกค้าน่าจะหมายถึงทันที ไม่ถามซ้ำ
      assignedBranch = await resolveBranchDirect(collected);
      routingMethod = "requested_unmatched";
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
    // เทิร์นรถรันคิวแยกจากคิวขายรถใหม่ ไม่ใช้ตัวนับร่วมกัน
    assignedStaff =
      intent === "trade_in" ? await store.pickNextInTradeInQueue(assignedBranch.id) : await store.pickNextInQueue(assignedBranch.id);
  }

  if (!assignedStaff || !assignedBranch) {
    return "ขอโทษด้วยนะครับ ตอนนี้คิวเซลเต็มชั่วคราว แอดมินจะรีบให้ทีมงานติดต่อกลับไปโดยเร็วที่สุดเลยครับ 🙏";
  }

  if (intent === "trade_in") {
    await store.incrementOpenTradeInCount(assignedStaff.id);
  } else {
    await store.incrementOpenLeadsCount(assignedStaff.id);
  }

  const lead = {
    platform,
    customerId: userId,
    customerName: customerName || "",
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
  const customerNameNote = customerName ? `ชื่อลูกค้า (${platform}): ${customerName}\n` : "";
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
  const addLineNote = assignedStaff.lineAddUrl
    ? `\nแอดไลน์ ${assignedStaff.name} คุยต่อได้เลยครับ: ${assignedStaff.lineAddUrl}`
    : "";

  // เทิร์นรถ: ชวนลูกค้าส่งภาพรถคันเดิมให้เซลประจำสาขาดูเพื่อประเมินราคาเบื้องต้น
  // ย้ำเสมอว่าเป็นแค่ราคาประเมินเบื้องต้น ไม่ใช่ราคาสุดท้าย ต้องนำรถเข้ามาตรวจที่สาขาอีกครั้ง
  const tradeInPriceNote =
    intent === "trade_in"
      ? ` สามารถส่งภาพรถคันเดิมเพื่อขอประเมินราคาเบื้องต้นได้ที่เซล ${assignedStaff.name} สาขา${assignedBranch.name}เลยครับ (ราคาที่ประเมินเป็นเพียงราคาเบื้องต้นเท่านั้นนะครับ ต้องนำรถเข้ามาตรวจเช็คสภาพจริงที่สาขาอีกครั้งเพื่อประเมินราคาสุดท้าย)`
      : "";

  return `เรียบร้อยครับ! แอดมินส่งข้อมูลของพี่ให้ทีมงานเรียบร้อยแล้วนะครับ 😊 ${deliveryLine}เดี๋ยว ${assignedStaff.name} (${assignedStaff.phone || "รอเบอร์ติดต่อ"}) จะติดต่อพี่กลับไปเร็วๆ นี้ครับ${tradeInPriceNote}${addLineNote}\n\nขอบคุณมากๆ นะครับที่ไว้วางใจทวีทรัพย์ยานยนต์ครับ 🙏`;
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

  // รอบก่อนเคยแนะนำ 2 สาขาให้เลือกไว้ -> รอบนี้เช็คว่าลูกค้าเลือกสาขาไหน
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
    return { clarifyingReply: `รบกวนบอกแอดมินอีกครั้งนะครับ สะดวกไปสาขาไหนดีระหว่าง ${names} ครับ 🙏` };
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
        return { clarifyingReply: `แอดมินเช็คให้แล้วครับ ใกล้พี่สุดมี 2 สาขาเลยคือ ${names} สะดวกไปสาขาไหนดีครับ 😊` };
      }
      if (top2.length === 1) return { branch: top2[0] };
    }
  }

  // นอกพื้นที่ กทม./ปทุมธานี หรือหาพิกัดไม่ได้ -> ส่งสำนักงานใหญ่ (สนญ) รันคิวทันที
  const hq = branches.find((b) => (b.name || "").includes("สำนักงานใหญ่")) || branches[0] || null;
  return { branch: hq };
}

// นัดซ่อม: ลูกค้าพิมพ์รุ่นรถ/อาการเข้ามา บอทหาสาขาที่ใกล้ที่สุด แล้วส่งรายละเอียดตรงไปหา
// ไลน์ทีมอะไหล่ประจำสาขานั้นทันที (ไม่เช็คว่าคิวช่างเต็มไหม ให้ทีมอะไหล่/ช่างไปจัดคิวเองอีกที)
async function handleServiceHandoff({ collected, platform, userId, customerName, replyContext }) {
  const branches = await store.getActiveBranches();
  let assignedBranch = null;

  const geo = collected.location_text ? await geocode(collected.location_text) : null;
  if (geo && isServiceArea(geo.province)) {
    const ranked = branches
      .filter((b) => b.lat && b.long)
      .map((b) => ({ branch: b, distanceKm: haversineKm(geo.lat, geo.long, Number(b.lat), Number(b.long)) }))
      .sort((a, b) => a.distanceKm - b.distanceKm);
    assignedBranch = ranked.length > 0 ? ranked[0].branch : null;
  }
  if (!assignedBranch) {
    assignedBranch = branches[0] || null;
  }
  if (!assignedBranch) {
    return "ขอโทษด้วยนะครับ ตอนนี้แอดมินหาสาขาที่รับนัดซ่อมให้ไม่ได้ชั่วคราว เดี๋ยวทีมงานจะติดต่อกลับไปโดยเร็วที่สุดเลยครับ 🙏";
  }

  const dateStr = normalizeDate(collected.preferred_date || "");

  const booking = {
    platform,
    customerId: userId,
    branchId: assignedBranch.id,
    serviceDate: dateStr,
    issue: collected.model_or_issue || null,
    phone: collected.phone || null,
    status: "new",
  };
  await store.appendBooking(booking);

  const customerNameNote = customerName ? `ชื่อลูกค้า (${platform}): ${customerName}\n` : "";
  const notifyText =
    "🔧 นัดซ่อมใหม่ (" + platform + ")\n" +
    customerNameNote +
    "สาขา: " + assignedBranch.name + "\n" +
    "วันที่นัด: " + (dateStr || "ยังไม่ระบุ") + "\n" +
    "รุ่นรถ/อาการ: " + (collected.model_or_issue || "-") + "\n" +
    "เบอร์ลูกค้า: " + (collected.phone || "-") + "\n" +
    "(ทีมอะไหล่รบกวนเช็กสต๊อกอะไหล่/อุปกรณ์ที่ต้องใช้ล่วงหน้าให้ด้วยครับ)";

  await notifyPartsDirect(assignedBranch, notifyText);

  return `แอดมินรับข้อมูลนัดซ่อมเรียบร้อยแล้วนะครับ 😊 สาขา${assignedBranch.name}${dateStr ? " วันที่ " + dateStr : ""} เดี๋ยวทางศูนย์จะติดต่อกลับไปยืนยันคิวอีกครั้งเร็วๆ นี้ครับ ขอบคุณที่ไว้วางใจนะครับ 🙏`;
}

function normalizeDate(text) {
  if (!text) return "";
  const m = text.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : "";
}

// ส่งแจ้งเตือน Lead ตรงถึงไลน์ส่วนตัวเซล ถ้าเซลยังไม่ได้ลงทะเบียนไลน์
// ให้ fallback ไปแจ้งหัวหน้าสาขา (ผู้จัดการ) แทนทันที ไม่ใช้กลุ่มไลน์อีกต่อไป
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
  const branch = await store.getBranchById(staff.branchId);
  if (branch && branch.supervisorLineUserId) {
    try {
      await line.pushMessage(branch.supervisorLineUserId, `⚠️ (เซล ${staff.name} ยังไม่ได้ลงทะเบียนไลน์) ` + text);
      return;
    } catch (err) {
      console.error("[router] notifyStaffDirect supervisor fallback error:", err.message);
    }
  } else {
    console.warn(`[router] สาขา ${branch ? branch.name : staff.branchId} ยังไม่ได้ลงทะเบียนหัวหน้าสาขา (supervisorLineUserId) ข้อความหลุด:`, text);
  }
}

// ส่งแจ้งเตือนนัดซ่อมตรงถึงไลน์ส่วนตัวทีมอะไหล่ ถ้าทีมอะไหล่ยังไม่ได้ลงทะเบียนไลน์
// ให้ fallback ไปแจ้งหัวหน้าสาขา (ผู้จัดการ) แทนทันที ไม่ใช้กลุ่มไลน์อีกต่อไป
async function notifyPartsDirect(branch, text) {
  if (branch.partsLineUserId) {
    try {
      await line.pushMessage(branch.partsLineUserId, text);
      return;
    } catch (err) {
      console.error("[router] notifyPartsDirect pushMessage error:", err.message);
    }
  } else {
    console.warn(`[router] สาขา ${branch.name} (${branch.id}) ทีมอะไหล่ยังไม่ได้ลงทะเบียน lineUserId`);
  }
  if (branch.supervisorLineUserId) {
    try {
      await line.pushMessage(branch.supervisorLineUserId, "⚠️ (ทีมอะไหล่ยังไม่ได้ลงทะเบียนไลน์) " + text);
      return;
    } catch (err) {
      console.error("[router] notifyPartsDirect supervisor fallback error:", err.message);
    }
  } else {
    console.warn(`[router] สาขา ${branch.name} (${branch.id}) ยังไม่ได้ลงทะเบียนหัวหน้าสาขา (supervisorLineUserId) ข้อความหลุด:`, text);
  }
}

module.exports = { handleTurn };
