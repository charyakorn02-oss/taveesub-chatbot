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
 * customerName: ชื่อโปรไฟล์ลูกค้าจากแพลตฟอร์มนั้นๆ (LINE display name / Facebook ชื่อ-นามสกุล) เอาไว้บันทึกลง Lead
 */
async function handleTurn({ session, analysis, rawMessage, platform, userId, customerName, replyContext }) {
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
  return performHandoff({ collected, platform, userId, customerName, replyContext, highIntent });
}

async function performHandoff({ collected, platform, userId, customerName, replyContext, highIntent }) {
  const intent = collected.intent_category || "general";
  if (intent === "buying_new" || intent === "trade_in") {
    return handleSalesHandoff({ collected, intent, platform, userId, customerName, replyContext, highIntent });
  }
  if (intent === "service") {
    return handleServiceHandoff({ collected, platform, userId, customerName, replyContext });
  }
  return "เดี๋ยวให้ทีมงานติดต่อกลับไปนะครับ ขอบคุณที่ทักมาครับ 🙏";
}

async function handleSalesHandoff({ collected, intent, platform, userId, customerName, replyContext, highIntent }) {
  let assignedStaff = null;
  let assignedBranch = null;
  let routingMethod = "round_robin";

  if (collected.requested_staff_name) {
    const staff = await store.findStaffByNameFuzzy(collected.requested_staff_name);
    if (staff) {
      assignedStaff = staff;
      assignedBranch = await store.getBranchById(staff.branchId);
      routingMethod = "requested";
    }
  }

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
  const notifyText =
    badge +
    "🔔 Lead ใหม่ (" + platform + ")\n" +
    customerNameNote +
    "สาขา: " + assignedBranch.name + "\n" +
    "รุ่นที่สนใจ: " + (collected.model_or_issue || "-") + "\n" +
    deliveryNote +
    "ที่อยู่ลูกค้า: " + (collected.location_text || "-") + "\n" +
    "เบอร์ลูกค้า: " + (collected.phone || "-") + "\n" +
    "Lead ID: " + leadId;

  await notifyStaffDirect(assignedStaff, notifyText, leadId);

  const deliveryLine = collected.delivery_preference ? `เรื่อง${collected.delivery_preference}` : "";
  const addLineNote = assignedStaff.lineAddUrl
    ? `\nแอดไลน์ ${assignedStaff.name} คุยต่อได้เลยครับ: ${assignedStaff.lineAddUrl}`
    : "";

  return `เรียบร้อยครับ! ${deliveryLine}เดี๋ยว ${assignedStaff.name} (${assignedStaff.phone || "รอเบอร์ติดต่อ"}) จะติดต่อพี่กลับไปนะครับ${addLineNote} ขอบคุณที่สนใจครับ 🙏`;
}

// นัดซ่อม: ลูกค้าพิมพ์รุ่นรถ/อาการเข้ามา บอทหาสาขาที่ใกล้ที่สุด แล้วส่งรายละเอียดตรงไปหา
// ไลน์ทีมอะไหล่ประจำสาขานั้น (ถ้าทีมอะไหล่ยังไม่ได้ลงทะเบียนไลน์ จะ fallback ไปแจ้งกลุ่มสาขาแทน)
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
  await safePushLine(branch.lineGroupId, "⚠️ (ทีมอะไหล่ยังไม่ได้ลงทะเบียนไลน์) " + text);
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
