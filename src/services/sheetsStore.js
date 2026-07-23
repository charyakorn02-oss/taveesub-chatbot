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

async function getActiveBranches() {
  const rows = await getRows('Branches');
  return rows.map(rowToObject).filter((r) => String(r.active).toUpperCase() === 'TRUE');
}

async function getBranchById(id) {
  const branches = await getActiveBranches();
  return branches.find((b) => b.id === id) || null;
}

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

async function getFaqList() {
  const rows = await getRows('FAQ');
  return rows.map(rowToObject);
}

async function getModelList() {
  const rows = await getRows('Models');
  return rows.map(rowToObject);
}

async function appendLead(lead) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle['Leads'];
  await sheet.addRow({
    createdAt: new Date().toISOString(),
    platform: lead.platform || '',
    customerId: lead.customerId || '',
    intentCategory: lead.intentCategory || '',
    modelOrIssue: lead.modelOrIssue || '',
    branchId: lead.branchId || '',
    staffName: lead.staffName || '',
    staffPhone: lead.staffPhone || '',
    phone: lead.phone || '',
    locationText: lead.locationText || '',
    status: lead.status || 'new',
  });
}

async function getBookingsForBranchDate(branchId, date) {
  const rows = await getRows('Bookings');
  return rows.map(rowToObject).filter((r) => r.branchId === branchId && r.serviceDate === date);
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
  getActiveStaff,
  findStaffByNameFuzzy,
  getStaffForBranch,
  pickNextInQueue,
  incrementOpenLeadsCount,
  getFaqList,
  getModelList,
  appendLead,
  getBookingsForBranchDate,
  appendBooking,
};
