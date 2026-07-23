// หัวใจของระบบ: ตัดสินใจว่าจะถามต่อ หรือจะส่งต่อ (handoff) ให้เซล/ช่าง พร้อมหาสาขา+พนักงานที่เหมาะสม
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

/**
 * จัดการ turn การคุยหนึ่งรอบ: เรียก Claude มาแล้ว (analysis), ตัดสินใจว่า handoff หรือคุยต่อ
 * คืนค่าข้อความสุดท้ายที่จะส่งกลับลูกค้า
 */
async function handleTurn({ session, analysis, rawMessage, platform, userId, replyContext }) {
  // สะสมข้อมูลที่ Claude ดึงได้ในรอบนี้เข้ากับของเดิม (ไม่ให้ค่าที่เคยมีหายไปถ้ารอบใหม่ส่ง null มา)
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
  for (const f of fieldsToMerge) {
    if (analysis[f] !== undefined && analysis[f] !== null && analysis[f] !== "") {
      collected[f] = analysis[f];
    }
  }

  const highIntent = analysis.high_intent_keyword || containsHighIntentKeyword(rawMessage);

  if (analysis.fallback) {
    session.fallbackCount += 1;
  } else {
    session.fallbackCount = 0;
  }

  const shouldHandoff =
    !session.handedOff &&
    (analysis.data_complete ||
      highIntent ||
      session.fallbackCount >= FALLBACK_LIMIT ||
      (collected.requested_staff_name && collected.phone));

  // หมวด general ที่ตอบได้มั่นใจ -> ไม่ต้อง handoff จบตรงนั้น
  if (
    collected.intent_category === "general" &&
    analysis.in_scope !== false &&
    analysis.has_confident_answer &&
    !shouldHandoff
  ) {
    return analysis.reply_text_to_customer;
  }

  // นอกขอบเขตร้าน ไม่ escalate เอง ตอบสั้นๆ แล้วจบ (เว้นแต่ลูกค้าขอคุยกับคนจริงซึ่งจะเข้าเงื่อนไข shouldHandoff ทางอื่นอยู่แล้ว)
  if (analysis.in_scope === false && !shouldHandoff) {
    return analysis.reply_text_to_customer;
  }

  if (!shouldHandoff) {
    return analysis.reply_text_to_customer;
  }

  // ถึงจุดนี้ = จะ handoff แล้ว
  session.handedOff = true;
  return performHandoff({ collected, platform, userId, replyContext, highIntent });
}

async function performHandoff({ collected, platform, userId, replyContext, highIntent }) {
  const intent = collected.intent_category || "general";

  if (intent === "buying_new" || intent === "trade_in") {
    return handleSalesHandoff({ collected, intent, platform, userId, replyContext, highIntent });
  }
  if (intent === "service") {
    return handleServiceHandoff({ collected, platform, userId, replyContext });
  }

  // general ที่ยังต้อง handoff (เช่น fallback ซ้ำ หรือขอคุยกับคน) -> ส่งเข้าแอดมินทั่วไป ไม่ตัดคิวเซล/ช่าง
  return "เดี๋ยวให้ทีมงานติดต่อกลับไปนะครับ ขอบคุณที่ทักมาครับ 🙏";
}

