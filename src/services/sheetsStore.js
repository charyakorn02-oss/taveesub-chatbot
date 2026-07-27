const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

let docPromise = null;

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getDoc() {
  if (!docPromise) {
    docPromise = (async () => {
      const jwt = getAuth();
      const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEETS_ID, jwt);
      await doc.loadInfo();
      return doc;
    })();
  }
  return docPromise;
}

async function getRows(sheetName) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[sheetName];
  if (!sheet) return [];
  return sheet.getRows();
}

function rowToObject(row) {
  return row.toObject();
}

function genId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
}

// --- Branches ---
async function getActiveBranches() {
  const rows = await getRows('Branches');
  return rows.map(rowToObject).filter((r) => String(r.active).toUpperCase() === 'TRUE');
}

async function getBranchById(id) {
  const branches = await getActiveBranches();
  return branches.find((b) => b.id === id) || null;
}

async function getAllBranches() {
  const rows = await getRows('Branches');
  return rows.map(rowToObject);
}

// --- Staff ---
async function getActiveStaff() {
  const rows = await getRows('Staff');
  return rows.map(rowToObject).filter((r) => String(r.active).toUpperCase() === 'TRUE');
}

async function getStaffForBranch(branchId, role) {
  const staff = await getActiveStaff();
  return staff.filter((s) => s.branchId === branchId && (!role || String(s.role || '').trim() === role));
}

async function getSupervisorForBranch(branchId) {
  const supervisors = await getStaffForBranch(branchId, 'supervisor');
  return supervisors.find((s) => s.lineUserId) || supervisors[0] || null;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / maxLen;
}

async function findStaffMatches(name, roleFilter) {
  if (!name) return [];
  let staff = await getActiveStaff();
  if (roleFilter) {
    staff = staff.filter((s) => String(s.role || '').trim() === roleFilter);
  }
  const query = name.trim().toLowerCase();
  if (!query) return [];

  const FUZZY_THRESHOLD = 0.6;
  const scored = staff
    .map((s) => {
      const staffName = (s.name || '').trim().toLowerCase();
      if (!staffName) return { staff: s, score: 0 };
      if (staffName.includes(query) || query.includes(staffName)) {
        return { staff: s, score: 1 };
      }
      return { staff: s, score: nameSimilarity(staffName, query) };
    })
    .filter((r) => r.score >= FUZZY_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  return scored.map((r) => r.staff);
}

async function findStaffById(id) {
  const rows = await getRows('Staff');
  const row = rows.find((r) => r.get('id') === id);
  return row ? rowToObject(row) : null;
}

// หาพนักงานจาก LINE userId ส่วนตัว (ใช้ตอนพนักงานพิมพ์ "รับทราบแล้ว" เป็นข้อความเอง ไม่ได้กดปุ่ม -> ต้องรู้ก่อนว่าไลน์นี้คือใคร)
async function findStaffByLineUserId(lineUserId) {
  if (!lineUserId) return null;
  const rows = await getRows('Staff');
  const row = rows.find((r) => r.get('lineUserId') === lineUserId);
  return row ? rowToObject(row) : null;
}

async function setStaffLineUserId(staffId, lineUserId) {
  const rows = await getRows('Staff');
  const row = rows.find((r) => r.get('id') === staffId);
  if (!row) return false;
  row.set('lineUserId', lineUserId);
  await row.save();
  return true;
}

async function isLineUserIdTaken(lineUserId) {
  if (!lineUserId) return false;
  const staffRows = await getRows('Staff');
  return staffRows.some((r) => r.get('lineUserId') === lineUserId);
}

async function pickNextInQueue(branchId) {
  const staff = await getStaffForBranch(branchId, 'sales');
  if (staff.length === 0) return null;
  const sorted = staff.slice().sort((a, b) => {
    const aCount = Number(a.openLeadsCount || 0);
    const bCount = Number(b.openLeadsCount || 0);
    if (aCount !== bCount) return aCount - bCount;
    const aTime = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
    const bTime = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
    return aTime - bTime;
  });
  return sorted[0];
}

async function incrementOpenLeadsCount(staffId) {
  const rows = await getRows('Staff');
  const row = rows.find((r) => r.get('id') === staffId);
  if (!row) return;
  const current = Number(row.get('openLeadsCount') || 0);
  row.set('openLeadsCount', current + 1);
  row.set('lastAssignedAt', new Date().toISOString());
  await row.save();
}

async function pickNextInTradeInQueue(branchId) {
  const staff = await getStaffForBranch(branchId, 'sales');
  if (staff.length === 0) return null;
  const sorted = staff.slice().sort((a, b) => {
    const aCount = Number(a.openTradeInCount || 0);
    const bCount = Number(b.openTradeInCount || 0);
    if (aCount !== bCount) return aCount - bCount;
    const aTime = a.lastAssignedTradeInAt ? new Date(a.lastAssignedTradeInAt).getTime() : 0;
    const bTime = b.lastAssignedTradeInAt ? new Date(b.lastAssignedTradeInAt).getTime() : 0;
    return aTime - bTime;
  });
  return sorted[0];
}

async function incrementOpenTradeInCount(staffId) {
  const rows = await getRows('Staff');
  const row = rows.find((r) => r.get('id') === staffId);
  if (!row) return;
  const current = Number(row.get('openTradeInCount') || 0);
  row.set('openTradeInCount', current + 1);
  row.set('lastAssignedTradeInAt', new Date().toISOString());
  await row.save();
}

async function pickNextInPartsQueue(branchId) {
  const staff = await getStaffForBranch(branchId, 'parts');
  if (staff.length === 0) return null;
  const sorted = staff.slice().sort((a, b) => {
    const aCount = Number(a.openPartsCount || 0);
    const bCount = Number(b.openPartsCount || 0);
    if (aCount !== bCount) return aCount - bCount;
    const aTime = a.lastAssignedPartsAt ? new Date(a.lastAssignedPartsAt).getTime() : 0;
    const bTime = b.lastAssignedPartsAt ? new Date(b.lastAssignedPartsAt).getTime() : 0;
    return aTime - bTime;
  });
  return sorted[0];
}

async function incrementOpenPartsCount(staffId) {
  const rows = await getRows('Staff');
  const row = rows.find((r) => r.get('id') === staffId);
  if (!row) return;
  const current = Number(row.get('openPartsCount') || 0);
  row.set('openPartsCount', current + 1);
  row.set('lastAssignedPartsAt', new Date().toISOString());
  await row.save();
}

// --- FAQ / Models ---
async function getFaqList() {
  const rows = await getRows('FAQ');
  return rows.map(rowToObject);
}

async function getModelList() {
  const rows = await getRows('Models');
  return rows.map(rowToObject);
}

// --- Leads ---
async function appendLead(lead) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle['Leads'];
  const leadId = genId('LD');
  const now = new Date().toISOString();
  await sheet.addRow({
    createdAt: now,
    platform: lead.platform || '',
    customerId: lead.customerId || '',
    customerName: lead.customerName || '',
    intentCategory: lead.intentCategory || '',
    modelOrIssue: lead.modelOrIssue || '',
    branchId: lead.branchId || '',
    staffName: lead.staffName || '',
    staffPhone: lead.staffPhone || '',
    phone: lead.phone || '',
    locationText: lead.locationText || '',
    status: lead.status || 'new',
    leadId,
    notifiedAt: now,
    acknowledgedAt: '',
    responseTimeMin: '',
    escalatedAt: '',
  });
  return leadId;
}

