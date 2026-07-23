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

/**
 * จัดการ turn การคุยหนึ่งรอบ: เรียก Claude มาแล้ว (analysis), ตัดสินใจว่า handoff หรือคุยต่อ
 * คืนค่าข้อความสุดท้ายที่จะส่งกลับลูกค้า
 */
async function handleTurn({ session, analysis, rawMessage, platform, userId, replyContext }) {
  // สะสมข้อมูลที่ Claude ดึงได้ในรอบนี้เข้ากับของเดิม (ไม่ให้ค่าที่เคยทายไปถ้ารอบใหม่ส่ง null มา)
  const collected = session.collected;
  const fieldsToMerge = [
    "intent_category",
    "model_or_issue",
    "delivery_preference",
    "location_text",
    "requested_staff_name",
    "phone",
  ];
  fieldsToMerge.forEach((f) => {
    if (analysis[f] !== undefined && analysis[f] !== null && analysis[f] !== "") {
      collected[f] = analysis[f];
    }
  });

  const highIntent = containsHighIntentKeyword(rawMessage);
  const shouldHandoff = Boolean(analysis.ready_to_handoff) || highIntent || session.fallbackCount >= FALLBACK_LIMIT;

  if (!shouldHandoff) {
    session.fallbackCount = (session.fallbackCount || 0) + 1;
    return analysis.reply_to_customer || "รบกวนสอบถามเพิ่มเติมนิดนึงนะครับ พี่สนใจรุ่นไหน หรืออยากนัดซ่อมแบบไหนครับ";
  }

  session.fallbackCount = 0;
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
  return "เดี๋ยวให้ทีมงานติดต่อกลับไปนะครับ ขอบคุณที่ทักมาครับ 🙏";
}

async function handleSalesHandoff({ collected, intent, platform, userId, replyContext, highIntent }) {
  let assignedStaff = null;
  let assignedBranch = null;
  let routingMethod = "round_robin";

  // เงื่อนไขที่ 1: ลูกค้าเจาะจงชื่อเซล -> ส่งให้คนนั้นเลย ไม่ต้องหมุนคิว
  if (collected.requested_staff_name) {
    const staff = await store.findStaffByNameFuzzy(collected.requested_staff_name);
    if (staff) {
      assignedStaff = staff;
      assignedBranch = await store.getBranchById(staff.branchId);
      routingMethod = "requested";
    }
  }

  // เงื่อนไขที่ 2: หาสาขาจากที่อยู่/พิกัดลูกค้า (การรับรถ + ที่อยู่) แล้วหมุนคิวพนักงานในสาขานั้น
  if (!assignedStaff) {
    const branches = await store.getActiveBranches();
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

    // เงื่อนไขที่ 3: ในสาขานั้น หมุนคิวพนักงาน (openLeadsCount น้อยสุดก่อน, ถ้าเท่ากันดู lastAssignedAt เก่าสุด)
    if (assignedBranch) {
      assignedStaff = await store.pickNextInQueue(assignedBranch.id);
    }
  }

  if (!assignedStaff || !assignedBranch) {
    return "ขอโทษครับ ตอนนี้ทีมขายเต็มคิวชั่วคราว เดี๋ยวทีมงานติดต่อกลับไปโดยเร็วที่สุดนะครับ 🙏";
  }

  await store.incrementOpenLeadsCount(assignedStaff.id);

  const lead = {
    platform,
    customerId: userId,
    intentCategory: intent,
    modelOrIssue: collected.model_or_issue || null,
    branchId: assignedBranch.id,
    staffName: assignedStaff.name,
    staffPhone: assignedStaff.phone,
    phone: collected.phone || null,
    locationText: collected.location_text || null,
    status: "New",
  };

  const leadId = await store.appendLead(lead);
  try {
    await bitrix24.createLead({ ...lead, id: leadId, routingMethod, highIntentKeyword: Boolean(highIntent) });
  } catch (err) {
    console.error("[router] bitrix24.createLead error:", err.message);
  }

  const badge = routingMethod === "requested" ? `🌟 ลูกค้าประจำของ ${assignedStaff.name}\n` : "";
  const deliveryNote = collected.delivery_preference ? `วิธีรับรถ: ${collected.delivery_preference}\n` : "";
  const notifyText =
    badge +
    "🔔 Lead ใหม่ (" + platform + ")\n" +
    "สาขา: " + assignedBranch.name + "\n" +
    "รุ่นที่สนใจ: " + (collected.model_or_issue || "-") + "\n" +
    deliveryNote +
    "ที่อยู่ลูกค้า: " + (collected.location_text || "-") + "\n" +
    "เบอร์ลูกค้า: " + (collected.phone || "-") + "\n" +
    "Lead ID: " + leadId;

  // ส่งไลน์ตรงหาเซลที่อยู่ในคิว (ไม่ส่งกลุ่มสาขาแล้ว) พร้อมปุ่ม "รับทราบแล้ว"
  await notifyStaffDirect(assignedStaff, notifyText, leadId);

  const deliveryLine = collected.delivery_preference ? `เรื่อง${collected.delivery_preference}` : "";
  return `เรียบร้อยครับ! ${deliveryLine}เดี๋ยว ${assignedStaff.name} (${assignedStaff.phone || "รอเบอร์ติดต่อ"}) จะติดต่อพี่กลับไปนะครับ ขอบคุณที่สนใจครับ 🙏`;
}

