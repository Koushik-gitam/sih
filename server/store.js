// Repository layer.
//
// Collections are JSON documents on disk, written atomically (temp file +
// rename). The audit ledger is append-only and hash chained: each entry
// includes the hash of its predecessor, so deleting or editing history is
// detectable by verifyAuditChain().
//
// This module is the single storage boundary. Replacing it with PostgreSQL
// means reimplementing the exported functions only.

const fs = require('fs');
const path = require('path');

const { config, ensureDirs } = require('./config');
const { stableStringify, sha256, uuid, nowIso, slug } = require('./util');

const COLLECTIONS = ['users', 'tests', 'audit'];

const cache = new Map();

function collectionPath(collection) {
  return path.join(config.dataDir, `${collection}.json`);
}

function read(collection) {
  ensureDirs();
  const file = collectionPath(collection);
  if (!fs.existsSync(file)) return [];

  const stats = fs.statSync(file);
  const cached = cache.get(collection);
  if (cached && cached.mtimeMs === stats.mtimeMs) return cached.value;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const value = Array.isArray(parsed) ? parsed : [];
    cache.set(collection, { mtimeMs: stats.mtimeMs, value });
    return value;
  } catch (error) {
    throw new Error(`Stored collection ${collection}.json is not readable JSON: ${error.message}`);
  }
}

