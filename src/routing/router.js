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

  const highIntent = containsHighIntentKeyword(rawMessage);
  const shouldHandoff = Boolean(analysis.data_complete) || highIntent || session.fallbackCount >= FALLBACK_LIMIT;

  if (!shouldHandoff) {
    session.fallbackCount = (session.fallbackCount || 0) + 1;
    return analysis.reply_text_to_customer || "ขอบคุณที่ทักมานะคะ แอดมินขอสอบถามเพิ่มเติมนิดนึงนะคะ พี่สนใจรุ่นไหน หรืออยากนัดซ่อมแบบไหนคะ";
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
  return "แอดมินรับเรื่องไว้แล้วนะคะ เดี๋ยวให้ทีมงานติดต่อกลับไปนะคะ ขอบคุณที่ทักมาคุยกับแอดมินนะคะ 🙏";
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
async function handleServiceHandoff({ collected, platform, userId, customerName, replyContext }) {
  const branches = await store.getActiveBranches();
  let assignedBranch = null;
  const finalCustomerName = resolveCustomerName(collected, customerName);

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
  };
  await store.appendBooking(booking);

  const customerNameNote = finalCustomerName ? `ชื่อลูกค้า (${platform}): ${finalCustomerName}\n` : "";
  const notifyText =
    "🔧 นัดซ่อมใหม่ (" + platform + ")\n" +
    customerNameNote +
    "สาขา: " + assignedBranch.name + "\n" +
    "วันที่นัด: " + (dateStr || "ยังไม่ระบุ") + "\n" +
    "รุ่นรถ/อาการ: " + (collected.model_or_issue || "-") + "\n" +
    "เบอร์ลูกค้า: " + (collected.phone || "-") + "\n" +
    "(ทีมอะไหล่รบกวนเช็กสต๊อกอะไหล่/อุปกรณ์ที่ต้องใช้ล่วงหน้าให้ด้วยนะคะ)";

  await notifyPartsDirect(assignedBranch, assignedPartsStaff, notifyText);

  const nameGreeting = finalCustomerName ? `คุณ${finalCustomerName} ` : "";
  const partsAddLineNote = assignedPartsStaff && assignedPartsStaff.lineAddUrl
    ? `\n\nแอดไลน์ทีมอะไหล่ไว้คุยต่อได้เลยนะคะ: ${assignedPartsStaff.lineAddUrl}`
    : "";

  return `แอดมินรับข้อมูลนัดซ่อมของ${nameGreeting}เรียบร้อยแล้วนะคะ 😊 สาขา${assignedBranch.name}${dateStr ? " วันที่ " + dateStr : ""} เดี๋ยวทางศูนย์จะติดต่อกลับไปยืนยันคิวอีกครั้งเร็วๆ นี้นะคะ${partsAddLineNote}\n\nขอบคุณที่ไว้วางใจนะคะ 🙏`;
}

function normalizeDate(text) {
  if (!text) return "";
  const m = text.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : "";
}

// ส่งแจ้งเตือน Lead ตรงถึงไลน์ส่วนตัวเซล ถ้าเซลยังไม่ได้ลงทะเบียนไลน์
// ให้ fallback ไปแจ้งหัวหน้าสาขา (role=supervisor ในแท็บ Staff) แทนทันที
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
      await line.pushMessage(supervisor.lineUserId, `⚠️ (เซล ${staff.name} ยังไม่ได้ลงทะเบียนไลน์) ` + text);
      return;
    } catch (err) {
      console.error("[router] notifyStaffDirect supervisor fallback error:", err.message);
    }
  } else {
    console.warn(`[router] สาขา ${staff.branchId} ยังไม่ได้ลงทะเบียนหัวหน้าสาขา (role=supervisor) ข้อความหลุด:`, text);
  }
}

// ส่งแจ้งเตือนนัดซ่อมตรงถึงไลน์ส่วนตัวทีมอะไหล่ที่ถูกเลือกจากคิว (role=parts)
// ถ้าคนนั้นยังไม่ได้ลงทะเบียนไลน์ หรือสาขานั้นไม่มีทีมอะไหล่เลย ให้ fallback ไปแจ้งหัวหน้าสาขาแทนทันที
async function notifyPartsDirect(branch, partsStaff, text) {
  if (partsStaff && partsStaff.lineUserId) {
    try {
      await line.pushMessage(partsStaff.lineUserId, text);
      return;
    } catch (err) {
      console.error("[router] notifyPartsDirect pushMessage error:", err.message);
    }
  } else if (partsStaff) {
    console.warn(`[router] ทีมอะไหล่ ${partsStaff.name} (${partsStaff.id}) ยังไม่ได้ลงทะเบียน lineUserId`);
  } else {
    console.warn(`[router] สาขา ${branch.name} (${branch.id}) ไม่มีทีมอะไหล่ (role=parts) ในระบบเลย`);
  }
  const supervisor = await store.getSupervisorForBranch(branch.id);
  if (supervisor && supervisor.lineUserId) {
    try {
      await line.pushMessage(supervisor.lineUserId, "⚠️ (ทีมอะไหล่ยังไม่ได้ลงทะเบียนไลน์) " + text);
      return;
    } catch (err) {
      console.error("[router] notifyPartsDirect supervisor fallback error:", err.message);
    }
  } else {
    console.warn(`[router] สาขา ${branch.name} (${branch.id}) ยังไม่ได้ลงทะเบียนหัวหน้าสาขา (role=supervisor) ข้อความหลุด:`, text);
  }
}

module.exports = { handleTurn };