async function handleServiceHandoff({ collected, platform, userId, replyContext }) {
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
    return "ขอโทษครับ ตอนนี้ยังหาสาขาที่รับนัดซ่อมให้ไม่ได้ เดี๋ยวทีมงานติดต่อกลับไปนะครับ 🙏";
  }

  const dateStr = normalizeDate(rawMessageDateHint(collected));
  const existing = await store.getBookingsForBranchDate(assignedBranch.id, dateStr);
  if (assignedBranch.maxServiceSlotsPerDay && existing.length >= Number(assignedBranch.maxServiceSlotsPerDay)) {
    return `ขอโทษครับ คิวช่างที่สาขา${assignedBranch.name}วันที่เลือกเต็มแล้ว รบกวนเลือกวันอื่น หรือให้ทีมงานติดต่อกลับไปช่วยจัดคิวนะครับ`;
  }

  const booking = {
    platform,
    customerId: userId,
    branchId: assignedBranch.id,
    serviceDate: dateStr,
    issue: collected.model_or_issue || null,
    phone: collected.phone || null,
    status: "New",
  };
  await store.appendBooking(booking);

  const notifyText =
    "🔧 นัดซ่อมใหม่ (" + platform + ")\n" +
    "สาขา: " + assignedBranch.name + "\n" +
    "วันที่นัด: " + (dateStr || "ยังไม่ระบุ") + "\n" +
    "อาการ/งาน: " + (collected.model_or_issue || "-") + "\n" +
    "เบอร์ลูกค้า: " + (collected.phone || "-");

  // นัดซ่อมยังแจ้งเข้ากลุ่มสาขาเหมือนเดิม (ไม่ผูกกับพนักงานคนเดียว)
  await safePushLine(assignedBranch.lineGroupId, notifyText);

  return `รับทราบครับ นัดซ่อมสาขา${assignedBranch.name}${dateStr ? " วันที่ " + dateStr : ""} เดี๋ยวทางศูนย์จะติดต่อยืนยันคิวอีกครั้งนะครับ 🙏`;
}

function rawMessageDateHint(collected) {
  return collected.model_or_issue || "";
}

function normalizeDate(text) {
  if (!text) return "";
  const m = text.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : "";
}

// ส่งไลน์ตรงหาเซลที่ได้รับมอบหมาย พร้อมปุ่ม "รับทราบแล้ว" ผูกกับ leadId
// ถ้าเซลคนนี้ยังไม่ได้ลงทะเบียน lineUserId (ยังไม่เคยทัก "ลงทะเบียน <รหัสพนักงาน>" มาที่ OA)
// จะ fallback ไปแจ้งกลุ่มสาขาแทน กันไม่ให้ lead หลุดหาย
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
  if (branch) {
    await safePushLine(branch.lineGroupId, "⚠️ (เซลยังไม่ได้ลงทะเบียนไลน์) " + text);
  }
}

async function safePushLine(groupId, text) {
  if (!groupId || groupId.includes("ใส่ของจริง")) {
    console.warn("[router] ยังไม่ได้ตั้งค่า lineGroupId จริง ข้ามการแจ้งเตือน");
    console.log("[router] ข้อความที่ควรจะส่ง:", text);
    return;
  }
  try {
    await line.pushMessage(groupId, text);
  } catch (err) {
    console.error("[router] safePushLine error:", err.message);
  }
}

module.exports = { handleTurn };