async function handleSalesHandoff({ collected, intent, platform, userId, replyContext, highIntent }) {
  let assignedStaff = null;
  let assignedBranch = null;
  let routingMethod = "round_robin";

  // 1) เช็คเซลประจำตัวก่อนเสมอ
  if (collected.requested_staff_name) {
    const staff = store.findStaffByNameFuzzy(collected.requested_staff_name);
    if (staff) {
      assignedStaff = staff;
      assignedBranch = store.getBranchById(staff.branchId);
      routingMethod = "requested";
    }
  }

  // 2) ถ้ายังไม่มี ให้หาสาขาจากพื้นที่ (geocode)
  if (!assignedStaff) {
    const geo = collected.location_text ? await geocode(collected.location_text) : null;

    if (geo && isServiceArea(geo.province)) {
      const branches = store.getActiveBranches();
      const ranked = branches
        .map((b) => ({ branch: b, distanceKm: haversineKm(geo.lat, geo.long, b.lat, b.long) }))
        .sort((a, b) => a.distanceKm - b.distanceKm);
      assignedBranch = ranked.length > 0 ? ranked[0].branch : null;
    } else {
      // ต่างจังหวัด หรือ geocode ไม่สำเร็จ (ไม่มี API key/หาไม่เจอ) -> ส่งสำนักงานใหญ่
      assignedBranch = store.getActiveBranches().find((b) => b.name.includes("สำนักงานใหญ่")) || null;
    }

    if (assignedBranch) {
      assignedStaff = store.pickNextInQueue(assignedBranch.id, "เซล");
    }
  }

  if (!assignedStaff || !assignedBranch) {
    return "ขอบคุณสำหรับข้อมูลนะครับ ตอนนี้ทีมขายเต็มคิวชั่วคราว เดี๋ยวเจ้าหน้าที่จะติดต่อกลับโดยเร็วที่สุดครับ 🙏";
  }

  store.incrementOpenLeadsCount(assignedStaff.id);

  const lead = {
    id: `LD-${Date.now()}`,
    createdAt: new Date().toISOString(),
    platform,
    customerId: userId,
    intentCategory: intent,
    modelOrIssue: collected.model_or_issue || null,
    deliveryPreference: collected.delivery_preference || null,
    locationText: collected.location_text || null,
    branchAssigned: assignedBranch.name,
    staffAssigned: assignedStaff.name,
    staffPhone: assignedStaff.phone,
    routingMethod,
    highIntentKeyword: Boolean(highIntent),
    phone: collected.phone || null,
    status: "New",
  };
  store.appendLead(lead);
  await bitrix24.createLead(lead);

  // แจ้งกลุ่ม LINE ของสาขา
  const badge = routingMethod === "requested" ? `🌟 ลูกค้าประจำของ ${assignedStaff.name}\n` : "";
  const notifyText =
    `${badge}🔔 Lead ใหม่ — ${platform}\n` +
    `หมวด: ${intent === "buying_new" ? "ซื้อรถใหม่" : "เทิร์นรถเก่า"}\n` +
    `สนใจ/รถเก่า: ${lead.modelOrIssue || "-"}\n` +
    `สาขา: ${assignedBranch.name}\n` +
    `เบอร์ลูกค้า: ${lead.phone || "-"}\n` +
    `Lead ID: ${lead.id}`;
  await safePushLine(assignedBranch.lineGroupId, notifyText);

  // ข้อความยืนยันกับลูกค้า (server เป็นคนประกอบข้อความสุดท้ายเอง เพื่อความแม่นยำของเบอร์/ชื่อ ไม่ปล่อยให้ AI เดา)
  const deliveryNote =
    intent === "buying_new" && collected.delivery_preference === "home_delivery"
      ? `เดี๋ยวเซลของสาขา ${assignedBranch.name} จะติดต่อไปคุยเรื่องจัดส่งให้นะครับ\n`
      : "";

  return (
    `เรียบร้อยครับ! ${deliveryNote}` +
    `เดี๋ยว ${assignedStaff.name} จะติดต่อพี่กลับไปนะครับ ` +
    `หรือถ้าอยากติดต่อก่อนเลย ทักหรือโทรได้ที่ ${assignedStaff.phone} เลยครับ\n` +
    `- ${intent === "buying_new" ? "รุ่นที่สนใจ" : "รายละเอียด"}: ${lead.modelOrIssue || "-"}\n` +
    `- สาขา: ${assignedBranch.name}`
  );
}

