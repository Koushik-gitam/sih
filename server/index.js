// NAWI Test Report System - application server.
//
// Problem Statement 26035, Department of Consumer Affairs:
// "Generation of Test Reports for Non-Automatic Weighing Instruments as per
//  OIML Recommendation R 76".
//
// Responsibilities:
//   * serve the progressive web app in public/
//   * expose the REST API over the metrology engine, the repository and the
//     report generators
//   * enforce authentication and role-based permissions

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const { config, ensureDirs } = require('./config');
const { store } = require('./store');
const auth = require('./auth');
const { loadRules, validateRules, listTestModules, mpeForLoad } = require('./engine/rules');
const { validateTestRecord } = require('./engine/validate');
const { evaluateTest } = require('./engine/evaluate');
const { suggestTestLoads, eccentricityLoad } = require('./engine/planning');
const { generateReportArtifacts, resolveArtifact, findChrome } = require('./reports/report');
const { sha256, uuid, nowIso, slug } = require('./util');

const app = express();

app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: false, limit: '12mb' }));

app.use((req, res, next) => {
  req.startedAt = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api') && process.env.NAWI_QUIET !== '1') {
      // Lightweight request log; no payloads are written, only the actions.
      console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - req.startedAt}ms`);
    }
  });
  next();
});

const publicDir = path.join(config.root, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir, { extensions: ['html'] }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function actorOf(req) {
  if (!req.user) return { id: null, username: 'anonymous', role: 'anonymous' };
  return { id: req.user.id, username: req.user.username, role: req.user.role };
}

function fail(res, status, message, details) {
  return res.status(status).json({ error: message, details: details || null });
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return fail(res, 401, 'Authentication required');

  const result = auth.verifyToken(token);
  if (!result.valid) return fail(res, 401, `Session is not valid (${result.error}). Sign in again.`);

  req.user = result.user;
  req.claims = result.claims;
  next();
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!auth.can(req.user, permission)) {
      return fail(res, 403, `Role "${req.user.role}" is not permitted to perform "${permission}".`);
    }
    next();
  };
}

/** Evaluate a stored test and (optionally) persist the outcome. */
function evaluateStoredTest(test, { persist = false, actor = null } = {}) {
  const evaluation = evaluateTest(test, { rules: loadRules() });
  evaluation.reportNumber = test.reportNumber;
  if (persist) store.recordEvaluation(test.id, evaluation, actor);
  return evaluation;
}

function summariseTest(test) {
  return {
    id: test.id,
    reportNumber: test.reportNumber,
    status: test.status,
    locked: Boolean(test.locked),
    version: test.version,
    createdAt: test.createdAt,
    updatedAt: test.updatedAt,
    createdBy: test.createdBy,
    instrument: {
      manufacturer: test.instrument?.manufacturer || null,
      model: test.instrument?.model || null,
      serialNumber: test.instrument?.serialNumber || null,
      accuracyClass: test.instrument?.accuracyClass || null,
      unit: test.instrument?.unit || null,
      maxCapacity: test.instrument?.maxCapacity ?? null,
      minCapacity: test.instrument?.minCapacity ?? null,
      e: test.instrument?.e ?? null,
      d: test.instrument?.d ?? null,
    },
    laboratory: test.laboratory || null,
    testDate: test.environmental?.testDate || null,
    modulesRecorded: Object.keys(test.modules || {}).filter((key) => Object.keys(test.modules[key] || {}).length),
    attachments: (test.attachments || []).length,
    signatures: (test.signatures || []).length,
    lastEvaluation: test.lastEvaluation || null,
  };
}

// ---------------------------------------------------------------------------
// Health, metadata and authentication
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  let rulesOk = true;
  let rulesError = null;
  try {
    loadRules();
  } catch (error) {
    rulesOk = false;
    rulesError = error.message;
  }

  res.json({
    status: rulesOk ? 'ok' : 'degraded',
    service: 'nawi-test-report-system',
    problemStatement: 'SIH 26035 - NAWI test reports as per OIML R 76',
    time: nowIso(),
    rules: rulesOk ? { loaded: true, path: config.rulesPath } : { loaded: false, error: rulesError },
    storage: { dataDir: config.dataDir, tests: store.listTests().length },
    pdfRenderer: { available: Boolean(findChrome()), binary: findChrome() },
    auditChain: store.verifyAuditChain(),
  });
});

app.get('/api/meta', (req, res) => {
  const rules = loadRules();
  res.json({
    problem: {
      id: '26035',
      title: 'Development of a Software Program/Application for Generation of Test Reports for Non-Automatic Weighing Instruments (NAWI) as per OIML Recommendation R 76',
      organisation: 'Ministry of Consumer Affairs, Food & Public Distribution, Department of Consumer Affairs',
    },
    standard: rules.standard,
    reportFormat: rules.reportFormat,
    rulesRevision: rules.revision,
    classes: Object.entries(rules.classes).map(([key, definition]) => ({
      key,
      title: definition.title,
      bands: definition.bands.map((band) => ({
        eMinGrams: band.eMinGrams,
        eMaxGrams: band.eMaxGrams,
        intervalsMin: band.intervalsMin,
        intervalsMax: band.intervalsMax,
        minCapacityInE: band.minCapacityInE,
        mpeBrackets: band.mpeBrackets,
      })),
    })),
    testModules: listTestModules(rules),
    statuses: store.TEST_STATUSES,
    roles: Object.entries(auth.ROLES).map(([key, value]) => ({
      key,
      label: value.label,
      description: value.description,
      permissions: value.permissions,
    })),
    units: ['mg', 'g', 'kg', 't'],
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return fail(res, 400, 'Username and password are required');

  const result = auth.login(username, password);
  if (!result.ok) return fail(res, 401, result.error);

  store.touchLogin(result.user.id);
  res.json({ token: result.token, expiresAt: result.expiresAt, user: result.user });
});

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ user: auth.publicUser(req.user) });
});

app.post('/api/auth/password', authenticate, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!auth.verifyPassword(currentPassword, req.user.passwordHash)) {
    return fail(res, 400, 'The current password is not correct');
  }

  const problems = auth.passwordProblems(newPassword);
  if (problems.length) return fail(res, 400, `New password ${problems.join(', ')}`);

  store.updateUser(req.user.id, { passwordHash: auth.hashPassword(newPassword), mustChangePassword: false });
  store.audit({ actor: actorOf(req), action: 'auth.password_change', testId: null });
  res.json({ ok: true, message: 'Password updated' });
});

// ---------------------------------------------------------------------------
// Users and roles (administration)
// ---------------------------------------------------------------------------

app.get('/api/users', authenticate, requirePermission('*'), (req, res) => {
  res.json({ users: store.listUsers().map(auth.publicUser) });
});

app.post('/api/users', authenticate, requirePermission('*'), (req, res) => {
  const { username, password, name, role, labCode } = req.body || {};
  if (!username || !password) return fail(res, 400, 'Username and password are required');
  if (!auth.ROLES[role]) return fail(res, 400, `Role must be one of: ${Object.keys(auth.ROLES).join(', ')}`);

  const problems = auth.passwordProblems(password);
  if (problems.length) return fail(res, 400, `Password ${problems.join(', ')}`);

  try {
    const user = store.createUser({
      username,
      name,
      role,
      labCode,
      passwordHash: auth.hashPassword(password),
      active: true,
      mustChangePassword: true,
    });
    store.audit({ actor: actorOf(req), action: 'user.create', details: { username, role } });
    res.status(201).json({ user: auth.publicUser(user) });
  } catch (error) {
    fail(res, 409, error.message);
  }
});

app.patch('/api/users/:id', authenticate, requirePermission('*'), (req, res) => {
  const { role, active, name, labCode, password } = req.body || {};
  const patch = {};

  if (role !== undefined) {
    if (!auth.ROLES[role]) return fail(res, 400, 'Unknown role');
    patch.role = role;
  }
  if (active !== undefined) patch.active = Boolean(active);
  if (name !== undefined) patch.name = name;
  if (labCode !== undefined) patch.labCode = labCode;
  if (password !== undefined) {
    const problems = auth.passwordProblems(password);
    if (problems.length) return fail(res, 400, `Password ${problems.join(', ')}`);
    patch.passwordHash = auth.hashPassword(password);
    patch.mustChangePassword = true;
  }

  const user = store.updateUser(req.params.id, patch);
  if (!user) return fail(res, 404, 'User not found');

  store.audit({ actor: actorOf(req), action: 'user.update', details: { username: user.username, fields: Object.keys(patch) } });
  res.json({ user: auth.publicUser(user) });
});

// ---------------------------------------------------------------------------
// Rule schema (future-proofing: OIML revisions are a data change)
// ---------------------------------------------------------------------------

app.get('/api/rules', authenticate, requirePermission('rules:read'), (req, res) => {
  res.json({ rules: loadRules(), path: config.rulesPath });
});

app.put('/api/rules', authenticate, requirePermission('*'), (req, res) => {
  const schema = req.body?.rules || req.body;
  const problems = validateRules(schema);
  if (problems.length) return fail(res, 400, 'Rule schema rejected by validation', problems);

  const archiveDir = path.join(config.root, 'rules', 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, '-');

  if (fs.existsSync(config.rulesPath)) {
    const previousRevision = JSON.parse(fs.readFileSync(config.rulesPath, 'utf8')).revision || 'unknown';
    fs.copyFileSync(config.rulesPath, path.join(archiveDir, `oiml-r76-${previousRevision}-${stamp}.json`));
  }

  fs.writeFileSync(config.rulesPath, JSON.stringify(schema, null, 2), 'utf8');
  loadRules({ force: true });

  store.audit({
    actor: actorOf(req),
    action: 'rules.update',
    details: { revision: schema.revision, standard: schema.standard },
  });

  res.json({ ok: true, revision: schema.revision, archived: true });
});

app.get('/api/rules/history', authenticate, requirePermission('rules:read'), (req, res) => {
  const archiveDir = path.join(config.root, 'rules', 'archive');
  const entries = fs.existsSync(archiveDir)
    ? fs
        .readdirSync(archiveDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .reverse()
        .map((name) => ({ name, bytes: fs.statSync(path.join(archiveDir, name)).size }))
    : [];
  res.json({ current: loadRules().revision, archived: entries });
});

// ---------------------------------------------------------------------------
// Test records
// ---------------------------------------------------------------------------

app.get('/api/tests', authenticate, requirePermission('test:read'), (req, res) => {
  const tests = store.searchTests({
    query: req.query.query || req.query.q,
    status: req.query.status,
    accuracyClass: req.query.accuracyClass || req.query.class,
    manufacturer: req.query.manufacturer,
    testType: req.query.testType,
    from: req.query.from,
    to: req.query.to,
    limit: Number(req.query.limit || 100),
  });
  res.json({ count: tests.length, tests: tests.map(summariseTest) });
});

app.post('/api/tests', authenticate, requirePermission('test:create'), (req, res) => {
  const { instrument, laboratory, environmental, modules, reportNumber } = req.body || {};
  if (!instrument) return fail(res, 400, 'Instrument data is required');

  const draft = {
    reportNumber,
    instrument,
    laboratory: laboratory || { name: req.user.labCode || null },
    environmental: environmental || {},
    modules: modules || {},
  };

  const test = store.createTest(draft, actorOf(req));
  res.status(201).json({ test });
});

app.get('/api/tests/:id', authenticate, requirePermission('test:read'), (req, res) => {
  const test = store.getTest(req.params.id);
  if (!test) return fail(res, 404, 'Test record not found');

  const evaluation = evaluateStoredTest(test);
  evaluation.reportNumber = test.reportNumber;
  res.json({ test, evaluation, validation: evaluation.validation, summary: summariseTest(test) });
});

app.patch('/api/tests/:id', authenticate, requirePermission('test:update'), (req, res) => {
  const { instrument, laboratory, environmental, modules, discrimination, reportNumber, reason } = req.body || {};
  const patch = {};
  if (instrument) patch.instrument = instrument;
  if (laboratory) patch.laboratory = laboratory;
  if (environmental) patch.environmental = environmental;
  if (modules) patch.modules = modules;
  if (discrimination) patch.discrimination = discrimination;
  if (reportNumber) patch.reportNumber = reportNumber;

  if (!Object.keys(patch).length) return fail(res, 400, 'No fields to update');

  const result = store.updateTest(req.params.id, patch, actorOf(req), { reason });
  if (!result.ok) return fail(res, result.locked ? 423 : 404, result.error);

  res.json({ test: result.test, validation: validateTestRecord(result.test) });
});

app.delete('/api/tests/:id', authenticate, requirePermission('test:delete'), (req, res) => {
  const result = store.deleteTest(req.params.id, actorOf(req));
  if (!result.ok) return fail(res, 404, result.error);
  res.json({ ok: true });
});

/** Evaluate without persisting - used by the live form as values are typed. */
app.post('/api/tests/:id/evaluate', authenticate, requirePermission('test:read'), (req, res) => {
  const test = store.getTest(req.params.id);
  if (!test) return fail(res, 404, 'Test record not found');

  const evaluation = evaluateStoredTest(test, { persist: true, actor: actorOf(req) });
  res.json({ evaluation, validation: evaluation.validation, summary: evaluation.summary });
});

/** Evaluate an unsaved payload (offline drafts sync through this endpoint). */
app.post('/api/evaluate', authenticate, requirePermission('test:read'), (req, res) => {
  const record = req.body?.test || req.body || {};
  const evaluation = evaluateTest(record, { rules: loadRules() });
  res.json({ evaluation, validation: evaluation.validation, summary: evaluation.summary });
});

app.post('/api/tests/:id/submit', authenticate, requirePermission('test:submit'), (req, res) => {
  const test = store.getTest(req.params.id);
  if (!test) return fail(res, 404, 'Test record not found');
  if (test.locked) return fail(res, 423, 'This record is locked; unlock it before resubmitting.');

  const validation = validateTestRecord(test);
  if (!validation.valid) {
    return fail(res, 422, 'The record cannot be submitted until the validation findings are resolved.', validation.errors);
  }

  const evaluation = evaluateStoredTest(test, { persist: true, actor: actorOf(req) });
  const result = store.setStatus(test.id, 'submitted', actorOf(req), {
    note: `Submitted for review with verdict ${evaluation.summary.verdict}`,
  });

  store.addSignature(test.id, {
    meaning: 'tested',
    by: actorOf(req),
    name: req.user.name || req.user.username,
    role: req.user.role,
    at: nowIso(),
    hash: evaluation.integrityHash,
  }, actorOf(req));

  res.json({ test: result.test, summary: evaluation.summary });
});

app.post('/api/tests/:id/approve', authenticate, requirePermission('test:approve'), (req, res) => {
  const test = store.getTest(req.params.id);
  if (!test) return fail(res, 404, 'Test record not found');

  const evaluation = evaluateStoredTest(test, { persist: true, actor: actorOf(req) });

  if (evaluation.validation.errors.length) {
    return fail(res, 422, 'Cannot approve: the record still has blocking validation findings.', evaluation.validation.errors);
  }
  if (evaluation.summary.verdict === 'fail') {
    return fail(res, 409, 'Cannot approve: at least one measured error exceeds the maximum permissible error.');
  }
  if (evaluation.summary.verdict === 'incomplete') {
    return fail(res, 409, 'Cannot approve: no observations have been recorded.');
  }

  const { note } = req.body || {};
  const signature = {
    meaning: 'approved',
    by: actorOf(req),
    name: req.user.name || req.user.username,
    role: req.user.role,
    at: nowIso(),
    hash: evaluation.integrityHash,
    note: note || null,
  };
  store.addSignature(test.id, signature, actorOf(req));
  const result = store.setStatus(test.id, 'approved', actorOf(req), { note: note || 'Approved by laboratory manager' });

  res.json({ test: result.test, summary: evaluation.summary, signature });
});

app.post('/api/tests/:id/reject', authenticate, requirePermission('test:approve'), (req, res) => {
  const { note } = req.body || {};
  if (!note) return fail(res, 400, 'A reason is required when rejecting a test record');

  const result = store.setStatus(req.params.id, 'rejected', actorOf(req), { note });
  if (!result.ok) return fail(res, 404, result.error);
  res.json({ test: result.test });
});

app.post('/api/tests/:id/unlock', authenticate, requirePermission('test:unlock'), (req, res) => {
  const { reason } = req.body || {};
  const result = store.unlockTest(req.params.id, actorOf(req), reason);
  if (!result.ok) return fail(res, result.error.startsWith('A written justification') ? 400 : 404, result.error);
  res.json({ test: result.test });
});

// ---------------------------------------------------------------------------
// Attachments (photographs, calibration certificates, annexures)
// ---------------------------------------------------------------------------

app.post('/api/tests/:id/attachments', authenticate, requirePermission('test:update'), (req, res) => {
  const test = store.getTest(req.params.id);
  if (!test) return fail(res, 404, 'Test record not found');

  const { filename, mimetype, contentBase64 } = req.body || {};
  if (!filename || !contentBase64) return fail(res, 400, 'filename and contentBase64 are required (multipart uploads are not used).');

  const buffer = Buffer.from(contentBase64, 'base64');
  if (!buffer.length) return fail(res, 400, 'The uploaded file is empty');
  if (buffer.length > config.maxUploadBytes) {
    return fail(res, 413, `Attachment exceeds the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit`);
  }

  const directory = store.attachmentsDir(test.id);
  const storedName = `${Date.now()}-${slug(filename, 'attachment')}`;
  const target = path.join(directory, storedName);
  fs.writeFileSync(target, buffer);

  const attachment = {
    id: uuid(),
    filename,
    storedName,
    mimetype: mimetype || 'application/octet-stream',
    size: buffer.length,
    sha256: sha256(buffer),
    uploadedAt: nowIso(),
    uploadedBy: actorOf(req),
  };

  const result = store.addAttachment(test.id, attachment, actorOf(req));
  res.status(201).json({ attachment, test: result.test });
});

app.get('/api/tests/:id/attachments/:attachmentId', authenticate, requirePermission('report:read'), (req, res) => {
  const test = store.getTest(req.params.id);
  if (!test) return fail(res, 404, 'Test record not found');

  const attachment = (test.attachments || []).find((candidate) => candidate.id === req.params.attachmentId);
  if (!attachment) return fail(res, 404, 'Attachment not found');

  const file = path.join(store.attachmentsDir(test.id), attachment.storedName);
  if (!fs.existsSync(file)) return fail(res, 410, 'The stored attachment file is missing');

  res.setHeader('Content-Type', attachment.mimetype);
  res.setHeader('Content-Disposition', `inline; filename="${slug(attachment.filename)}"`);
  res.sendFile(file);
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

app.get('/api/tests/:id/report', authenticate, requirePermission('report:generate'), async (req, res) => {
  const test = store.getTest(req.params.id);
  if (!test) return fail(res, 404, 'Test record not found');

  const evaluation = evaluateStoredTest(test, { persist: true, actor: actorOf(req) });
  evaluation.reportNumber = test.reportNumber;

  const formats = String(req.query.format || 'pdf,docx').split(',').map((value) => value.trim()).filter(Boolean);
  const generated = await generateReportArtifacts(evaluation, { test, formats });

  store.updateTest(test.id, {}, actorOf(req), { reason: `Reports generated: ${generated.artifacts.map((artifact) => artifact.format).join(', ')}` });
  store.audit({
    actor: actorOf(req),
    action: 'report.generate',
    testId: test.id,
    details: {
      formats: generated.artifacts.map((artifact) => `${artifact.format}:${artifact.filename}`),
      errors: generated.errors,
      integrityHash: evaluation.integrityHash,
    },
  });

  res.json({
    reportNumber: test.reportNumber,
    verdict: evaluation.summary.verdict,
    integrityHash: evaluation.integrityHash,
    rulesRevision: evaluation.rulesRevision,
    artifacts: generated.artifacts.map(({ path: filePath, ...rest }) => ({ ...rest, download: `/api/reports/${encodeURIComponent(rest.filename)}` })),
    errors: generated.errors,
  });
});

/** Inline preview of the printable HTML report (used by the report viewer). */
app.get('/api/tests/:id/report/preview', authenticate, requirePermission('report:read'), (req, res) => {
  const test = store.getTest(req.params.id);
  if (!test) return fail(res, 404, 'Test record not found');

  const evaluation = evaluateStoredTest(test);
  evaluation.reportNumber = test.reportNumber;
  const { renderReport } = require('./reports/document');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(
    renderReport(evaluation, {
      reportNumber: test.reportNumber,
      attachments: test.attachments,
      signatures: test.signatures,
    }),
  );
});

app.get('/api/reports/:filename', authenticate, requirePermission('report:read'), (req, res) => {
  const file = resolveArtifact(req.params.filename);
  if (!file) return fail(res, 404, 'Generated report not found');

  const extension = path.extname(file);
  const types = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.html': 'text/html; charset=utf-8',
  };

  res.setHeader('Content-Type', types[extension] || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${path.basename(file)}"`,
  );
  res.sendFile(file);
});

