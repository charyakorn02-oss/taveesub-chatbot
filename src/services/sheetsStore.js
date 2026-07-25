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

// ทุกสาขา ไม่กรอง active (ใช้ตอนลงทะเบียนหัวหน้าสาขา/อะไหล่ เผื่อสาขายังไม่เปิด active)
async function getAllBranches() {
  const rows = await getRows('Branches');
  return rows.map(rowToObject);
}

// หัวหน้าสาขาลงทะเบียน LINE userId ของตัวเอง (ทักบอทด้วยคำว่า "ลงทะเบียนหัวหน้า <รหัสสาขา> <PIN>")
async function setBranchSupervisorLineUserId(branchId, lineUserId) {
  const rows = await getRows('Branches');
  const row = rows.find((r) => r.get('id') === branchId);
  if (!row) return false;
  row.set('supervisorLineUserId', lineUserId);
  await row.save();
  return true;
}

// ทีมอะไหล่ประจำสาขาลงทะเบียน LINE userId ของตัวเอง (ทักบอทด้วยคำว่า "ลงทะเบียนอะไหล่ <รหัสสาขา> <PIN>")
// ใช้ตอนมีลูกค้าจองคิวซ่อม บอทจะส่งรายละเอียดรถ/อาการไปหาไลน์นี้โดยตรง
async function setBranchPartsLineUserId(branchId, lineUserId) {
  const rows = await getRows('Branches');
  const row = rows.find((r) => r.get('id') === branchId);
  if (!row) return false;
  row.set('partsLineUserId', lineUserId);
  await row.save();
  return true;
}

// --- Staff ---
async function getActiveStaff() {
  const rows = await getRows('Staff');
  return rows.map(rowToObject).filter((r) => String(r.active).toUpperCase() === 'TRUE');
}

async function getStaffForBranch(branchId) {
  const staff = await getActiveStaff();
  return staff.filter((s) => s.branchId === branchId);
}

// คำนวณระยะห่างระหว่างข้อความ 2 ก้อน (Levenshtein edit distance) เอาไว้เทียบชื่อที่ลูกค้าพิมพ์คลาดเคลื่อนเล็กน้อย
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

// คะแนนความคล้าย 0-1 (1 คือเหมือนกันเป๊ะ) ใช้ตัดสินว่าชื่อที่พิมพ์มาน่าจะพิมพ์ผิดจากชื่อจริงคนไหน
function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / maxLen;
}