// เซล/หัวหน้าสาขา กดปุ่ม/พิมพ์รับทราบผ่าน LINE -> บันทึกเวลาที่ตอบกลับ และคำนวณว่าใช้เวลากี่นาที
// ทุก lead มี leadId เฉพาะตัวของตัวเอง ต่อให้แจ้งเตือนหลายคน (เซล+หัวหน้าสาขา) การรับทราบก็ยังผูกกับ lead เดียวกันนี้เท่านั้น ไม่ปนกับ lead อื่น
async function acknowledgeLead(leadId) {
  const rows = await getRows('Leads');
  const row = rows.find((r) => r.get('leadId') === leadId);
  if (!row) return null;

  if (row.get('acknowledgedAt')) {
    return {
      staffName: row.get('staffName'),
      branchId: row.get('branchId'),
      responseTimeMin: row.get('responseTimeMin'),
      alreadyAcknowledged: true,
    };
  }

  const notifiedAt = row.get('notifiedAt');
  const now = new Date();
  const diffMin = notifiedAt ? (now.getTime() - new Date(notifiedAt).getTime()) / 60000 : null;
  const diffStr = diffMin !== null ? diffMin.toFixed(1) : '';

  row.set('acknowledgedAt', now.toISOString());
  row.set('responseTimeMin', diffStr);
  row.set('status', 'acknowledged');
  await row.save();

  return { staffName: row.get('staffName'), branchId: row.get('branchId'), responseTimeMin: diffStr, alreadyAcknowledged: false };
}