// ---------------------------------------------------------------------------
// Planning, dashboard and audit
// ---------------------------------------------------------------------------

app.post('/api/planning/test-loads', authenticate, requirePermission('test:read'), (req, res) => {
  const { instrument } = req.body || {};
  if (!instrument) return fail(res, 400, 'Instrument data is required');

  try {
    res.json({
      loads: suggestTestLoads(instrument, loadRules()),
      eccentricityLoad: eccentricityLoad(instrument, loadRules()),
    });
  } catch (error) {
    fail(res, 400, error.message);
  }
});

app.post('/api/planning/mpe', authenticate, requirePermission('test:read'), (req, res) => {
  const { instrument, load, inService } = req.body || {};
  if (!instrument || load === undefined) return fail(res, 400, 'instrument and load are required');

  try {
    const result = mpeForLoad({
      accuracyClass: instrument.accuracyClass,
      e: instrument.e,
      eUnit: instrument.unit,
      load,
      loadUnit: instrument.unit,
      inService: Boolean(inService),
      rules: loadRules(),
    });
    res.json(result);
  } catch (error) {
    fail(res, 400, error.message);
  }
});

app.get('/api/dashboard', authenticate, requirePermission('dashboard:read'), (req, res) => {
  const statistics = store.stats();
  const rules = loadRules();

  // Verdict distribution per test module, computed from the stored evaluations.
  const moduleResults = {};
  store.listTests().forEach((test) => {
    (test.lastEvaluation?.moduleResults || []).forEach((module) => {
      moduleResults[module.moduleId] = moduleResults[module.moduleId] || { pass: 0, fail: 0, not_tested: 0 };
      moduleResults[module.moduleId][module.status] = (moduleResults[module.moduleId][module.status] || 0) + 1;
    });
  });

  res.json({
    ...statistics,
    moduleResults,
    rulesRevision: rules.revision,
    standard: rules.standard,
    pdfRenderer: { available: Boolean(findChrome()), binary: findChrome() },
  });
});

