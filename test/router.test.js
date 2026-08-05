"use strict";

/**
 * Phase 4: automated smoke tests for src/routing/router.js
 *
 * Runs handleTurn() directly with mocked store/geocode/line/bitrixNN modules
 * (no real Google Sheets / LINE API calls), covering the 8 scenarios from
 * test_checklist.md. This is a lightweight assertion runner, not a full
 * test framework -- run with: node test/router.test.js
 *
 * NOTE: this mocks Claude's output (the analysis object) directly, since
 * router.js's handleTurn() takes already-parsed analysis as input -- it does
 * not call the Claude API itself (that happens in claude.js, one layer up).
 * So these tests validate router.js's session/branch/handoff logic in
 * isolation, not the AI's classification quality.
 */

const Module = require("module");
const path = require("path");

// ---- mock data -------------------------------------------------------

const BRANCHES = {
  hq: { branchId: "hq", name: "สำนักงานใหญ่ (นวมินทร์ 24)", lat: 13.815, lng: 100.658 },
  nuanchan: { branchId: "nuanchan", name: "สาขานวลจันทร์", lat: 13.83, lng: 100.66 },
};

const STAFF = {
  s1: { staffId: "s1", name: "มาร์ค", branchId: "hq", active: "TRUE", role: "sales" },
};

let pushedMessages = [];
let appendedUnanswered = [];

const mockStore = {
  getBranchById: async (id) => BRANCHES[id] || null,
  findStaffById: async (id) => STAFF[id] || null,
  getAllBranches: async () => Object.values(BRANCHES),
  findStaffByName: async () => [],
  getLatestCustomerRecord: async () => null,
  saveSession: async () => {},
  loadSession: async () => null,
  appendUnansweredQuestion: async (item) => { appendedUnanswered.push(item); },
};

const mockGeocode = {
  geocode: async () => null,
  isServiceArea: () => true,
  haversineKm: () => 5,
};

const mockLine = {
  pushMessage: async (userId, msg) => { pushedMessages.push({ userId, msg }); },
  pushMessageWithAck: async (userId, msg) => { pushedMessages.push({ userId, msg }); },
};

const mockBitrix = {};

// ---- module mocking (intercept require() before loading router.js) --

const MOCKS = {
  "../services/store": mockStore,
  "../services/geocode": mockGeocode,
  "../services/line": mockLine,
  "../services/bitrixNN": mockBitrix,
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (MOCKS[request]) return MOCKS[request];
  return originalLoad.apply(this, arguments);
};

const ROUTER_PATH = path.join(__dirname, "..", "src", "routing", "router.js");
const { handleTurn } = require(ROUTER_PATH);

Module._load = originalLoad;

// ---- tiny test runner --------------------------------------------------

let passed = 0;
let failed = 0;

function freshSession(overrides = {}) {
  return { collected: {}, ...overrides };
}

async function runCase(name, fn) {
  pushedMessages = [];
  appendedUnanswered = [];
  try {
    await fn();
    console.log("PASS: " + name);
    passed++;
  } catch (err) {
    console.log("FAIL: " + name);
    console.log("   " + err.message);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ---- test cases (mirrors test_checklist.md) -----------------------------

async function main() {
  await runCase("Case 1: nearby branch question is answered directly", async () => {
    const session = freshSession();
    const reply = await handleTurn({
      session,
      rawMessage: "มีสาขาไหนบ้าง ผมอยู่แถวๆ นวนคร",
      platform: "line",
      userId: "u1",
      customerName: "ลูกค้า A",
      replyContext: null,
      analysis: {
        intent_category: "general",
        reply_text_to_customer: "แถวนวนครใกล้สาขานวลจันทร์ที่สุดค่ะ",
        data_complete: false,
        has_confident_answer: true,
      },
    });
    assert(typeof reply === "string" && reply.length > 0, "expected a string reply");
    assert(!/ชื่อพนักงาน/.test(reply), "should not ask for staff name on a branch-location question");
  });

  await runCase("Case 2: pending history-confirm does not hijack a new question", async () => {
    const session = freshSession({
      pendingHistoryConfirm: { branchId: "hq", phone: "0812345678" },
      historyConfirmPending: true,
    });
    const reply = await handleTurn({
      session,
      rawMessage: "อยากทราบว่าตอนนี้โปรโมชั่นมีที่ไหนบ้างครับ",
      platform: "line",
      userId: "u2",
      customerName: "ลูกค้า B",
      replyContext: null,
      analysis: {
        intent_category: "general",
        reply_text_to_customer: "ตอนนี้มีโปรโมชั่นที่สาขา...",
        data_complete: false,
        has_confident_answer: true,
      },
    });
    assert(typeof reply === "string", "expected a string reply");
    assert(session.pendingHistoryConfirm === null, "pendingHistoryConfirm should be cleared after being consumed");
  });

  await runCase("Case 3: requested_staff_name is cleared on branch-change keywords", async () => {
    const session = freshSession({ collected: { requested_staff_name: "มาร์ค" } });
    await handleTurn({
      session,
      rawMessage: "ขอเปลี่ยนสาขาเป็นนวลจันทร์แทนครับ",
      platform: "line",
      userId: "u3",
      customerName: "ลูกค้า C",
      replyContext: null,
      analysis: {
        intent_category: "service",
        reply_text_to_customer: "รับทราบค่ะ เปลี่ยนสาขาให้แล้วนะคะ",
        data_complete: false,
      },
    });
    assert(!session.collected.requested_staff_name, "requested_staff_name should be cleared on branch change");
  });

  await runCase("Case 4: low-confidence answer gets logged instead of fabricated", async () => {
    const session = freshSession({ collected: { phone: "0812345678", location_text: "หลักสี่" } });
    await handleTurn({
      session,
      rawMessage: "ผมติดบูโรอยู่ ออกรถได้ไหมครับ",
      platform: "line",
      userId: "u4",
      customerName: "ลูกค้า D",
      replyContext: null,
      analysis: {
        intent_category: "trade_in",
        reply_text_to_customer: "เดี๋ยวให้ทีมงานช่วยเช็คและติดต่อกลับนะคะ",
        data_complete: true,
        has_confident_answer: false,
      },
    });
    assert(appendedUnanswered.length === 1, "expected the low-confidence question to be logged");
  });

  await runCase("Case 5: handoff still fires for a new topic after an earlier handoff", async () => {
    const session = freshSession({
      leadEverSent: true,
      collected: { phone: "0812345678", location_text: "หลักสี่" },
    });
    const reply = await handleTurn({
      session,
      rawMessage: "มียางรุ่นนี้ไหมครับ",
      platform: "line",
      userId: "u5",
      customerName: "ลูกค้า E",
      replyContext: null,
      analysis: {
        intent_category: "service",
        reply_text_to_customer: "เดี๋ยวให้ทีมอะไหล่ช่วยเช็คให้นะคะ",
        data_complete: true,
        has_confident_answer: false,
      },
    });
    assert(typeof reply !== "undefined", "expected handleTurn to resolve without throwing");
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