function write(collection, value) {
  ensureDirs();
  const file = collectionPath(collection);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
  const stats = fs.statSync(file);
  cache.set(collection, { mtimeMs: stats.mtimeMs, value });
  return value;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function listUsers() {
  return read('users');
}

function getUser(id) {
  return read('users').find((user) => user.id === id) || null;
}

function findUserByUsername(username) {
  const needle = String(username || '').trim().toLowerCase();
  return read('users').find((user) => user.username.toLowerCase() === needle) || null;
}

function createUser(details) {
  const users = read('users');
  if (users.some((user) => user.username.toLowerCase() === String(details.username).toLowerCase())) {
    throw new Error(`User "${details.username}" already exists`);
  }

  const user = {
    id: uuid(),
    username: details.username,
    name: details.name || details.username,
    role: details.role,
    labCode: details.labCode || null,
    passwordHash: details.passwordHash,
    active: details.active !== false,
    mustChangePassword: Boolean(details.mustChangePassword),
    seeded: Boolean(details.seeded),
    createdAt: nowIso(),
    lastLoginAt: null,
  };

  users.push(user);
  write('users', users);
  return user;
}

function updateUser(id, patch) {
  const users = read('users');
  const index = users.findIndex((user) => user.id === id);
  if (index === -1) return null;
  users[index] = { ...users[index], ...patch, id };
  write('users', users);
  return users[index];
}

function touchLogin(id) {
  return updateUser(id, { lastLoginAt: nowIso() });
}

// ---------------------------------------------------------------------------
// Audit ledger
// ---------------------------------------------------------------------------

function listAudit({ limit = 100, testId = null } = {}) {
  const ledger = read('audit');
  const filtered = testId ? ledger.filter((entry) => entry.testId === testId) : ledger;
  return filtered.slice(-limit).reverse();
}

/** Append an entry. Returns the stored entry including its hash. */
function audit(entry) {
  const ledger = read('audit');
  const previous = ledger[ledger.length - 1] || null;

  const record = {
    seq: ledger.length + 1,
    at: nowIso(),
    prevHash: previous ? previous.hash : 'GENESIS',
    actor: entry.actor || { id: null, username: 'system', role: 'system' },
    action: entry.action,
    testId: entry.testId || null,
    details: entry.details || null,
    ip: entry.ip || null,
  };

  record.hash = sha256({ ...record });
  ledger.push(record);
  write('audit', ledger);
  return record;
}

/** Recompute the chain and report the first broken link, if any. */
function verifyAuditChain() {
  const ledger = read('audit');
  let previousHash = 'GENESIS';

  for (let index = 0; index < ledger.length; index += 1) {
    const entry = ledger[index];
    const { hash, ...rest } = entry;
    const recomputed = sha256(rest);

    if (entry.prevHash !== previousHash) {
      return {
        valid: false,
        entries: ledger.length,
        brokenAt: entry.seq,
        reason: `entry ${entry.seq} does not link to the previous entry`,
      };
    }
    if (recomputed !== hash) {
      return {
        valid: false,
        entries: ledger.length,
        brokenAt: entry.seq,
        reason: `entry ${entry.seq} content does not match its hash`,
      };
    }
    previousHash = hash;
  }

  return { valid: true, entries: ledger.length, brokenAt: null, reason: null };
}

// ---------------------------------------------------------------------------
// Tests (the reportable records)
// ---------------------------------------------------------------------------

const TEST_STATUSES = ['draft', 'submitted', 'approved', 'rejected'];

function listTests() {
  return read('tests');
}

function getTest(id) {
  return read('tests').find((test) => test.id === id) || null;
}

function createTest(record, actor) {
  const tests = read('tests');
  const now = nowIso();

  const test = {
    id: uuid(),
    reportNumber: record.reportNumber || nextReportNumber(tests),
    status: 'draft',
    locked: false,
    version: 1,
    createdAt: now,
    createdBy: actorRef(actor),
    updatedAt: now,
    updatedBy: actorRef(actor),
    instrument: record.instrument || {},
    laboratory: record.laboratory || {},
    environmental: record.environmental || {},
    modules: record.modules || {},
    discrimination: record.discrimination || {},
    attachments: [],
    signatures: [],
    revisions: [],
    history: [{ at: now, by: actorRef(actor), action: 'test.create', note: 'Test record created' }],
  };

  tests.push(test);
  write('tests', tests);
  audit({ actor, action: 'test.create', testId: test.id, details: { reportNumber: test.reportNumber } });
  return test;
}

function nextReportNumber(tests) {
  const year = new Date().getFullYear();
  const prefix = `NAWI/${year}/`;
  const sequence = tests.filter((test) => String(test.reportNumber || '').startsWith(prefix)).length + 1;
  return `${prefix}${String(sequence).padStart(4, '0')}`;
}

function actorRef(actor) {
  if (!actor) return { id: null, username: 'system', role: 'system' };
  return { id: actor.id || null, username: actor.username || 'unknown', role: actor.role || 'unknown' };
}

/**
 * Apply a patch to a test. Locked tests reject content changes; every change is
 * recorded in the record history and in the audit ledger.
 */
function updateTest(id, patch, actor, { reason = null, force = false } = {}) {
  const tests = read('tests');
  const index = tests.findIndex((test) => test.id === id);
  if (index === -1) return { ok: false, error: 'Test record not found' };

  const current = tests[index];
  if (current.locked && !force) {
    return { ok: false, error: 'This test is locked (approved or under revision). A manager unlock with a recorded reason is required.', locked: true };
  }

  const contentFields = ['instrument', 'laboratory', 'environmental', 'modules', 'discrimination'];
  const touchesContent = contentFields.some((field) => patch[field] !== undefined);

  const updated = {
    ...current,
    ...patch,
    id: current.id,
    updatedAt: nowIso(),
    updatedBy: actorRef(actor),
    version: current.version + (touchesContent ? 1 : 0),
    history: [
      ...(current.history || []),
      {
        at: nowIso(),
        by: actorRef(actor),
        action: touchesContent ? 'test.update' : 'test.metadata_update',
        note: reason || (touchesContent ? 'Test content updated' : 'Record metadata updated'),
      },
    ],
  };

  tests[index] = updated;
  write('tests', tests);
  audit({
    actor,
    action: touchesContent ? 'test.update' : 'test.metadata_update',
    testId: id,
    details: { version: updated.version, reason, fields: Object.keys(patch) },
  });

  return { ok: true, test: updated };
}

function setStatus(id, status, actor, { note = null } = {}) {
  if (!TEST_STATUSES.includes(status)) return { ok: false, error: `Unknown status "${status}"` };

  const tests = read('tests');
  const index = tests.findIndex((test) => test.id === id);
  if (index === -1) return { ok: false, error: 'Test record not found' };

  const current = tests[index];
  const locked = status === 'approved';
  const updated = {
    ...current,
    status,
    locked,
    updatedAt: nowIso(),
    updatedBy: actorRef(actor),
    history: [
      ...(current.history || []),
      { at: nowIso(), by: actorRef(actor), action: `test.${status}`, note: note || `Status set to ${status}` },
    ],
  };

  tests[index] = updated;
  write('tests', tests);
  audit({ actor, action: `test.${status}`, testId: id, details: { note, from: current.status } });
  return { ok: true, test: updated };
}

/**
 * Unlocking is deliberately heavyweight: the current state is snapshotted, the
 * reason is stored, and both are written to the audit ledger.
 */
function unlockTest(id, actor, reason) {
  if (!reason || String(reason).trim().length < 8) {
    return { ok: false, error: 'A written justification of at least 8 characters is required to unlock an approved test.' };
  }

  const tests = read('tests');
  const index = tests.findIndex((test) => test.id === id);
  if (index === -1) return { ok: false, error: 'Test record not found' };

  const current = tests[index];
  const snapshot = {
    at: nowIso(),
    by: actorRef(actor),
    reason,
    status: current.status,
    version: current.version,
    instrument: current.instrument,
    environmental: current.environmental,
    modules: current.modules,
  };

  const updated = {
    ...current,
    locked: false,
    status: 'submitted',
    updatedAt: nowIso(),
    updatedBy: actorRef(actor),
    revisions: [...(current.revisions || []), snapshot],
    history: [
      ...(current.history || []),
      { at: nowIso(), by: actorRef(actor), action: 'test.unlock', note: reason },
    ],
  };

  tests[index] = updated;
  write('tests', tests);
  audit({ actor, action: 'test.unlock', testId: id, details: { reason, previousStatus: current.status } });
  return { ok: true, test: updated };
}

function recordEvaluation(id, evaluation, actor) {
  const tests = read('tests');
  const index = tests.findIndex((test) => test.id === id);
  if (index === -1) return null;

  tests[index] = {
    ...tests[index],
    lastEvaluation: {
      at: evaluation.evaluatedAt,
      verdict: evaluation.summary.verdict,
      modulesPassed: evaluation.summary.modulesPassed,
      modulesFailed: evaluation.summary.modulesFailed,
      pointsEvaluated: evaluation.summary.pointsEvaluated,
      pointsFailed: evaluation.summary.pointsFailed,
      coverageComplete: evaluation.summary.coverageComplete,
      integrityHash: evaluation.integrityHash,
      rulesRevision: evaluation.rulesRevision,
      moduleResults: (evaluation.modules || []).map((module) => ({
        moduleId: module.moduleId,
        status: module.status,
        failedPoints: module.failedPoints,
      })),
      by: actorRef(actor),
    },
  };
  write('tests', tests);
  return tests[index];
}

function addSignature(id, signature, actor) {
  const tests = read('tests');
  const index = tests.findIndex((test) => test.id === id);
  if (index === -1) return { ok: false, error: 'Test record not found' };

  tests[index] = {
    ...tests[index],
    signatures: [...(tests[index].signatures || []), signature],
    updatedAt: nowIso(),
  };
  write('tests', tests);
  audit({ actor, action: 'report.sign', testId: id, details: { meaning: signature.meaning, hash: signature.hash } });
  return { ok: true, test: tests[index] };
}

function addAttachment(id, attachment, actor) {
  const tests = read('tests');
  const index = tests.findIndex((test) => test.id === id);
  if (index === -1) return { ok: false, error: 'Test record not found' };

  tests[index] = {
    ...tests[index],
    attachments: [...(tests[index].attachments || []), attachment],
    updatedAt: nowIso(),
  };
  write('tests', tests);
  audit({ actor, action: 'test.attach', testId: id, details: { filename: attachment.filename, sha256: attachment.sha256 } });
  return { ok: true, test: tests[index] };
}

function deleteTest(id, actor) {
  const tests = read('tests');
  const remaining = tests.filter((test) => test.id !== id);
  if (remaining.length === tests.length) return { ok: false, error: 'Test record not found' };
  write('tests', remaining);
  audit({ actor, action: 'test.delete', testId: id });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Search and dashboard statistics
// ---------------------------------------------------------------------------

function searchTests(options = {}) {
  const {
    query = null,
    status = null,
    accuracyClass = null,
    manufacturer = null,
    testType = null,
    from = null,
    to = null,
    limit = 100,
  } = options;

  const needle = query ? String(query).toLowerCase() : null;

  return listTests()
    .filter((test) => {
      if (status && test.status !== status) return false;
      if (accuracyClass && String(test.instrument?.accuracyClass).toUpperCase() !== String(accuracyClass).toUpperCase()) return false;
      if (manufacturer && !String(test.instrument?.manufacturer || '').toLowerCase().includes(String(manufacturer).toLowerCase())) return false;
      if (testType && !Object.keys(test.modules || {}).includes(testType)) return false;
      if (from && String(test.environmental?.testDate || test.createdAt) < String(from)) return false;
      if (to && String(test.environmental?.testDate || test.createdAt) > String(to)) return false;

      if (needle) {
        const haystack = [
          test.reportNumber,
          test.instrument?.manufacturer,
          test.instrument?.model,
          test.instrument?.serialNumber,
          test.instrument?.accuracyClass,
          test.laboratory?.name,
          test.laboratory?.labCode,
          test.environmental?.testedBy,
          test.lastEvaluation?.verdict,
          test.status,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }

      return true;
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit);
}

function stats() {
  const tests = listTests();
  const byStatus = { draft: 0, submitted: 0, approved: 0, rejected: 0 };
  const byVerdict = { pass: 0, fail: 0, invalid: 0, incomplete: 0, unevaluated: 0 };
  const byClass = {};
  const byManufacturer = {};
  const byTechnician = {};
  const moduleFailures = {};

  tests.forEach((test) => {
    byStatus[test.status] = (byStatus[test.status] || 0) + 1;

    const verdict = test.lastEvaluation?.verdict || 'unevaluated';
    byVerdict[verdict] = (byVerdict[verdict] || 0) + 1;

    const accuracyClass = test.instrument?.accuracyClass || 'unspecified';
    byClass[accuracyClass] = (byClass[accuracyClass] || 0) + 1;

    const manufacturer = test.instrument?.manufacturer || 'unspecified';
    byManufacturer[manufacturer] = (byManufacturer[manufacturer] || 0) + 1;

    const technician = test.createdBy?.username || 'unknown';
    byTechnician[technician] = (byTechnician[technician] || 0) + 1;

    (test.lastEvaluation?.moduleResults || []).forEach((module) => {
      if (module.status === 'fail') moduleFailures[module.moduleId] = (moduleFailures[module.moduleId] || 0) + 1;
    });
  });

  const pendingApproval = tests.filter((test) => test.status === 'submitted').length;
  const recent = [...tests]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 8)
    .map((test) => ({
      id: test.id,
      reportNumber: test.reportNumber,
      status: test.status,
      verdict: test.lastEvaluation?.verdict || null,
      manufacturer: test.instrument?.manufacturer || null,
      model: test.instrument?.model || null,
      updatedAt: test.updatedAt,
    }));

  return {
    totalTests: tests.length,
    byStatus,
    byVerdict,
    byClass,
    byManufacturer,
    byTechnician,
    moduleFailures,
    pendingApproval,
    recent,
    auditEntries: read('audit').length,
    auditChain: verifyAuditChain(),
  };
}

/** Attachments live on disk; the metadata lives on the test record. */
function attachmentsDir(testId) {
  const directory = path.join(config.uploadsDir, slug(testId, 'test'));
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

module.exports = {
  COLLECTIONS,
  TEST_STATUSES,
  read,
  write,
  collectionPath,
  listUsers,
  getUser,
  findUserByUsername,
  createUser,
  updateUser,
  touchLogin,
  audit,
  listAudit,
  verifyAuditChain,
  listTests,
  getTest,
  createTest,
  updateTest,
  setStatus,
  unlockTest,
  recordEvaluation,
  addSignature,
  addAttachment,
  deleteTest,
  searchTests,
  stats,
  attachmentsDir,
  actorRef,
  nextReportNumber,
  stableStringify,
};

const store = module.exports;
module.exports.store = store;
