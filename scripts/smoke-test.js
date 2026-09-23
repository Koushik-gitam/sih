#!/usr/bin/env node
// End-to-end API test.
//
//   node scripts/smoke-test.js
//
// Boots the real server on a scratch data directory, then walks the complete
// laboratory workflow: sign-in, data entry, live evaluation, validation
// blocking, submission, role-based approval, locking, unlocking with a recorded
// justification, report generation and download, attachment handling, audit
// chain verification and permission denials.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT || 3987);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(ROOT, 'data', 'smoke');

const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures += 1;
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${name}${condition ? '' : `  -> ${detail}`}`);
}

async function call(pathname, { method = 'GET', body = null, token = null, raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== null) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });

  if (raw) return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()), headers: response.headers };

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data };
}

async function waitForServer(attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

const INSTRUMENT = {
  manufacturer: 'Smoke Test Industries',
  model: 'ST-15K',
  serialNumber: 'ST15-0001',
  accuracyClass: 'III',
  unit: 'kg',
  maxCapacity: 15,
  minCapacity: 0.1,
  e: 0.005,
  d: 0.005,
  loadReceptorSupportPoints: 4,
  instrumentType: 'single_interval',
  temperatureRange: { min: -10, max: 40 },
  nominalVoltage: 230,
};

const ENVIRONMENTAL = {
  ambientTemperatureCelsius: 23.5,
  relativeHumidityPercent: 52,
  barometricPressureKpa: 100.9,
  testDate: new Date().toISOString().slice(0, 10),
  testedBy: 'technician',
};

const MODULES = {
  weighing_test: {
    points: [
      { load: 0.1, indication: 0.1, additionalLoad: 0, direction: 'increasing' },
      { load: 2.5, indication: 2.5, additionalLoad: 0, direction: 'increasing' },
      { load: 7.5, indication: 7.5, additionalLoad: 0, direction: 'increasing' },
      { load: 15, indication: 15, additionalLoad: 0, direction: 'increasing' },
      { load: 15, indication: 15, additionalLoad: 0, direction: 'decreasing' },
    ],
  },
  repeatability_test: { sets: [{ load: 7.5, readings: [7.5, 7.505, 7.5] }] },
  eccentricity_test: {
    load: 5,
    centre: { indication: 5, additionalLoad: 0 },
    points: [
      { position: 'front-left', indication: 5, additionalLoad: 0 },
      { position: 'front-right', indication: 5.005, additionalLoad: 0 },
    ],
  },
  zero_setting_test: { initialZeroLoad: 0.5, zeroError: 0.001, trackingDeviation: 0.002 },
};

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NAWI_DATA_DIR: DATA_DIR,
      NAWI_QUIET: '1',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  server.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverLog += chunk.toString();
  });

  try {
    const ready = await waitForServer();
    if (!ready) throw new Error(`Server did not start. Output:\n${serverLog}`);
    console.log('\nServer started on', BASE, '\n');

    // 1 - health and metadata
    const health = await call('/api/health');
    check('health endpoint reports ok', health.status === 200 && health.data.status === 'ok', JSON.stringify(health.data));
    check('rule schema loaded', health.data.rules?.loaded === true);
    check('audit chain starts valid', health.data.auditChain?.valid === true);
    check('PDF renderer detected', health.data.pdfRenderer?.available === true, 'no Chromium binary found');

    const meta = await call('/api/meta');
    check('metadata exposes the 4 accuracy classes', meta.data.classes?.length === 4);
    check('metadata exposes 8 test modules', meta.data.testModules?.length === 8);
    check('metadata exposes 4 roles', meta.data.roles?.length === 4);

    // 2 - authentication
    const badLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'technician', password: 'wrong' } });
    check('wrong password is rejected', badLogin.status === 401);

    const techLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'technician', password: 'Technician@26035' } });
    check('technician signs in', techLogin.status === 200 && Boolean(techLogin.data.token));
    const technician = techLogin.data.token;

    const managerLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'manager', password: 'Manager@26035' } });
    const manager = managerLogin.data.token;

    const auditorLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'auditor', password: 'Auditor@26035' } });
    const auditor = auditorLogin.data.token;

    const unauthenticated = await call('/api/tests');
    check('unauthenticated access is refused', unauthenticated.status === 401);

    // 3 - role based access control
    const auditorCreate = await call('/api/tests', { method: 'POST', token: auditor, body: { instrument: INSTRUMENT } });
    check('auditor cannot create test records', auditorCreate.status === 403, `status ${auditorCreate.status}`);

    const techRules = await call('/api/rules', { method: 'PUT', token: technician, body: {} });
    check('technician cannot publish a rule schema', techRules.status === 403, `status ${techRules.status}`);

    // 4 - create and evaluate
    const created = await call('/api/tests', {
      method: 'POST',
      token: technician,
      body: { instrument: INSTRUMENT, laboratory: { name: 'Smoke Test Laboratory', labCode: 'STL-01' }, environmental: ENVIRONMENTAL },
    });
    check('technician creates a test record', created.status === 201 && Boolean(created.data.test?.id));
    check('report number is issued', /NAWI\/\d{4}\/\d{4}/.test(created.data.test?.reportNumber || ''), created.data.test?.reportNumber);
    const testId = created.data.test.id;

    const emptyEvaluation = await call('/api/evaluate', { method: 'POST', token: technician, body: { test: { instrument: INSTRUMENT, environmental: ENVIRONMENTAL, modules: {} } } });
    check('an empty record reports incomplete', emptyEvaluation.data.summary?.verdict === 'incomplete', emptyEvaluation.data.summary?.verdict);

    const noEnvironment = await call('/api/evaluate', {
      method: 'POST',
      token: technician,
      body: { test: { instrument: INSTRUMENT, environmental: {}, modules: MODULES } },
    });
    check('missing environmental conditions block the record', noEnvironment.data.summary?.verdict === 'invalid', noEnvironment.data.summary?.verdict);

    const validation = await call('/api/evaluate', {
      method: 'POST',
      token: technician,
      body: { test: { instrument: { ...INSTRUMENT, maxCapacity: 0.05, minCapacity: 10 }, environmental: ENVIRONMENTAL, modules: MODULES } },
    });
    check('Max < Min is rejected by validation', validation.data.validation.errors.some((error) => error.code === 'max_min'));

    const tooManyIntervals = await call('/api/evaluate', {
      method: 'POST',
      token: technician,
      body: { test: { instrument: { ...INSTRUMENT, maxCapacity: 200 }, environmental: ENVIRONMENTAL, modules: MODULES } },
    });
    check('n = Max/e outside class limits is rejected', tooManyIntervals.data.validation.errors.some((error) => error.code === 'interval_range'));

    const mpe = await call('/api/planning/mpe', { method: 'POST', token: technician, body: { instrument: INSTRUMENT, load: 15 } });
    check('MPE at 15 kg (3000 e) is 1.5 e = 0.0075 kg', mpe.data.mpe === 0.0075, String(mpe.data.mpe));

    const mpeInService = await call('/api/planning/mpe', { method: 'POST', token: technician, body: { instrument: INSTRUMENT, load: 15, inService: true } });
    check('in-service MPE is doubled', mpeInService.data.mpe === 0.015, String(mpeInService.data.mpe));

    const plan = await call('/api/planning/test-loads', { method: 'POST', token: technician, body: { instrument: INSTRUMENT } });
    check('load planner proposes bracket-covering loads', plan.data.loads.length >= 6 && plan.data.loads.some((entry) => entry.load === 2.505));
    check('load planner proposes the eccentricity load', plan.data.eccentricityLoad?.load === 5);

    // 5 - submission is blocked until the record is complete
    const prematureSubmit = await call(`/api/tests/${testId}/submit`, { method: 'POST', token: technician });
    check('submission is blocked without observations', prematureSubmit.status === 422, `status ${prematureSubmit.status}`);

    const patched = await call(`/api/tests/${testId}`, {
      method: 'PATCH',
      token: technician,
      body: { modules: MODULES, environmental: ENVIRONMENTAL, reason: 'Observations recorded in the laboratory' },
    });
    check('observations are stored', patched.status === 200 && Object.keys(patched.data.test.modules).length === 4);

    const evaluated = await call(`/api/tests/${testId}/evaluate`, { method: 'POST', token: technician });
    check('conforming record evaluates to PASS', evaluated.data.summary?.verdict === 'pass', JSON.stringify(evaluated.data.summary));
    check('all modules pass', evaluated.data.summary.modulesFailed === 0);
    check('integrity hash is produced', /^[0-9a-f]{64}$/.test(evaluated.data.evaluation.integrityHash));
    check('all expected modules are recorded', evaluated.data.summary.coverageComplete === true);

    const failing = await call('/api/evaluate', {
      method: 'POST',
      token: technician,
      body: {
        test: {
          instrument: INSTRUMENT,
          environmental: ENVIRONMENTAL,
          modules: { weighing_test: { points: [{ load: 15, indication: 15.02, additionalLoad: 0, direction: 'increasing' }] } },
        },
      },
    });
    check('a load outside the MPE produces FAIL', failing.data.summary?.verdict === 'fail', failing.data.summary?.verdict);
    check('the failing point is identified', failing.data.evaluation.modules[0].points[0].pass === false);
    check('coverage gaps are reported', failing.data.summary.coverageComplete === false, JSON.stringify(failing.data.summary.expectedModulesMissing));

    // 6 - attachments
    const attachment = await call(`/api/tests/${testId}/attachments`, {
      method: 'POST',
      token: technician,
      body: {
        filename: 'instrument-setup.txt',
        mimetype: 'text/plain',
        contentBase64: Buffer.from('photograph placeholder for the smoke test').toString('base64'),
      },
    });
    check('attachment is stored with a hash', attachment.status === 201 && attachment.data.attachment.sha256.length === 64);

    const downloadedAttachment = await call(`/api/tests/${testId}/attachments/${attachment.data.attachment.id}`, { token: technician, raw: true });
    check('attachment can be retrieved', downloadedAttachment.status === 200 && downloadedAttachment.buffer.length > 0);

    // 7 - submission, approval and locking
    const submitted = await call(`/api/tests/${testId}/submit`, { method: 'POST', token: technician });
    check('complete record is submitted for review', submitted.status === 200 && submitted.data.test.status === 'submitted');

    const techApprove = await call(`/api/tests/${testId}/approve`, { method: 'POST', token: technician });
    check('technician cannot approve', techApprove.status === 403, `status ${techApprove.status}`);

    const approved = await call(`/api/tests/${testId}/approve`, { method: 'POST', token: manager, body: { note: 'Reviewed against the audit trail' } });
    check('manager approves the report', approved.status === 200 && approved.data.test.status === 'approved');
    check('approved record is locked', approved.data.test.locked === true);
    check('approval signature is recorded', approved.data.test.signatures.some((signature) => signature.meaning === 'approved'));

    const editLocked = await call(`/api/tests/${testId}`, { method: 'PATCH', token: technician, body: { modules: MODULES } });
    check('locked record rejects edits', editLocked.status === 423, `status ${editLocked.status}`);

    const unlockWithoutReason = await call(`/api/tests/${testId}/unlock`, { method: 'POST', token: manager, body: { reason: 'short' } });
    check('unlocking requires a written justification', unlockWithoutReason.status === 400, `status ${unlockWithoutReason.status}`);

    // 8 - report generation and download
    const generated = await call(`/api/tests/${testId}/report?format=pdf,docx`, { token: manager });
    check('report generation returns artefacts', generated.status === 200 && generated.data.artifacts.length >= 3, JSON.stringify(generated.data.errors || []));
    const pdf = generated.data.artifacts.find((artifact) => artifact.format === 'pdf');
    const docx = generated.data.artifacts.find((artifact) => artifact.format === 'docx');
    check('PDF artefact produced', Boolean(pdf) && pdf.bytes > 5000, `bytes ${pdf?.bytes}`);
    check('DOCX artefact produced', Boolean(docx) && docx.bytes > 5000, `bytes ${docx?.bytes}`);
    check('artefacts carry SHA-256 hashes', /^[0-9a-f]{64}$/.test(pdf.sha256));

    const downloadedPdf = await call(pdf.download, { token: manager, raw: true });
    check('PDF can be downloaded', downloadedPdf.status === 200 && downloadedPdf.buffer.slice(0, 4).toString() === '%PDF');

    const preview = await call(`/api/tests/${testId}/report/preview`, { token: manager, raw: true });
    check('printable preview renders', preview.status === 200 && preview.buffer.toString().includes('Test Report'));

    // 9 - unlock with justification and dashboard/audit
    const unlocked = await call(`/api/tests/${testId}/unlock`, { method: 'POST', token: manager, body: { reason: 'Manufacturer requested correction of the serial number' } });
    check('manager unlocks with a justification', unlocked.status === 200 && unlocked.data.test.locked === false);
    check('unlock snapshots the previous state', (unlocked.data.test.revisions || []).length === 1);

    const dashboard = await call('/api/dashboard', { token: auditor });
    check('dashboard reports the record', dashboard.data.totalTests === 1);
    check('dashboard reflects the unlock (record back in review)', (dashboard.data.byStatus.submitted || 0) === 1, JSON.stringify(dashboard.data.byStatus));

    const audit = await call('/api/audit?limit=200', { token: auditor });
    check('audit ledger records the submission', audit.data.entries.some((entry) => entry.action === 'test.submitted'));
    check('audit ledger records the approval', audit.data.entries.some((entry) => entry.action === 'test.approved'));
    check('audit ledger records report generation', audit.data.entries.some((entry) => entry.action === 'report.generate'));
    check('audit ledger records the unlock', audit.data.entries.some((entry) => entry.action === 'test.unlock'));
    check('audit chain verifies after the workflow', audit.data.chain.valid === true, audit.data.chain.reason);

    const search = await call('/api/tests?query=Smoke', { token: auditor });
    check('repository search finds the record', search.data.count === 1);

    // 10 - administration
    const adminLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'Admin@26035' } });
    const admin = adminLogin.data.token;

    const userList = await call('/api/users', { token: admin });
    check('admin lists users', userList.status === 200 && userList.data.users.length === 4);

    const createdUser = await call('/api/users', { method: 'POST', token: admin, body: { username: 'inspector', password: 'Inspector@26035', name: 'State Inspector', role: 'auditor' } });
    check('admin creates a user', createdUser.status === 201 && createdUser.data.user.role === 'auditor');

    const weakPassword = await call('/api/users', { method: 'POST', token: admin, body: { username: 'weak', password: 'short', role: 'auditor' } });
    check('weak passwords are refused', weakPassword.status === 400);

    const rulesUpdate = await call('/api/rules', { method: 'PUT', token: admin, body: { standard: 'broken' } });
    check('invalid rule schema is refused', rulesUpdate.status === 400);

    const rulesHistory = await call('/api/rules/history', { token: admin });
    check('rule schema revisions are listed', rulesHistory.status === 200);
  } catch (error) {
    failures += 1;
    console.error('\nSmoke test aborted:', error.message);
    console.error(serverLog.slice(-2000));
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 400));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}

main();