// หาพนักงานที่ชื่อตรง หรือ "ใกล้เคียง" กับชื่อที่ลูกค้าพิมพ์มา (รองรับพิมพ์ผิด/สะกดคลาดเคลื่อนเล็กน้อย เช่น ขวัญ/ขวัน)
// คืนค่าเป็นรายการพนักงานทั้งหมดที่เข้าเกณฑ์ เรียงจากตรงที่สุดก่อน เผื่อกรณีชื่อซ้ำ/คล้ายกันหลายคน
// ผู้เรียก (router.js) เป็นคนตัดสินใจว่าถ้าเจอมากกว่า 1 คนจะถามลูกค้าว่าสาขาไหน
async function findStaffMatches(name) {
  if (!name) return [];
  const staff = await getActiveStaff();
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

// พนักงานลงทะเบียน LINE userId ของตัวเอง (ทักบอทด้วยคำว่า "ลงทะเบียน <รหัสพนักงาน> <PIN>")
async function setStaffLineUserId(staffId, lineUserId) {
  const rows = await getRows('Staff');
  const row = rows.find((r) => r.get('id') === staffId);
  if (!row) return false;
  row.set('lineUserId', lineUserId);
  await row.save();
  return true;
}

// เช็คว่า LINE userId นี้เคยถูกผูกไว้กับตำแหน่งอื่น (เซล/หัวหน้าสาขา/ทีมอะไหล่) ไปแล้วหรือยัง
// ใช้ตอนลงทะเบียนใหม่ทุกครั้ง เพื่อกันไม่ให้ไลน์เดียวไปผูกได้หลายตำแหน่ง (1 คน 1 ตำแหน่งเท่านั้น)
async function isLineUserIdTaken(lineUserId) {
  if (!lineUserId) return false;
  const staffRows = await getRows('Staff');
  if (staffRows.some((r) => r.get('lineUserId') === lineUserId)) return true;
  const branchRows = await getRows('Branches');
  if (
    branchRows.some(
      (r) => r.get('supervisorLineUserId') === lineUserId || r.get('partsLineUserId') === lineUserId
    )
  ) {
    return true;
  }
  return false;
}

// เลือกพนักงานคนถัดไปในคิว "ขายรถใหม่" ของสาขานั้น (งานน้อยสุดก่อน ถ้าเท่ากันดูใครว่างนานสุด)
async function pickNextInQueue(branchId) {
  const staff = await getStaffForBranch(branchId);
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

// เลือกพนักงานคนถัดไปในคิว "เทิร์นรถ" ของสาขานั้น แยกจากคิวขายรถใหม่โดยเฉพาะ
// (ใช้คอลัมน์ openTradeInCount / lastAssignedTradeInAt คนละชุดกับ openLeadsCount / lastAssignedAt)
async function pickNextInTradeInQueue(branchId) {
  const staff = await getStaffForBranch(branchId);
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
// สร้าง lead ใหม่ + คืน leadId กลับไป เพื่อเอาไปผูกกับปุ่ม "รับทราบแล้ว" ตอนส่ง LINE หาเซล
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

// เซลกดปุ่ม/พิมพ์รับทราบผ่าน LINE -> บันทึกเวลาที่ตอบกลับ และคำนวณว่าใช้เวลากี่นาที
async function acknowledgeLead(leadId) {
  const rows = await getRows('Leads');
  const row = rows.find((r) => r.get('leadId') === leadId);
  if (!row) return null;

  if (row.get('acknowledgedAt')) {
    return {
      staffName: row.get('staffName'),
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

  return { staffName: row.get('staffName'), responseTimeMin: diffStr, alreadyAcknowledged: false };
}

// เอาไว้ให้ job ตรวจสอบเป็นระยะๆ ว่า lead ไหนเซลยังไม่รับทราบเกินเวลาที่กำหนด (นาที) แล้วยังไม่เคยแจ้งหัวหน้ามาก่อน
async function getPendingEscalations(thresholdMinutes) {
  const rows = await getRows('Leads');
  const now = Date.now();
  const pending = [];

  for (const row of rows) {
    const obj = rowToObject(row);
    if (!obj.notifiedAt) continue;
    if (obj.acknowledgedAt) continue;
    if (obj.escalatedAt) continue;

    const notifiedTime = new Date(obj.notifiedAt).getTime();
    if (Number.isNaN(notifiedTime)) continue;

    const diffMin = (now - notifiedTime) / 60000;
    if (diffMin >= thresholdMinutes) {
      pending.push(obj);
    }
  }
  return pending;
}

// บันทึกว่า lead นี้ถูกแจ้งเตือนหัวหน้าสาขาไปแล้ว (กันแจ้งซ้ำ)
async function markLeadEscalated(leadId) {
  const rows = await getRows('Leads');
  const row = rows.find((r) => r.get('leadId') === leadId);
  if (!row) return false;
  row.set('escalatedAt', new Date().toISOString());
  await row.save();
  return true;
}

// --- Bookings ---
async function getBookingsForBranchDate(branchId, serviceDate) {
  const rows = await getRows('Bookings');
  return rows.map(rowToObject).filter((r) => r.branchId === branchId && r.serviceDate === serviceDate);
}

async function appendBooking(booking) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle['Bookings'];
  await sheet.addRow({
    createdAt: new Date().toISOString(),
    platform: booking.platform || '',
    customerId: booking.customerId || '',
    branchId: booking.branchId || '',
    serviceDate: booking.serviceDate || '',
    issue: booking.issue || '',
    phone: booking.phone || '',
    status: booking.status || 'new',
  });
}

module.exports = {
  getActiveBranches,
  getBranchById,
  getAllBranches,
  setBranchSupervisorLineUserId,
  setBranchPartsLineUserId,
  getActiveStaff,
  findStaffMatches,
  findStaffById,
  setStaffLineUserId,
  isLineUserIdTaken,
  getStaffForBranch,
  pickNextInQueue,
  incrementOpenLeadsCount,
  pickNextInTradeInQueue,
  incrementOpenTradeInCount,
  getFaqList,
  getModelList,
  appendLead,
  acknowledgeLead,
  getPendingEscalations,
  markLeadEscalated,
  getBookingsForBranchDate,
  appendBooking,
};