async function getPendingEscalations(thresholdMinutes) {
  const rows = await getRows('Leads');
  const now = Date.now();
  const pending = [];

  for (const row of rows) {
    const obj = rowToObject(row);
    if (!obj.notifiedAt) continue;
    if (obj.acknowledgedAt) continue;
    if (obj.escalatedAt) continue;
    if (obj.status === 'cancelled') continue; // lead ที่ถูกยกเลิกไปแล้ว (เช่น ส่งผิดแผนก) ไม่ต้องตามต่อ

    const notifiedTime = new Date(obj.notifiedAt).getTime();
    if (Number.isNaN(notifiedTime)) continue;

    const diffMin = (now - notifiedTime) / 60000;
    if (diffMin >= thresholdMinutes) {
      pending.push(obj);
    }
  }
  return pending;
}

async function markLeadEscalated(leadId) {
  const rows = await getRows('Leads');
  const row = rows.find((r) => r.get('leadId') === leadId);
  if (!row) return false;
  row.set('escalatedAt', new Date().toISOString());
  await row.save();
  return true;
}

// ลูกค้าแจ้งว่า Lead นี้ถูกส่งผิดแผนกไป (เช่น ต้องการอะไหล่/บริการ แต่ระบบส่งเข้าคิวเซลฝ่ายขาย) -> ยกเลิก lead เดิมตรงนี้
async function cancelLead(leadId) {
  const rows = await getRows('Leads');
  const row = rows.find((r) => r.get('leadId') === leadId);
  if (!row) return false;
  row.set('status', 'cancelled');
  await row.save();
  return true;
}

// คืนคิวให้เซล/เซลเทิร์นรถ หลังจากยกเลิก lead ที่เคยส่งให้เขาผิดพลาด (ตรงข้ามกับ incrementOpenLeadsCount/incrementOpenTradeInCount)
async function decrementOpenLeadsCount(staffId) {
  const rows = await getRows('Staff');
  const row = rows.find((r) => r.get('id') === staffId);
  if (!row) return;
  const current = Number(row.get('openLeadsCount') || 0);
  row.set('openLeadsCount', Math.max(0, current - 1));
  await row.save();
}

async function decrementOpenTradeInCount(staffId) {
  const rows = await getRows('Staff');
  const row = rows.find((r) => r.get('id') === staffId);
  if (!row) return;
  const current = Number(row.get('openTradeInCount') || 0);
  row.set('openTradeInCount', Math.max(0, current - 1));
  await row.save();
}

// --- Bookings ---
// แท็บ Bookings มีชุดคอลัมน์รับทราบ (bookingId/notifiedAt/acknowledgedAt/responseTimeMin/escalatedAt) เหมือนแท็บ Leads
// เพื่อให้นัดซ่อมมีปุ่ม "รับทราบแล้ว" และเข้า job escalation ได้เหมือนกันทุกอย่าง ไม่ใช่แค่ lead ขาย/เทิร์นรถ
async function getBookingsForBranchDate(branchId, serviceDate) {
  const rows = await getRows('Bookings');
  return rows.map(rowToObject).filter((r) => r.branchId === branchId && r.serviceDate === serviceDate);
}

async function appendBooking(booking) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle['Bookings'];
  const bookingId = genId('BK');
  const now = new Date().toISOString();
  await sheet.addRow({
    createdAt: now,
    platform: booking.platform || '',
    customerId: booking.customerId || '',
    branchId: booking.branchId || '',
    serviceDate: booking.serviceDate || '',
    issue: booking.issue || '',
    phone: booking.phone || '',
    status: booking.status || 'new',
    staffName: booking.staffName || '',
    staffPhone: booking.staffPhone || '',
    customerName: booking.customerName || '',
    bookingId,
    notifiedAt: now,
    acknowledgedAt: '',
    responseTimeMin: '',
    escalatedAt: '',
  });
  return bookingId;
}

// ทีมอะไหล่/หัวหน้าสาขา กดปุ่มรับทราบนัดซ่อม -> เหมือน acknowledgeLead แต่ทำงานกับแท็บ Bookings
async function acknowledgeBooking(bookingId) {
  const rows = await getRows('Bookings');
  const row = rows.find((r) => r.get('bookingId') === bookingId);
  if (!row) return null;

  if (row.get('acknowledgedAt')) {
    return {
      staffName: row.get('staffName'),
      branchId: row.get('branchId'),
      responseTimeMin: row.get('responseTimeMin'),
      alreadyAcknowledged: true,
    };
  }

  const notifiedAt = row.get('notifiedAt');
  const now = new Date();
  const diffMin = notifiedAt ? (now.getTime() - new Date(notifiedAt).getTime()) / 60000 : null;
  const diffStr = diffMin !== null ? diffMin.toFixed(1) : '';

  row.set('acknowledgedAt', now.toISOString());
  row.set('responseTimeMin', diffStr);
  row.set('status', 'acknowledged');
  await row.save();

  return { staffName: row.get('staffName'), branchId: row.get('branchId'), responseTimeMin: diffStr, alreadyAcknowledged: false };
}

