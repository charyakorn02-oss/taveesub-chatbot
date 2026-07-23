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

// ทุกสาขา ไม่กรอง active (ใช้ตอนลงทะเบียนหัวหน้าสาขา เผื่อสาขายังไม่เปิด active)
async function getAllBranches() {
  const rows = await getRows('Branches');
  return rows.map(rowToObject);
}

// หัวหน้าสาขาลงทะเบียน LINE userId ของตัวเอง (ทักบอทด้วยคำว่า "ลงทะเบียนหัวหน้า <รหัสสาขา>")
async function setBranchSupervisorLineUserId(branchId, lineUserId) {
  const rows = await getRows('Branches');
  const row = rows.find((r) => r.get('id') === branchId);
  if (!row) return false;
  row.set('supervisorLineUserId', lineUserId);
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

async function findStaffByNameFuzzy(name) {
  if (!name) return null;
  const staff = await getActiveStaff();
  const lower = name.trim().toLowerCase();
  return staff.find((s) => (s.name || '').toLowerCase().includes(lower)) || null;
}

async function findStaffById(id) {
  const rows = await getRows('Staff');
  const row = rows.find((r) => r.get('id') === id);
  return row ? rowToObject(row) : null;
}

// พนักงานลงทะเบียน LINE userId ของตัวเอง (ทักบอทด้วยคำว่า "ลงทะเบียน <รหัสพนักงาน>")
async function setStaffLineUserId(staffId, lineUserId) {
  const rows = await getRows('Staff');
  const row = rows.find((r) => r.get('id') === staffId);
  if (!row) return false;
  row.set('lineUserId', lineUserId);
  await row.save();
  return true;
}

// เลือกพนักงานคนถัดไปในคิวของสาขานั้น (งานน้อยสุดก่อน ถ้าเท่ากันดูใครว่างนานสุด)
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
  getActiveStaff,
  findStaffByNameFuzzy,
  findStaffById,
  setStaffLineUserId,
  getStaffForBranch,
  pickNextInQueue,
  incrementOpenLeadsCount,
  getFaqList,
  getModelList,
  appendLead,
  acknowledgeLead,
  getPendingEscalations,
  markLeadEscalated,
  getBookingsForBranchDate,
  appendBooking,
};
