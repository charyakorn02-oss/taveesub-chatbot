// เลเยอร์อ่าน/เขียนข้อมูล local JSON (ใช้แทน Bitrix24 ตอนเริ่มต้น)
// เมื่อคุณตั้งค่า Bitrix24 SPA ครบแล้ว ให้สลับไปเรียก services/bitrix24.js แทนจุดที่ทำเครื่องหมาย TODO
"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function readJson(name) {
  const raw = fs.readFileSync(filePath(name), "utf-8");
  return JSON.parse(raw);
}

function writeJson(name, data) {
  fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2), "utf-8");
}

// --- Branches ---
function getActiveBranches() {
  return readJson("branches").filter((b) => b.active);
}

function getBranchById(id) {
  return readJson("branches").find((b) => b.id === id) || null;
}

// --- Staff ---
function getActiveStaff() {
  return readJson("staff").filter((s) => s.active);
}

function findStaffByNameFuzzy(name) {
  if (!name) return null;
  const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, "");
  const target = norm(name);
  const staff = getActiveStaff();
  return (
    staff.find((s) => norm(s.name) === target) ||
    staff.find((s) => norm(s.name).includes(target) || target.includes(norm(s.name))) ||
    null
  );
}

function getStaffForBranch(branchId, role) {
  return getActiveStaff().filter(
    (s) => s.branchId === branchId && (!role || s.role === role)
  );
}

// เลือกพนักงานถัดไปแบบ round robin: เรียงตาม openLeadsCount น้อยสุดก่อน, ถ้าเท่ากันเอาคนที่ได้รับงานล่าสุดนานที่สุด
function pickNextInQueue(branchId, role) {
  const candidates = getStaffForBranch(branchId, role);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.openLeadsCount !== b.openLeadsCount) return a.openLeadsCount - b.openLeadsCount;
    const at = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
    const bt = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
    return at - bt;
  });
  return candidates[0];
}

function incrementOpenLeadsCount(staffId) {
  const all = readJson("staff");
  const idx = all.findIndex((s) => s.id === staffId);
  if (idx === -1) return;
  all[idx].openLeadsCount = (all[idx].openLeadsCount || 0) + 1;
  all[idx].lastAssignedAt = new Date().toISOString();
  writeJson("staff", all);
}

// --- FAQ ---
function getFaqList() {
  return readJson("faq");
}

// --- Models ---
function getModelList() {
  return readJson("models");
}

// --- Leads ---
function appendLead(lead) {
  const all = readJson("leads");
  all.push(lead);
  writeJson("leads", all);
  return lead;
}

// --- Service bookings ---
function getBookingsForBranchDate(branchId, dateStr) {
  return readJson("bookings").filter(
    (b) => b.branchId === branchId && b.date === dateStr && b.status === "Booked"
  );
}

function appendBooking(booking) {
  const all = readJson("bookings");
  all.push(booking);
  writeJson("bookings", all);
  return booking;
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