// ลูกค้าขอเปลี่ยนสาขานัดซ่อมภายหลัง -> ยกเลิกนัดเดิมตรงนี้ (ไม่นับเป็น escalation ต่อ เพราะปิดเคสแล้ว ไม่ใช่แค่รับทราบ)
async function cancelBooking(bookingId) {
  const rows = await getRows('Bookings');
  const row = rows.find((r) => r.get('bookingId') === bookingId);
  if (!row) return false;
  row.set('status', 'cancelled');
  await row.save();
  return true;
}

// เหมือน getPendingEscalations แต่ตรวจแท็บ Bookings (นัดซ่อม/ทีมอะไหล่) แทน
async function getPendingBookingEscalations(thresholdMinutes) {
  const rows = await getRows('Bookings');
  const now = Date.now();
  const pending = [];

  for (const row of rows) {
    const obj = rowToObject(row);
    if (!obj.notifiedAt) continue;
    if (obj.acknowledgedAt) continue;
    if (obj.escalatedAt) continue;
    if (obj.status === 'cancelled') continue; // นัดที่ลูกค้าขอเปลี่ยน/ยกเลิกไปแล้ว ไม่ต้องตามต่อ

    const notifiedTime = new Date(obj.notifiedAt).getTime();
    if (Number.isNaN(notifiedTime)) continue;

    const diffMin = (now - notifiedTime) / 60000;
    if (diffMin >= thresholdMinutes) {
      pending.push(obj);
    }
  }
  return pending;
}

async function markBookingEscalated(bookingId) {
  const rows = await getRows('Bookings');
  const row = rows.find((r) => r.get('bookingId') === bookingId);
  if (!row) return false;
  row.set('escalatedAt', new Date().toISOString());
  await row.save();
  return true;
}

// หางาน (lead/booking) ทั้งหมดของพนักงานคนนี้ (แมตช์จากชื่อ+สาขา เพราะ Leads/Bookings เก็บ staffName เป็นข้อความ ไม่ใช่ staffId)
// ที่ยังไม่มีใครกดรับทราบเลย เรียงจากเก่าไปใหม่ (งานที่ค้างนานที่สุดขึ้นก่อน) ใช้ตอนส่งแจ้งเตือนงานใหม่ให้คนเดิม
// จะได้แนบงานค้างเก่ามาในข้อความเดียวกันเสมอ ไม่ให้หลุดไปเงียบๆ หลังมีข้อความใหม่มาทับปุ่มเก่า
async function getPendingRefsForStaff(staffName, branchId, excludeId) {
  if (!staffName || !branchId) return [];

  const leadRows = await getRows('Leads');
  const leadPending = leadRows
    .map(rowToObject)
    .filter(
      (r) =>
        r.staffName === staffName &&
        r.branchId === branchId &&
        !r.acknowledgedAt &&
        r.status !== 'cancelled' &&
        r.leadId !== excludeId
    )
    .map((r) => ({
      refId: r.leadId,
      type: 'lead',
      customerName: r.customerName,
      detail: r.modelOrIssue,
      notifiedAt: r.notifiedAt,
    }));

  const bookingRows = await getRows('Bookings');
  const bookingPending = bookingRows
    .map(rowToObject)
    .filter(
      (r) =>
        r.staffName === staffName &&
        r.branchId === branchId &&
        !r.acknowledgedAt &&
        r.status !== 'cancelled' &&
        r.bookingId !== excludeId
    )
    .map((r) => ({
      refId: r.bookingId,
      type: 'booking',
      customerName: r.customerName,
      detail: r.issue,
      notifiedAt: r.notifiedAt,
    }));

  return [...leadPending, ...bookingPending].sort(
    (a, b) => new Date(a.notifiedAt || 0).getTime() - new Date(b.notifiedAt || 0).getTime()
  );
}

module.exports = {
  getActiveBranches,
  getBranchById,
  getAllBranches,
  getActiveStaff,
  getSupervisorForBranch,
  findStaffMatches,
  findStaffById,
  findStaffByLineUserId,
  setStaffLineUserId,
  isLineUserIdTaken,
  getStaffForBranch,
  pickNextInQueue,
  incrementOpenLeadsCount,
  pickNextInTradeInQueue,
  incrementOpenTradeInCount,
  pickNextInPartsQueue,
  incrementOpenPartsCount,
  getFaqList,
  getModelList,
  appendLead,
  acknowledgeLead,
  getPendingEscalations,
  markLeadEscalated,
  cancelLead,
  decrementOpenLeadsCount,
  decrementOpenTradeInCount,
  getBookingsForBranchDate,
  appendBooking,
  acknowledgeBooking,
  cancelBooking,
  getPendingBookingEscalations,
  markBookingEscalated,
  getPendingRefsForStaff,
};
