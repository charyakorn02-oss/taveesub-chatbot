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

// สร้างเลขที่แบบอ่านง่าย แยกตามสาขา + เลขรัน เช่น "LD-NM90-001", "BK-HQ-002" แทนรหัสยาวๆ แบบเดิม (LD-<timestamp>-<random>)
// นับจากจำนวนแถวที่มี branchId ตรงกันในชีตนั้นๆ (รวมแถวที่ถูกยกเลิกไปแล้วด้วย กันเลขซ้ำ) แล้ว +1 ต่อจากตัวสุดท้าย
// รหัสสาขา (branchCode) ใช้ค่า id ของสาขาจากแท็บ Branches ตรงๆ (ตัวพิมพ์ใหญ่) เพราะเป็นค่าที่ไม่ซ้ำกันอยู่แล้วในระบบ
async function genBranchSeqId(prefix, sheet, existingRows, branchId) {
  const branchCode = String(branchId || 'XX').toUpperCase();
  const count = existingRows.filter((r) => r.get('branchId') === branchId).length;
  const seq = String(count + 1).padStart(3, '0');
  return `${prefix}-${branchCode}-${seq}`;
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

// รองรับพนักงาน 1 คนดูแลได้หลายสาขา: เก็บในคอลัมน์ branchId เป็นค่าคั่นด้วยจุลภาค เช่น "NM90,LL4"
// (พนักงานส่วนใหญ่มีสาขาเดียวก็ยังใช้ได้ปกติ เพราะ split(',') ของ string เดี่ยวๆ ก็ได้ array ยาว 1 ตัวอยู่แล้ว)
function getStaffBranchIds(staff) {
  if (!staff || !staff.branchId) return [];
  return String(staff.branchId)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function staffServesBranch(staff, branchId) {
  return getStaffBranchIds(staff).includes(branchId);
}

async function getStaffForBranch(branchId, role) {
  const staff = await getActiveStaff();
  return staff.filter((s) => staffServesBranch(s, branchId) && (!role || String(s.role || '').trim() === role));
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
  await sheet.loadHeaderRow();
  // เพิ่มคอลัมน์ staffId ให้ชีต Leads อัตโนมัติถ้ายังไม่มี (กันเคสชีตเก่าที่สร้างไว้ก่อนจะมีฟีเจอร์นี้ ไม่ให้ addRow เงียบๆ ทิ้งค่านี้ไป)
  // ใช้จำว่าลูกค้าคนนี้เคยคุยกับเซลคนไหน (อิงตาม staff id เพราะพนักงานอาจย้ายสาขาได้ ผูกกับ id แม่นกว่าผูกกับสาขา)
  if (!sheet.headerValues.includes('staffId')) {
    await sheet.setHeaderRow([...sheet.headerValues, 'staffId']);
  }
  const existingRows = await sheet.getRows();
  const leadId = await genBranchSeqId('LD', sheet, existingRows, lead.branchId);
  const now = new Date().toISOString();
  await sheet.addRow({
    createdAt: now,
    platform: lead.platform || '',
    customerId: lead.customerId || '',
    customerName: lead.customerName || '',
    intentCategory: lead.intentCategory || '',
    modelOrIssue: lead.modelOrIssue || '',
    branchId: lead.branchId || '',
    staffId: lead.staffId || '',
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
  const existingRows = await sheet.getRows();
  const bookingId = await genBranchSeqId('BK', sheet, existingRows, booking.branchId);
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

  // branchId ที่รับเข้ามาอาจเป็นค่าเดียว หรือรายการคั่นด้วยจุลภาค (กรณีพนักงาน 1 คนดูแลหลายสาขา เช่น "NM90,LL4")
  // ใช้ includes() แทนเทียบตรงๆ เพื่อรองรับทั้งสองแบบ ส่วน Lead/Booking แต่ละแถวมี branchId เป็นค่าเดียวเสมอ (สาขาที่ผูกไว้ตอนสร้าง)
  const branchIdList = String(branchId).split(',').map((s) => s.trim()).filter(Boolean);

  const leadRows = await getRows('Leads');
  const leadPending = leadRows
    .map(rowToObject)
    .filter(
      (r) =>
        r.leadId && // กันแถวที่ไม่มีเลขที่ leadId (เช่น แถวว่าง/ข้อมูลตกหล่นในชีต) หลุดเข้ามาแล้วทำให้ acknowledgeAndReply พังตอน .startsWith()
        r.staffName === staffName &&
        branchIdList.includes(r.branchId) &&
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
        r.bookingId && // กันแถวที่ไม่มีเลขที่ bookingId เหมือนกับฝั่ง lead ด้านบน
        r.staffName === staffName &&
        branchIdList.includes(r.branchId) &&
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

// หาข้อมูลติดต่อล่าสุดของลูกค้าคนนี้ (จาก LINE userId เก็บไว้ในคอลัมน์ customerId ของทั้งแท็บ Leads และ Bookings)
// ใช้ตอนลูกค้าทักมาใหม่ (อาจเป็นคนละวัน/คนละเซสชันกับครั้งก่อน) เพื่อถามยืนยันว่าจะใช้สาขา/เบอร์เดิมต่อไหม
// ไม่ได้เอาไว้ข้ามคำถามไปเฉยๆ (ฝั่ง router.js ยังคงถามยืนยันทุกครั้งเสมอ แค่โชว์ข้อมูลเดิมประกอบการถามให้ลูกค้าตัดสินใจง่ายขึ้น)
async function getLatestCustomerRecord(customerId) {
  if (!customerId) return null;
  const [leadRows, bookingRows] = await Promise.all([getRows('Leads'), getRows('Bookings')]);

  const leadRecords = leadRows
    .map(rowToObject)
    .filter((r) => r.customerId === customerId && r.status !== 'cancelled')
    .map((r) => ({
      source: 'lead',
      branchId: r.branchId || null,
      // จำ staffId ที่เคยขายให้ลูกค้าคนนี้ไว้ด้วย (อิงตาม id ไม่ใช่สาขา เพราะพนักงานอาจย้ายสาขาไปแล้วก็ได้ อยากได้คนเดิมอยู่ดี)
      staffId: r.staffId || null,
      phone: r.phone || null,
      customerName: r.customerName || null,
      createdAt: r.createdAt || null,
    }));

  const bookingRecords = bookingRows
    .map(rowToObject)
    .filter((r) => r.customerId === customerId && r.status !== 'cancelled')
    .map((r) => ({
      source: 'booking',
      branchId: r.branchId || null,
      phone: r.phone || null,
      customerName: r.customerName || null,
      createdAt: r.createdAt || null,
    }));

  const all = [...leadRecords, ...bookingRecords].filter((r) => r.branchId || r.phone);
  if (all.length === 0) return null;

  all.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  return all[0];
}

// --- Sessions ---
// เก็บสถานะบทสนทนาที่กำลังคุยอยู่ (collected/history/flags ต่างๆ) ไว้ใน Sheets ด้วย เผื่อรอดจากตอนเซิร์ฟเวอร์รีสตาร์ท
// (เช่น deploy โค้ดใหม่ หรือแพลนฟรีของ Render พักเครื่องอัตโนมัติตอนไม่มีคนใช้ 15 นาที) เดิมเก็บแค่ใน memory (Map) เฉยๆ
// พอรีสตาร์ทปุ๊บข้อมูลหายหมดทันที ทำให้บอทลืมบทสนทนาที่คุยค้างอยู่กลางคัน ถามซ้ำคำถามพื้นฐานที่เพิ่งถามไปแล้ว
async function getSessionData(sessionKey) {
  const rows = await getRows('Sessions');
  const row = rows.find((r) => r.get('sessionKey') === sessionKey);
  if (!row) return null;
  const raw = row.get('dataJson');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[sheetsStore] getSessionData JSON parse error:', err.message);
    return null;
  }
}

async function getOrCreateSessionsSheet(doc) {
  let sheet = doc.sheetsByTitle['Sessions'];
  if (!sheet) {
    sheet = await doc.addSheet({ title: 'Sessions', headerValues: ['sessionKey', 'dataJson', 'updatedAt'] });
  }
  return sheet;
}

async function saveSessionData(sessionKey, dataObj) {
  const doc = await getDoc();
  const sheet = await getOrCreateSessionsSheet(doc);
  const rows = await sheet.getRows();
  const row = rows.find((r) => r.get('sessionKey') === sessionKey);
  const dataJson = JSON.stringify(dataObj);
  const now = new Date().toISOString();
  if (row) {
    row.set('dataJson', dataJson);
    row.set('updatedAt', now);
    await row.save();
  } else {
    await sheet.addRow({ sessionKey, dataJson, updatedAt: now });
  }
}

// ใช้ตอน handoff เสร็จสมบูรณ์แล้ว (ไม่ต้องเก็บสถานะการคุยของรอบนี้ไว้ต่ออีก) เผื่ออนาคตอยากเรียกใช้เคลียร์ทิ้ง
async function deleteSessionData(sessionKey) {
  const rows = await getRows('Sessions');
  const row = rows.find((r) => r.get('sessionKey') === sessionKey);
  if (row) await row.delete();
}

// --- Pending batches (ข้อความลูกค้าที่พิมพ์เข้ามาแล้วรอ debounce ~1 นาทีก่อนบอทจะรวมตอบทีเดียว ตาม lineWebhook.js) ---
// เดิมเก็บแค่ใน memory เฉยๆ ถ้าเซิร์ฟเวอร์รีสตาร์ทพอดีตอนลูกค้ากำลังพิมพ์อยู่ในช่วงรอนี้ ข้อความนั้นจะหายไปเงียบๆ
// โดยไม่มีการตอบกลับเลย (ลูกค้าเห็นบอทเงียบหายไปดื้อๆ) -> เก็บสำรองไว้ที่นี่ด้วย แล้วให้ server.js เรียกกู้คืนตอนบูตเครื่องทุกครั้ง
async function getOrCreatePendingBatchesSheet(doc) {
  let sheet = doc.sheetsByTitle['PendingBatches'];
  if (!sheet) {
    sheet = await doc.addSheet({ title: 'PendingBatches', headerValues: ['sessionKey', 'textsJson', 'updatedAt'] });
  }
  return sheet;
}

async function savePendingBatch(sessionKey, texts) {
  const doc = await getDoc();
  const sheet = await getOrCreatePendingBatchesSheet(doc);
  const rows = await sheet.getRows();
  const row = rows.find((r) => r.get('sessionKey') === sessionKey);
  const textsJson = JSON.stringify(texts);
  const now = new Date().toISOString();
  if (row) {
    row.set('textsJson', textsJson);
    row.set('updatedAt', now);
    await row.save();
  } else {
    await sheet.addRow({ sessionKey, textsJson, updatedAt: now });
  }
}

async function clearPendingBatch(sessionKey) {
  const doc = await getDoc();
  const sheet = await getOrCreatePendingBatchesSheet(doc);
  const rows = await sheet.getRows();
  const row = rows.find((r) => r.get('sessionKey') === sessionKey);
  if (row) await row.delete();
}

// เรียกครั้งเดียวตอนเซิร์ฟเวอร์เพิ่งบูต เพื่อดึงข้อความที่ค้างจากตอนก่อนรีสตาร์ททั้งหมดกลับมาประมวลผลต่อ
async function getAllPendingBatches() {
  const rows = await getRows('PendingBatches');
  return rows
    .map(rowToObject)
    .filter((r) => r.sessionKey && r.textsJson)
    .map((r) => {
      try {
        return { sessionKey: r.sessionKey, texts: JSON.parse(r.textsJson) };
      } catch (err) {
        console.error('[sheetsStore] getAllPendingBatches JSON parse error:', err.message);
        return null;
      }
    })
    .filter(Boolean);
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
  getStaffBranchIds,
  staffServesBranch,
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
  getLatestCustomerRecord,
  getSessionData,
  saveSessionData,
  deleteSessionData,
  savePendingBatch,
  clearPendingBatch,
  getAllPendingBatches,
};