async function handleServiceHandoff({ collected, platform, userId, replyContext }) {
  let assignedBranch = null;

  if (collected.requested_staff_name) {
    const staff = store.findStaffByNameFuzzy(collected.requested_staff_name);
    if (staff) assignedBranch = store.getBranchById(staff.branchId);
  }

  if (!assignedBranch) {
    const geo = collected.location_text ? await geocode(collected.location_text) : null;
    if (geo && isServiceArea(geo.province)) {
      const branches = store.getActiveBranches();
      const ranked = branches
        .map((b) => ({ branch: b, distanceKm: haversineKm(geo.lat, geo.long, b.lat, b.long) }))
        .sort((a, b) => a.distanceKm - b.distanceKm);
      assignedBranch = ranked.length > 0 ? ranked[0].branch : null;
    } else {
      assignedBranch = store.getActiveBranches().find((b) => b.name.includes("สำนักงานใหญ่")) || null;
    }
  }

  if (!assignedBranch) {
    return "ขอบคุณสำหรับข้อมูลนะครับ เดี๋ยวทีมช่างจะติดต่อกลับไปโดยเร็วที่สุดครับ 🙏";
  }

  // เช็คคิวซ่อมของวันที่ขอ (ถ้ามีการระบุวันที่ที่ระบบเข้าใจได้)
  const dateStr = normalizeDate(collected.preferred_date);
  let queueNote = "";
  if (dateStr) {
    const bookedCount = store.getBookingsForBranchDate(assignedBranch.id, dateStr).length;
    if (bookedCount < assignedBranch.maxServiceSlotsPerDay) {
      store.appendBooking({
        id: `BK-${Date.now()}`,
        branchId: assignedBranch.id,
        date: dateStr,
        customerId: userId,
        platform,
        modelOrIssue: collected.model_or_issue || null,
        phone: collected.phone || null,
        status: "Booked",
        createdAt: new Date().toISOString(),
      });
      queueNote = `คิววันที่ ${dateStr} ยังว่างครับ ✅ จองให้แล้วนะครับ\n`;
    } else {
      queueNote = `คิววันที่ ${dateStr} เต็มแล้วครับ 🙏 เดี๋ยวทางสาขาจะติดต่อไปเสนอวันถัดไปที่ว่างให้นะครับ\n`;
    }
  }

  const lead = {
    id: `LD-${Date.now()}`,
    createdAt: new Date().toISOString(),
    platform,
    customerId: userId,
    intentCategory: "service",
    modelOrIssue: collected.model_or_issue || null,
    preferredDate: collected.preferred_date || null,
    branchAssigned: assignedBranch.name,
    phone: collected.phone || null,
    status: "New",
  };
  store.appendLead(lead);
  await bitrix24.createLead(lead);

  const notifyText =
    `🔧 คิวซ่อมใหม่ — ${platform}\n` +
    `อาการ/บริการ: ${lead.modelOrIssue || "-"}\n` +
    `วันที่นัด: ${lead.preferredDate || "-"}\n` +
    `เบอร์ลูกค้า: ${lead.phone || "-"}\n` +
    `Lead ID: ${lead.id}`;
  await safePushLine(assignedBranch.lineGroupId, notifyText);

  return (
    `เรียบร้อยครับ! ${queueNote}` +
    `ทางช่าง/อะไหล่สาขา ${assignedBranch.name} จะทักแชทหรือโทรกลับไปที่เบอร์ ${collected.phone || "ที่ให้ไว้"} นะครับ\n` +
    `- รุ่นรถ/อาการ: ${lead.modelOrIssue || "-"}`
  );
}

function normalizeDate(text) {
  if (!text) return null;
  // เดโม: ยอมรับเฉพาะรูปแบบ YYYY-MM-DD ที่ Claude ควรพยายามแปลงให้ก่อนส่งมา
  // ถ้าอยากรองรับภาษาพูดแบบ "พรุ่งนี้" "เสาร์นี้" ให้เพิ่ม logic แปลงวันที่ตรงนี้ หรือให้ Claude แปลงเป็น ISO date มาให้เลย
  const match = text.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

async function safePushLine(groupId, text) {
  if (!groupId || groupId.includes("ใส่ของจริง")) {
    console.warn("[router] ยังไม่ได้ตั้งค่า LINE Group ID จริง — ข้ามการแจ้งเตือน (ดู console แทน)");
    console.log("[LINE PUSH ที่ควรส่ง]:", text);
    return;
  }
  try {
    await line.pushMessage(groupId, text);
  } catch (err) {
    console.error("[router] ส่ง LINE push ไม่สำเร็จ:", err.message);
  }
}

module.exports = { handleTurn };