app.get('/api/audit', authenticate, requirePermission('audit:read'), (req, res) => {
  res.json({
    entries: store.listAudit({ limit: Number(req.query.limit || 100), testId: req.query.testId || null }),
    chain: store.verifyAuditChain(),
  });
});

// ---------------------------------------------------------------------------
// Static app fallback
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && fs.existsSync(path.join(publicDir, 'index.html'))) {
    return res.sendFile(path.join(publicDir, 'index.html'));
  }
  if (req.path.startsWith('/api')) return fail(res, 404, `No API route for ${req.method} ${req.path}`);
  return next();
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  if (res.headersSent) return next(error);
  return fail(res, 500, 'The server could not complete the request.', process.env.NODE_ENV === 'production' ? null : error.message);
});

async function start() {
  ensureDirs();
  const rules = loadRules();
  const createdUsers = auth.seedDefaultUsers();

  app.listen(config.port, config.host, () => {
    console.log('');
    console.log('  NAWI Test Report System - OIML R 76 (SIH problem statement 26035)');
    console.log(`  Rule schema : ${rules.standard} revision ${rules.revision}`);
    console.log(`  Listening   : http://localhost:${config.port}`);
    console.log(`  Data        : ${config.dataDir}`);
    console.log(`  PDF engine  : ${findChrome() ? findChrome() : 'not found - HTML reports only'}`);
    if (createdUsers.length) {
      console.log(`  Seeded users: ${createdUsers.map((user) => `${user.username} (${user.role})`).join(', ')}`);
      console.log('  Default passwords are documented in the README - change them after first sign-in.');
    }
    console.log('');
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Failed to start:', error.message);
    process.exit(1);
  });
}

module.exports = { app, start, summariseTest };
