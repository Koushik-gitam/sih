// NAWI Test Report System - front end.
//
// Single page application, no build step: the browser loads exactly the files
// that are served. Sections:
//   1 tiny helpers and API client (with offline queueing)
//   2 module form definitions
//   3 views (dashboard, repository, test editor, report, rules, audit, admin)
//   4 event wiring

(function main() {
  'use strict';

  // ------------------------------------------------------------------ helpers

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const esc = (value) =>
    String(value === null || value === undefined ? '' : value).replace(
      /[&<>"']/g,
      (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
    );

  const num = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const round = (value, decimals = 4) =>
    Number.isFinite(Number(value)) ? Number(Number(value).toFixed(decimals)) : null;

  const fmt = (value, decimals = 3) => {
    if (value === null || value === undefined || value === '') return '–';
    if (typeof value !== 'number') return esc(value);
    return Number.isFinite(value) ? String(Number(value.toFixed(decimals))) : '–';
  };

  const parseList = (text) =>
    String(text || '')
      .split(/[,;\s]+/)
      .map((part) => Number(part))
      .filter((value) => Number.isFinite(value));

  function getPath(object, path) {
    return String(path)
      .split('.')
      .reduce((current, key) => (current === null || current === undefined ? undefined : current[key]), object);
  }

  function setPath(object, path, value) {
    const keys = String(path).split('.');
    let current = object;
    keys.slice(0, -1).forEach((key) => {
      const index = Number(key);
      const target = Number.isInteger(index) ? index : key;
      if (current[target] === undefined) current[target] = Number.isInteger(index) ? [] : {};
      current = current[target];
    });
    const last = keys[keys.length - 1];
    current[Number.isInteger(Number(last)) ? Number(last) : last] = value;
    return object;
  }

  function toast(message, tone = '') {
    const root = $('#toast-root');
    const element = document.createElement('div');
    element.className = `toast ${tone}`;
    element.innerHTML = esc(message);
    root.appendChild(element);
    setTimeout(() => element.remove(), tone === 'error' ? 7000 : 4200);
  }

  const badge = (status) =>
    `<span class="badge ${esc(status)}">${esc(String(status || '').replace(/_/g, ' ').toUpperCase())}</span>`;

  // --------------------------------------------------------------- api client

  const state = {
    token: localStorage.getItem('nawi.token'),
    user: null,
    meta: null,
    tests: [],
    dashboard: null,
    model: null,
    testId: null,
    evaluation: null,
    validation: null,
    moduleTab: 'weighing_test',
    online: navigator.onLine,
    pending: 0,
    evaluateTimer: null,
    draftTimer: null,
    busy: false,
  };

  async function api(path, options = {}) {
    const { method = 'GET', body = null, allowQueue = true } = options;
    const request = { method, headers: {} };
    if (state.token) request.headers.Authorization = `Bearer ${state.token}`;
    if (body !== null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(path, request);
    } catch (networkError) {
      if (method !== 'GET' && allowQueue && window.Offline) {
        await window.Offline.enqueue({ path, method, body });
        state.pending += 1;
        renderOnlineState();
        throw new Error('No connection. The action was queued locally and will be replayed automatically.');
      }
      throw new Error('No connection to the server.');
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (response.status === 401) {
      signOut(false);
      throw new Error(data?.error || 'Session expired, please sign in again.');
    }

    if (!response.ok) {
      const error = new Error(data?.error || `Request failed with status ${response.status}`);
      error.details = data?.details || null;
      error.status = response.status;
      throw error;
    }

    return data;
  }

  /** Download a protected artefact through the authenticated API. */
  async function download(path, filename) {
    const response = await fetch(path, { headers: { Authorization: `Bearer ${state.token}` } });
    if (!response.ok) throw new Error('The report could not be downloaded.');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function openPreview(testId) {
    const response = await fetch(`/api/tests/${testId}/report/preview`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!response.ok) throw new Error('Preview unavailable.');
    const html = await response.text();
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.open(url, '_blank');
  }

  // ------------------------------------------------------- module definitions

  const OPTIONAL_NOTE = 'Leave blank if this module was not tested.';

  const MODULES = {
    weighing_test: {
      title: 'Weighing performance test',
      clause: 'A.4.4.1 – A.4.4.3',
      hint: `Errors at increasing and decreasing loads. ${OPTIONAL_NOTE}`,
      list: {
        key: 'points',
        label: 'Load point',
        columns: [
          { key: 'load', label: 'Load L', type: 'number' },
          { key: 'indication', label: 'Indication I', type: 'number' },
          { key: 'additionalLoad', label: 'ΔL sub-weight', type: 'number', default: 0 },
          { key: 'direction', label: 'Direction', type: 'select', options: ['increasing', 'decreasing'], default: 'increasing' },
        ],
      },
      suggest: true,
    },
    eccentricity_test: {
      title: 'Eccentricity (corner load) test',
      clause: '3.6.2 / A.4.7',
      hint: 'Conventional test load is 1/3 of Max. Record the centre reading and each position.',
      scalars: [
        { key: 'load', label: 'Test load L', type: 'number' },
        { key: 'centre.indication', label: 'Centre indication I', type: 'number' },
      ],
      list: {
        key: 'points',
        label: 'Position',
        columns: [
          { key: 'position', label: 'Position', type: 'select', options: ['front-left', 'front-right', 'rear-left', 'rear-right', 'left', 'right', 'front', 'rear'] },
          { key: 'indication', label: 'Indication I', type: 'number' },
          { key: 'additionalLoad', label: 'ΔL', type: 'number', default: 0 },
        ],
      },
      suggestLoad: true,
    },
    repeatability_test: {
      title: 'Repeatability test',
      clause: '3.6.1 / A.4.4.2',
      hint: 'The difference between repeated results shall not exceed the absolute MPE for that load.',
      list: {
        key: 'sets',
        label: 'Load set',
        columns: [
          { key: 'load', label: 'Load', type: 'number' },
          { key: 'readingsText', label: 'Readings (comma separated, ≥ 2)', type: 'text' },
        ],
      },
    },
    zero_setting_test: {
      title: 'Zero-setting and zero-tracking test',
      clause: '4.5 / A.4.4.2',
      hint: 'Initial zero range, accuracy after zero setting (±0.25 e) and automatic zero-tracking deviation.',
      scalars: [
        { key: 'initialZeroLoad', label: 'Initial zero-setting load (range ±20 % of Max)', type: 'number' },
        { key: 'zeroError', label: 'Error at zero E₀ (limit ±0.25 e)', type: 'number' },
        { key: 'trackingDeviation', label: 'Zero-tracking deviation (limit 0.5 e)', type: 'number' },
      ],
    },
    tare_test: {
      title: 'Tare device test',
      clause: '4.6 / A.4.6',
      hint: 'Tare accuracy (±0.25 e) and the MPE applied to net values.',
      scalars: [
        { key: 'tareLoad', label: 'Tare load', type: 'number' },
        { key: 'indicationAfterTare', label: 'Indication after taring (target 0)', type: 'number' },
        { key: 'additionalLoad', label: 'ΔL at zero (sub-weight)', type: 'number', default: 0 },
      ],
      list: {
        key: 'netPoints',
        label: 'Net value point',
        columns: [
          { key: 'load', label: 'Net load', type: 'number' },
          { key: 'indication', label: 'Indication', type: 'number' },
          { key: 'additionalLoad', label: 'ΔL', type: 'number', default: 0 },
        ],
      },
    },
    temperature_test: {
      title: 'Temperature influence test',
      clause: '3.9.2 / A.5.5',
      hint: 'Static temperatures across the declared working range; errors must stay inside the MPE.',
      scalars: [{ key: 'load', label: 'Test load', type: 'number' }],
      list: {
        key: 'points',
        label: 'Temperature point',
        columns: [
          { key: 'temperatureCelsius', label: 'Temperature (°C)', type: 'number' },
          { key: 'load', label: 'Load', type: 'number' },
          { key: 'indication', label: 'Indication', type: 'number' },
          { key: 'additionalLoad', label: 'ΔL', type: 'number', default: 0 },
        ],
        defaults: [{ temperatureCelsius: 20 }],
      },
    },
    power_supply_test: {
      title: 'Power supply (voltage) influence test',
      clause: '3.9.3 / A.5.6',
      hint: 'Mains voltage between 0.85 and 1.10 × Unom.',
      scalars: [{ key: 'nominalVoltage', label: 'Nominal voltage Unom (V)', type: 'number' }],
      list: {
        key: 'points',
        label: 'Voltage point',
        columns: [
          { key: 'voltage', label: 'Voltage (V)', type: 'number' },
          { key: 'load', label: 'Load', type: 'number' },
          { key: 'indication', label: 'Indication', type: 'number' },
          { key: 'additionalLoad', label: 'ΔL', type: 'number', default: 0 },
        ],
      },
    },
    creep_test: {
      title: 'Creep and return to zero test',
      clause: '3.9.4 / A.5.2',
      hint: 'Deviation of the indication while loaded (limit 0.5 e) and on returning to zero.',
      scalars: [
        { key: 'load', label: 'Load on the receptor', type: 'number' },
        { key: 'returnToZeroIndication', label: 'Indication after removing the load', type: 'number' },
      ],
      list: {
        key: 'points',
        label: 'Timed reading',
        columns: [
          { key: 'elapsedMinutes', label: 'Elapsed (min)', type: 'number' },
          { key: 'indication', label: 'Indication', type: 'number' },
        ],
        defaults: [{ elapsedMinutes: 0 }, { elapsedMinutes: 5 }, { elapsedMinutes: 15 }, { elapsedMinutes: 30 }],
      },
    },
  };

  const MODULE_ORDER = Object.keys(MODULES);

  // ------------------------------------------------------- model <-> payload

  function emptyModel() {
    const today = new Date().toISOString().slice(0, 10);
    return {
      reportNumber: null,
      laboratory: { name: '', labCode: '', address: '' },
      instrument: {
        manufacturer: '', model: '', serialNumber: '', accuracyClass: 'III', unit: 'kg',
        maxCapacity: '', minCapacity: '', e: '', d: '',
        loadReceptorSupportPoints: 4, instrumentType: 'single_interval',
        temperatureRange: { min: -10, max: 40 }, nominalVoltage: '',
        modelApprovalReference: '',
      },
      environmental: {
        ambientTemperatureCelsius: 24, relativeHumidityPercent: 55,
        barometricPressureKpa: 101.3, testDate: today, testedBy: '', standardWeights: '',
      },
      modules: Object.fromEntries(MODULE_ORDER.map((id) => [id, seedModule(id)])),
    };
  }

  function seedModule(id) {
    const definition = MODULES[id];
    const module = {};
    (definition.scalars || []).forEach((scalar) => setPath(module, scalar.key, ''));
    if (definition.list) {
      const rows = (definition.list.defaults || [{}]).length ? [] : [];
      setPath(module, definition.list.key, rows);
      if (definition.list.defaults) setPath(module, definition.list.key, JSON.parse(JSON.stringify(definition.list.defaults)));
    }
    return module;
  }

  /** Convert the stored record into the UI model (readings array -> text). */
  function toUiModel(test) {
    const model = {
      reportNumber: test.reportNumber || null,
      laboratory: { name: '', labCode: '', address: '', ...(test.laboratory || {}) },
      instrument: { ...emptyModel().instrument, ...(test.instrument || {}) },
      environmental: { ...emptyModel().environmental, ...(test.environmental || {}) },
      modules: {},
    };

    MODULE_ORDER.forEach((id) => {
      const definition = MODULES[id];
      const stored = (test.modules || {})[id] || {};
      const module = {};
      (definition.scalars || []).forEach((scalar) => {
        const value = getPath(stored, scalar.key);
        setPath(module, scalar.key, value === undefined || value === null ? '' : value);
      });
      if (definition.list) {
        const rows = getPath(stored, definition.list.key) || [];
        setPath(
          module,
          definition.list.key,
          rows.map((row) => {
            const copy = { ...row };
            if (copy.readings && Array.isArray(copy.readings)) {
              copy.readingsText = copy.readings.join(', ');
              delete copy.readings;
            }
            return copy;
          }),
        );
      }
      model.modules[id] = module;
    });

    return model;
  }

  function compact(object) {
    const result = {};
    Object.entries(object || {}).forEach(([key, value]) => {
      if (value === '' || value === null || value === undefined) return;
      if (Array.isArray(value)) {
        const list = value.map((entry) => (entry && typeof entry === 'object' ? compact(entry) : entry)).filter((entry) => entry !== undefined);
        if (list.length) result[key] = list;
        return;
      }
      if (typeof value === 'object') {
        const nested = compact(value);
        if (Object.keys(nested).length) result[key] = nested;
        return;
      }
      result[key] = value;
    });
    return result;
  }

  /** Build the API payload from the UI model. */
  function buildPayload(model) {
    const instrument = compact({
      ...model.instrument,
      maxCapacity: num(model.instrument.maxCapacity),
      minCapacity: num(model.instrument.minCapacity),
      e: num(model.instrument.e),
      d: num(model.instrument.d),
      loadReceptorSupportPoints: num(model.instrument.loadReceptorSupportPoints),
      nominalVoltage: num(model.instrument.nominalVoltage),
      temperatureRange: {
        min: num(model.instrument.temperatureRange?.min),
        max: num(model.instrument.temperatureRange?.max),
      },
    });

    const environmental = compact({
      ...model.environmental,
      ambientTemperatureCelsius: num(model.environmental.ambientTemperatureCelsius),
      relativeHumidityPercent: num(model.environmental.relativeHumidityPercent),
      barometricPressureKpa: num(model.environmental.barometricPressureKpa),
    });

    const modules = {};
    MODULE_ORDER.forEach((id) => {
      const definition = MODULES[id];
      const source = model.modules[id] || {};
      const module = {};

      (definition.scalars || []).forEach((scalar) => {
        const value = getPath(source, scalar.key);
        if (value !== '' && value !== null && value !== undefined) setPath(module, scalar.key, num(value));
      });

      if (definition.list) {
        const rows = (getPath(source, definition.list.key) || []).map((row) => {
          const copy = { ...row };
          if (copy.readingsText !== undefined) {
            copy.readings = parseList(copy.readingsText);
            delete copy.readingsText;
          }
          Object.keys(copy).forEach((key) => {
            if (copy[key] === '' || copy[key] === null) delete copy[key];
            else if (key !== 'position' && key !== 'direction' && typeof copy[key] === 'string') copy[key] = num(copy[key]);
          });
          return copy;
        });
        const cleaned = rows.filter((row) => Object.keys(row).length);
        if (cleaned.length) setPath(module, definition.list.key, cleaned);
      }

      if (Object.keys(module).length) modules[id] = module;
    });

    return {
      instrument,
      laboratory: compact(model.laboratory),
      environmental,
      modules,
    };
  }

  // ------------------------------------------------------------------ layout

  function shell(title, subtitle, body) {
    const user = state.user;
    const canAdmin = user?.role === 'admin';
    const links = [
      ['#/dashboard', 'Dashboard', '▤'],
      ['#/tests', 'Test repository', '⌸'],
      ['#/new', 'New test record', '＋'],
      ['#/rules', 'OIML R 76 rules', '§'],
      ['#/audit', 'Audit ledger', '⛓'],
    ];
    if (canAdmin) links.push(['#/admin', 'Administration', '⚙']);
    const current = location.hash || '#/dashboard';

    return `
      <div class="sidebar">
        <div class="brand">
          <div class="mark">R76</div>
          <div>
            <div class="name">NAWI Test Report System</div>
            <div class="sub">SIH 26035 · DoCA</div>
          </div>
        </div>
        ${links
          .map(
            ([href, label, icon]) =>
              `<a class="nav-item ${current.startsWith(href) ? 'active' : ''}" href="${href}"><span class="ico">${icon}</span>${label}</a>`,
          )
          .join('')}
        <div class="footer">
          OIML R 76-1:2006 · revision ${esc(state.meta?.rulesRevision || '')}<br />
          ${state.online ? 'Online' : 'Offline – changes are queued'}${state.pending ? ` · ${state.pending} queued` : ''}
        </div>
      </div>

      <div class="main">
        <div class="topbar">
          <div>
            <h1>${esc(title)}</h1>
            <div class="small muted">${subtitle}</div>
          </div>
          <div class="spacer"></div>
          ${state.online ? '' : '<span class="offline-flag">Offline mode</span>'}
          ${state.pending ? `<button class="btn small secondary" data-action="sync-queue">Sync ${state.pending} queued</button>` : ''}
          <button class="btn small secondary" data-action="open-password">Change password</button>
          <div class="who">
            <b>${esc(user?.name || user?.username || '')}</b>
            ${esc(user?.roleLabel || user?.role || '')}
          </div>
          <button class="btn small" data-action="logout">Sign out</button>
        </div>
        <div class="content">${body}</div>
      </div>`;
  }

  function renderLogin(error) {
    $('#app').innerHTML = `
      <div class="login-wrap" style="width:100%">
        <form class="login" id="login-form">
          <h1>NAWI Test Report System</h1>
          <div class="sub">
            Automated recording, OIML R 76 compliance evaluation and standardized report generation for
            non-automatic weighing instruments.<br />Problem statement 26035 · Department of Consumer Affairs.
          </div>
          ${error ? `<div class="banner fail"><div><div class="big">Sign-in failed</div>${esc(error)}</div></div>` : ''}
          <div class="field">
            <label for="username">Username</label>
            <input id="username" name="username" autocomplete="username" required />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required />
          </div>
          <button class="btn" type="submit" style="width:100%">Sign in</button>
          <div class="demo">
            Seeded accounts (change the passwords after first sign-in):<br />
            <code>admin / Admin@26035</code> · <code>manager / Manager@26035</code> ·
            <code>technician / Technician@26035</code> · <code>auditor / Auditor@26035</code>
          </div>
        </form>
      </div>`;
  }

  // ------------------------------------------------------------------ router

  function router() {
    if (!state.token || !state.user) return renderLogin();

    const hash = location.hash || '#/dashboard';
    const [, section, id] = hash.split('/');
    window.scrollTo({ top: 0 });

    switch (section) {
      case 'tests':
        return id ? viewTest(id) : viewRepository();
      case 'new':
        return viewTest(null);
      case 'rules':
        return viewRules();
      case 'audit':
        return viewAudit();
      case 'admin':
        return viewAdmin();
      default:
        return viewDashboard();
    }
  }

  // --------------------------------------------------------------- dashboard

  async function viewDashboard() {
    $('#app').innerHTML = shell('Dashboard', 'Loading laboratory statistics…', '<div class="card">Loading…</div>');

    try {
      state.dashboard = await api('/api/dashboard');
    } catch (error) {
      $('#app').innerHTML = shell('Dashboard', 'Repository unavailable', `<div class="banner fail"><div>${esc(error.message)}</div></div>`);
      return;
    }

    const data = state.dashboard;
    const statusTotal = Math.max(1, data.totalTests);
    const verdicts = data.byVerdict;

    const statusBar = Object.entries(data.byStatus)
      .map(([status, count]) => ({ status, count, percent: (count / statusTotal) * 100 }))
      .filter((entry) => entry.count > 0);

    const colourFor = { draft: '#94a3b8', submitted: '#3b82f6', approved: '#10b981', rejected: '#ef4444' };

    const body = `
      <div class="banner info">
        <div>
          <div class="big">OIML R 76 test reports for non-automatic weighing instruments</div>
          <div class="small">
            Rule schema ${esc(data.standard)} revision ${esc(data.rulesRevision)} ·
            ${data.pdfRenderer.available ? 'PDF rendering available' : 'PDF rendering unavailable (HTML reports only)'} ·
            audit chain ${data.auditChain.valid ? 'verified' : '<b>BROKEN</b>'}
          </div>
        </div>
      </div>

      <div class="grid g4">
        <div class="stat teal"><div class="k">Test records</div><div class="v">${data.totalTests}</div><div class="s">${data.byStatus.draft} drafts</div></div>
        <div class="stat amber"><div class="k">Awaiting approval</div><div class="v">${data.pendingApproval}</div><div class="s">submitted for review</div></div>
        <div class="stat green"><div class="k">Conforming</div><div class="v">${verdicts.pass || 0}</div><div class="s">verdict PASS</div></div>
        <div class="stat red"><div class="k">Non-conforming</div><div class="v">${verdicts.fail || 0}</div><div class="s">verdict FAIL</div></div>
      </div>

      <div class="grid g2" style="margin-top:18px">
        <div class="card">
          <h2>Workflow status</h2>
          <p class="hint">Where the laboratory's test records currently sit.</p>
          <div class="rule-scale" style="margin-bottom:12px">
            ${statusBar
              .map((entry) => `<span style="width:${entry.percent}%;background:${colourFor[entry.status] || '#cbd5e1'}"></span>`)
              .join('')}
          </div>
          <table class="data">
            <thead><tr><th>Status</th><th class="num">Records</th><th class="num">Share</th></tr></thead>
            <tbody>
              ${Object.entries(data.byStatus)
                .map(
                  ([status, count]) => `<tr><td>${badge(status)}</td><td class="num">${count}</td><td class="num">${((count / statusTotal) * 100).toFixed(0)}%</td></tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </div>

        <div class="card">
          <h2>Compliance verdicts</h2>
          <p class="hint">Result of the deterministic evaluation for each stored record.</p>
          <table class="data">
            <thead><tr><th>Verdict</th><th class="num">Records</th><th>Meaning</th></tr></thead>
            <tbody>
              <tr><td>${badge('pass')}</td><td class="num">${verdicts.pass || 0}</td><td class="muted">all tested errors inside the MPE</td></tr>
              <tr><td>${badge('fail')}</td><td class="num">${verdicts.fail || 0}</td><td class="muted">at least one MPE exceeded</td></tr>
              <tr><td>${badge('invalid')}</td><td class="num">${verdicts.invalid || 0}</td><td class="muted">blocking validation findings</td></tr>
              <tr><td>${badge('incomplete')}</td><td class="num">${verdicts.incomplete || 0}</td><td class="muted">no observations recorded</td></tr>
              <tr><td>${badge('not_tested')}</td><td class="num">${verdicts.unevaluated || 0}</td><td class="muted">not evaluated yet</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="grid g2">
        <div class="card">
          <h2>Records by accuracy class</h2>
          <p class="hint">Distribution of instruments under test.</p>
          <table class="data">
            <thead><tr><th>Class</th><th class="num">Records</th></tr></thead>
            <tbody>
              ${
                Object.entries(data.byClass).length
                  ? Object.entries(data.byClass)
                      .sort()
                      .map(([key, count]) => `<tr><td>Class ${esc(key)}</td><td class="num">${count}</td></tr>`)
                      .join('')
                  : '<tr><td colspan="2" class="muted">No records yet</td></tr>'
              }
            </tbody>
          </table>
        </div>

        <div class="card">
          <h2>Recently updated records</h2>
          <p class="hint">Click through to review the observations or generate the report.</p>
          <table class="data">
            <thead><tr><th>Report</th><th>Instrument</th><th>Status</th><th>Verdict</th></tr></thead>
            <tbody>
              ${
                data.recent.length
                  ? data.recent
                      .map(
                        (test) => `<tr class="clickable" data-action="open-test" data-id="${esc(test.id)}">
                          <td><b>${esc(test.reportNumber || '—')}</b><div class="muted small">${esc(String(test.updatedAt).slice(0, 16).replace('T', ' '))}</div></td>
                          <td>${esc(test.manufacturer || '')}<div class="muted small">${esc(test.model || '')}</div></td>
                          <td>${badge(test.status)}</td>
                          <td>${test.verdict ? badge(test.verdict) : '<span class="muted">not evaluated</span>'}</td>
                        </tr>`,
                      )
                      .join('')
                  : '<tr><td colspan="4" class="muted">No records yet – start with “New test record”.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </div>`;

    $('#app').innerHTML = shell('Dashboard', 'Laboratory overview and report status', body);
  }

  // -------------------------------------------------------------- repository

  async function viewRepository(query = {}) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });

    $('#app').innerHTML = shell('Test repository', 'Search previously recorded instruments and reports', '<div class="card">Loading…</div>');

    try {
      const data = await api(`/api/tests?${params.toString()}`);
      state.tests = data.tests;
    } catch (error) {
      $('#app').innerHTML = shell('Test repository', 'Unavailable', `<div class="banner fail"><div>${esc(error.message)}</div></div>`);
      return;
    }

    const body = `
      <div class="card">
        <form id="search-form" class="grid g4">
          <div class="field" style="margin:0">
            <label for="q">Search</label>
            <input id="q" name="query" value="${esc(query.query || '')}" placeholder="Report no, manufacturer, model, serial" />
          </div>
          <div class="field" style="margin:0">
            <label for="class">Accuracy class</label>
            <select id="class" name="accuracyClass">
              <option value="">Any</option>
              ${['I', 'II', 'III', 'IIII'].map((key) => `<option value="${key}" ${query.accuracyClass === key ? 'selected' : ''}>Class ${key}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="margin:0">
            <label for="status">Status</label>
            <select id="status" name="status">
              <option value="">Any</option>
              ${['draft', 'submitted', 'approved', 'rejected']
                .map((status) => `<option value="${status}" ${query.status === status ? 'selected' : ''}>${status}</option>`)
                .join('')}
            </select>
          </div>
          <div class="field" style="margin:0; justify-content:flex-end">
            <button class="btn" type="submit">Search</button>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="row">
          <h2 style="margin:0">${state.tests.length} record${state.tests.length === 1 ? '' : 's'}</h2>
          <div class="spacer"></div>
          <a class="btn teal" href="#/new">New test record</a>
        </div>
        <table class="data" style="margin-top:14px">
          <thead>
            <tr>
              <th>Report number</th><th>Instrument</th><th>Class</th><th>Test date</th>
              <th>Modules</th><th>Status</th><th>Verdict</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${
              state.tests.length
                ? state.tests
                    .map(
                      (test) => `<tr>
                <td><b>${esc(test.reportNumber || '—')}</b><div class="muted small">v${test.version}${test.locked ? ' · locked' : ''}</div></td>
                <td>${esc(test.instrument.manufacturer || '')}<div class="muted small">${esc(test.instrument.model || '')} · SN ${esc(test.instrument.serialNumber || '—')}</div></td>
                <td>Class ${esc(test.instrument.accuracyClass || '—')}<div class="muted small">Max ${esc(test.instrument.maxCapacity ?? '—')} ${esc(test.instrument.unit || '')} · e ${esc(test.instrument.e ?? '—')}</div></td>
                <td>${esc(test.testDate || '—')}</td>
                <td class="small">${test.modulesRecorded.length} of ${MODULE_ORDER.length}</td>
                <td>${badge(test.status)}</td>
                <td>${test.lastEvaluation ? badge(test.lastEvaluation.verdict) : '<span class="muted">not evaluated</span>'}</td>
                <td class="right"><button class="btn small secondary" data-action="open-test" data-id="${esc(test.id)}">Open</button></td>
              </tr>`,
                    )
                    .join('')
                : '<tr><td colspan="8" class="muted">No records match the search.</td></tr>'
            }
          </tbody>
        </table>
      </div>`;

    $('#app').innerHTML = shell('Test repository', 'Search, review and retrieve previously generated reports', body);
  }

  // -------------------------------------------------------------- test editor

  async function viewTest(id) {
    state.busy = true;

    if (!id) {
      state.model = emptyModel();
      state.testId = null;
      state.evaluation = null;
      state.validation = null;
    } else {
      $('#app').innerHTML = shell('Test record', 'Loading…', '<div class="card">Loading…</div>');
      try {
        const data = await api(`/api/tests/${id}`);
        state.model = toUiModel(data.test);
        state.testId = data.test.id;
        state.evaluation = data.evaluation;
        state.validation = data.validation;
        state.test = data.test;
      } catch (error) {
        $('#app').innerHTML = shell('Test record', 'Unavailable', `<div class="banner fail"><div>${esc(error.message)}</div></div>`);
        return;
      }
    }

    renderEditor();
  }

  function renderEditor() {
    const model = state.model;
    const test = state.test || {};
    const locked = Boolean(test.locked);
    const evaluation = state.evaluation;

    const workflow = `
      <div class="workflow">
        <span class="step ${test.status === 'draft' || !test.status ? 'current' : 'done'}">1 · Record observations</span>
        <span class="step ${test.status === 'submitted' ? 'current' : test.status === 'approved' ? 'done' : ''}">2 · Submit for review</span>
        <span class="step ${test.status === 'approved' ? 'done' : ''}">3 · Approve, sign and publish</span>
      </div>`;

    const instrumentField = (key, label, options = {}) => `
      <div class="field">
        <label for="f-${key}">${esc(label)}</label>
        ${
          options.type === 'select'
            ? `<select id="f-${key}" data-path="instrument.${key}" ${options.disabled ? 'disabled' : ''}>
                ${options.options.map((value) => `<option value="${esc(value)}" ${String(getPath(model, `instrument.${key}`)) === String(value) ? 'selected' : ''}>${esc(value)}</option>`).join('')}
              </select>`
            : `<input id="f-${key}" data-path="instrument.${key}" type="${options.type || 'text'}" ${options.step ? `step="${options.step}"` : ''} value="${esc(getPath(model, `instrument.${key}`) ?? '')}" ${options.disabled ? 'disabled' : ''} />`
        }
        ${options.help ? `<span class="help">${esc(options.help)}</span>` : ''}
      </div>`;

    const classification = evaluation?.classification;

    const body = `
      ${workflow}
      <div id="verdict-host">${verdictHostHtml()}</div>

      <div class="grid g2" style="grid-template-columns: 1.55fr 1fr; align-items:start">
        <div>
          <div class="card">
            <h2>1. Instrument data and technical characteristics</h2>
            <p class="hint">These parameters select the MPE brackets from OIML R 76-1 Table 6 and the classification limits of Table 3.</p>
            <div class="grid g3">
              ${instrumentField('manufacturer', 'Manufacturer', { disabled: locked })}
              ${instrumentField('model', 'Model / type designation', { disabled: locked })}
              ${instrumentField('serialNumber', 'Serial number', { disabled: locked })}
              ${instrumentField('accuracyClass', 'Accuracy class', { type: 'select', options: ['I', 'II', 'III', 'IIII'], disabled: locked })}
              ${instrumentField('unit', 'Working unit', { type: 'select', options: ['mg', 'g', 'kg', 't'], disabled: locked })}
              ${instrumentField('instrumentType', 'Instrument type', { type: 'select', options: ['single_interval', 'multi_interval', 'multiple_range'], disabled: locked })}
              ${instrumentField('maxCapacity', 'Maximum capacity Max', { type: 'number', step: 'any', disabled: locked })}
              ${instrumentField('minCapacity', 'Minimum capacity Min', { type: 'number', step: 'any', disabled: locked })}
              ${instrumentField('e', 'Verification scale interval e', { type: 'number', step: 'any', disabled: locked })}
              ${instrumentField('d', 'Actual scale interval d', { type: 'number', step: 'any', disabled: locked })}
              ${instrumentField('loadReceptorSupportPoints', 'Load receptor support points', { type: 'number', disabled: locked })}
              ${instrumentField('nominalVoltage', 'Nominal voltage Unom (V)', { type: 'number', step: 'any', disabled: locked })}
              ${instrumentField('temperatureRange.min', 'Working temperature min (°C)', { type: 'number', step: 'any', disabled: locked })}
              ${instrumentField('temperatureRange.max', 'Working temperature max (°C)', { type: 'number', step: 'any', disabled: locked })}
              ${instrumentField('modelApprovalReference', 'Model approval reference', { disabled: locked })}
            </div>
            ${
              classification
                ? `<div class="chips mt">
                     <span class="chip">Class ${esc(classification.className)}</span>
                     <span class="chip">n = Max / e = ${esc(classification.intervals ?? '—')}</span>
                     <span class="chip ${classification.intervalsWithinLimits === false ? 'bad' : 'ok'}">interval limits ${classification.intervalsWithinLimits === false ? 'exceeded' : 'satisfied'}</span>
                     <span class="chip">Min required ≥ ${esc(classification.requiredMinCapacity)} ${esc(model.instrument.unit)}</span>
                   </div>`
                : ''
            }
          </div>

          <div class="card">
            <h2>2. Laboratory and environmental conditions</h2>
            <p class="hint">Environmental conditions are enforced before a test can be submitted (OIML R 76-1 3.5.3.1).</p>
            <div class="grid g3">
              <div class="field"><label>Laboratory name</label><input data-path="laboratory.name" value="${esc(model.laboratory.name || '')}" ${locked ? 'disabled' : ''} /></div>
              <div class="field"><label>Laboratory code</label><input data-path="laboratory.labCode" value="${esc(model.laboratory.labCode || '')}" ${locked ? 'disabled' : ''} /></div>
              <div class="field"><label>Test date</label><input data-path="environmental.testDate" type="date" value="${esc(model.environmental.testDate || '')}" ${locked ? 'disabled' : ''} /></div>
              <div class="field"><label>Ambient temperature (°C)</label><input data-path="environmental.ambientTemperatureCelsius" type="number" step="any" value="${esc(model.environmental.ambientTemperatureCelsius ?? '')}" ${locked ? 'disabled' : ''} /></div>
              <div class="field"><label>Relative humidity (%)</label><input data-path="environmental.relativeHumidityPercent" type="number" step="any" value="${esc(model.environmental.relativeHumidityPercent ?? '')}" ${locked ? 'disabled' : ''} /></div>
              <div class="field"><label>Barometric pressure (kPa)</label><input data-path="environmental.barometricPressureKpa" type="number" step="any" value="${esc(model.environmental.barometricPressureKpa ?? '')}" ${locked ? 'disabled' : ''} /></div>
              <div class="field"><label>Tested by</label><input data-path="environmental.testedBy" value="${esc(model.environmental.testedBy || '')}" ${locked ? 'disabled' : ''} /></div>
              <div class="field"><label>Standard weights used</label><input data-path="environmental.standardWeights" value="${esc(model.environmental.standardWeights || '')}" ${locked ? 'disabled' : ''} /></div>
              <div class="field"><label>Weights traceability</label><input data-path="environmental.weightsTraceability" value="${esc(model.environmental.weightsTraceability || '')}" ${locked ? 'disabled' : ''} /></div>
            </div>
          </div>

          <div class="card">
            <h2>3. Test observations</h2>
            <p class="hint">Enter the raw readings exactly as observed. ΔL is the change-over sub-weight (about 1/10 e) added until the indication steps up by one interval.</p>
            <div class="tabs" id="module-tabs">${moduleTabsHtml()}</div>
            ${renderModuleEditor(state.moduleTab, locked)}
          </div>
        </div>

        <div>
          <div id="verdict-panel-host">${renderVerdictPanel(evaluation)}</div>
          ${renderActionsPanel(test, locked)}
          ${renderAttachmentsPanel(test, locked)}
          <div id="validation-host">${renderValidationPanel(state.validation)}</div>
        </div>
      </div>`;

    $('#app').innerHTML = shell(
      test.reportNumber ? `Test record ${test.reportNumber}` : 'New test record',
      `OIML R 76 evaluation · rule schema revision ${esc(state.meta?.rulesRevision || '')}`,
      body,
    );
  }

  function verdictHostHtml() {
    if (state.evaluation) return verdictBanner(state.evaluation);
    return '<div class="banner info"><div>Record the instrument details and observations, then press <b>Evaluate</b> to obtain the compliance verdict.</div></div>';
  }

  function moduleTabsHtml() {
    return MODULE_ORDER.map((moduleId) => {
      const moduleResult = state.evaluation?.modules?.find((module) => module.moduleId === moduleId);
      const status = moduleResult ? moduleResult.status : 'not_tested';
      return `<button class="tab ${state.moduleTab === moduleId ? 'active' : ''}" data-action="module-tab" data-module="${moduleId}">
        <span class="dot ${status}"></span>${esc(MODULES[moduleId].title.replace(' test', ''))}
      </button>`;
    }).join('');
  }

  function renderModuleEditor(moduleId, locked) {
    const definition = MODULES[moduleId];
    const module = state.model.modules[moduleId] || {};
    const moduleResult = state.evaluation?.modules?.find((candidate) => candidate.moduleId === moduleId);

    const scalarFields = (definition.scalars || [])
      .map(
        (scalar) => `
        <div class="field">
          <label for="s-${moduleId}-${scalar.key}">${esc(scalar.label)}</label>
          <input id="s-${moduleId}-${scalar.key}" data-path="modules.${moduleId}.${scalar.key}" type="${scalar.type}" step="any"
            value="${esc(getPath(module, scalar.key) ?? '')}" ${locked ? 'disabled' : ''} />
        </div>`,
      )
      .join('');

    let listTable = '';
    if (definition.list) {
      const rows = getPath(module, definition.list.key) || [];
      listTable = `
        <table class="data" style="margin-top:12px">
          <thead>
            <tr>
              <th style="width:40px">#</th>
              ${definition.list.columns.map((column) => `<th>${esc(column.label)}</th>`).join('')}
              <th style="width:110px">Result</th>
              <th style="width:60px"></th>
            </tr>
          </thead>
          <tbody>
            ${
              rows.length
                ? rows
                    .map(
                      (row, index) => `<tr data-row="${index}">
                  <td class="muted">${index + 1}</td>
                  ${definition.list.columns
                    .map((column) => {
                      const path = `modules.${moduleId}.${definition.list.key}.${index}.${column.key}`;
                      const value = row[column.key] ?? '';
                      if (column.type === 'select') {
                        return `<td><select data-path="${path}" ${locked ? 'disabled' : ''}>
                          ${column.options.map((option) => `<option value="${esc(option)}" ${String(value) === String(option) ? 'selected' : ''}>${esc(option)}</option>`).join('')}
                        </select></td>`;
                      }
                      const type = column.type === 'number' ? 'number' : 'text';
                      return `<td><input data-path="${path}" type="${type}" ${type === 'number' ? 'step="any"' : ''} value="${esc(value)}" ${locked ? 'disabled' : ''} /></td>`;
                    })
                    .join('')}
                  <td class="result">${rowResultCell(moduleId, index)}</td>
                  <td>${locked ? '' : `<button class="btn small ghost" data-action="remove-row" data-module="${moduleId}" data-index="${index}" title="Remove">✕</button>`}</td>
                </tr>`,
                    )
                    .join('')
                : `<tr><td colspan="${definition.list.columns.length + 3}" class="muted">No rows yet.</td></tr>`
            }
          </tbody>
        </table>
        ${
          locked
            ? ''
            : `<div class="row mt">
                <button class="btn small secondary" data-action="add-row" data-module="${moduleId}">＋ Add ${esc(definition.list.label)}</button>
                ${
                  definition.suggest
                    ? `<button class="btn small secondary" data-action="suggest-loads" data-module="${moduleId}">Suggest loads covering every MPE bracket</button>`
                    : ''
                }
                ${
                  definition.suggestLoad
                    ? `<button class="btn small secondary" data-action="suggest-eccentricity">Use 1/3 of Max as the test load</button>`
                    : ''
                }
              </div>`
        }`;
    }

    return `
      <div>
        <div class="row" style="justify-content:space-between; margin-bottom:10px">
          <div>
            <b>${esc(definition.title)}</b>
            <div class="small muted">OIML R 76-1 ${esc(definition.clause)} · ${esc(definition.hint)}</div>
          </div>
          ${moduleResult ? badge(moduleResult.status) : badge('not_tested')}
        </div>
        ${scalarFields ? `<div class="grid g3">${scalarFields}</div>` : ''}
        ${listTable}
        ${renderModuleChecks(moduleResult)}
      </div>`;
  }

  function rowResultCell(moduleId, index) {
    const moduleResult = state.evaluation?.modules?.find((candidate) => candidate.moduleId === moduleId);
    if (!moduleResult || !moduleResult.points[index]) return '<span class="muted small">—</span>';

    const point = moduleResult.points[index];
    if (point.incomplete) return '<span class="badge incomplete">INCOMPLETE</span>';

    const detail =
      point.correctedError !== undefined && point.correctedError !== null
        ? `E<sub>c</sub> ${fmt(point.correctedError, 3)} · MPE ±${fmt(point.mpe, 3)}`
        : point.range !== undefined
          ? `range ${fmt(point.range, 3)} · MPE ±${fmt(point.mpe, 3)}`
          : point.differenceFromCentre !== undefined && point.differenceFromCentre !== null
            ? `Δcentre ${fmt(point.differenceFromCentre, 3)} · MPE ±${fmt(point.mpe, 3)}`
            : '';

    return `<span class="badge ${point.pass ? 'pass' : 'fail'}">${point.pass ? 'PASS' : 'FAIL'}</span><div class="muted small">${detail}</div>`;
  }

  function renderModuleChecks(moduleResult) {
    if (!moduleResult || !moduleResult.checks || !moduleResult.checks.length) return '';
    return `
      <table class="data" style="margin-top:12px">
        <thead><tr><th>Check</th><th>Requirement</th><th class="num">Recorded</th><th class="num">Limit</th><th>Result</th></tr></thead>
        <tbody>
          ${moduleResult.checks
            .map(
              (check) => `<tr>
                <td>${esc(check.label)}</td>
                <td class="muted small">${esc(check.criterion)}</td>
                <td class="num">${fmt(check.value, 4)}${check.valueInE !== undefined && check.valueInE !== null ? ` (${fmt(check.valueInE, 2)} e)` : ''}</td>
                <td class="num">${fmt(check.limit, 4)}</td>
                <td><span class="badge ${check.pass ? 'pass' : 'fail'}">${check.pass ? 'PASS' : 'FAIL'}</span></td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>`;
  }

  function verdictBanner(evaluation) {
    const summary = evaluation.summary;
    const tone = summary.verdict === 'pass' ? 'pass' : summary.verdict === 'fail' ? 'fail' : summary.verdict === 'invalid' ? 'invalid' : 'incomplete';
    return `
      <div class="banner ${tone}">
        <div>
          <div class="big">${esc(String(summary.verdict).toUpperCase())}</div>
          <ul>
            <li>Modules: ${summary.modulesPassed} pass · ${summary.modulesFailed} fail · ${summary.modulesNotTested} not tested</li>
            <li>Load points: ${summary.pointsEvaluated} evaluated · ${summary.pointsFailed} outside the MPE · ${summary.checksFailed} failed checks</li>
            ${
              summary.coverageComplete
                ? '<li>Coverage: all expected modules recorded.</li>'
                : `<li>Coverage gaps: ${summary.expectedModulesMissing.map((id) => esc(id.replace(/_/g, ' '))).join(', ')}</li>`
            }
            <li class="mono">integrity ${esc(String(evaluation.integrityHash).slice(0, 24))}…</li>
          </ul>
        </div>
      </div>`;
  }

  function renderVerdictPanel(evaluation) {
    if (!evaluation) {
      return `<div class="card"><h2>Live verdict</h2><p class="hint">The engine evaluates as you type once the instrument identifies an MPE bracket. Nothing is stored on the server until you save.</p></div>`;
    }

    return `
      <div class="card">
        <h2>Live verdict</h2>
        <p class="hint">Computed by the deterministic engine on every change.</p>
        <table class="data">
          <thead><tr><th>Module</th><th>Result</th><th class="num">Failed</th></tr></thead>
          <tbody>
            ${evaluation.modules
              .map(
                (module) => `<tr>
                  <td>${esc(module.title.replace(' test', ''))}</td>
                  <td>${badge(module.status)}</td>
                  <td class="num">${module.failedPoints + (module.failedChecks || 0)}</td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>
        ${
          evaluation.ruleView
            ? `<div class="mt small muted">
                 Class ${esc(evaluation.ruleView.className)} MPE brackets applied:
                 ${evaluation.ruleView.mpeTable
                   .map((row) => `±${fmt(row.mpeInE, 2)} e up to ${row.upToInE === null ? 'max' : `${row.upToInE} e`}`)
                   .join(' · ')}
               </div>`
            : ''
        }
      </div>`;
  }

  function renderActionsPanel(test, locked) {
    const status = test.status || 'new';
    const canApprove = ['lab_manager', 'admin'].includes(state.user?.role);
    const canEdit = !locked && ['technician', 'lab_manager', 'admin'].includes(state.user?.role);
    const canReport = ['lab_manager', 'admin'].includes(state.user?.role);

    return `
      <div class="card">
        <h2>Actions</h2>
        <p class="hint">
          Status: ${badge(status)} ${test.locked ? '· locked (approved)' : ''}
          ${test.reportNumber ? `<br />Report number ${esc(test.reportNumber)}` : ''}
        </p>
        <div class="row">
          ${canEdit ? '<button class="btn teal" data-action="evaluate">Evaluate</button>' : ''}
          ${canEdit && !state.testId ? '<button class="btn" data-action="save-new">Create record</button>' : ''}
          ${canEdit && state.testId ? '<button class="btn" data-action="save-draft">Save draft</button>' : ''}
          ${state.testId ? '<button class="btn secondary" data-action="offline-save">Save copy offline</button>' : ''}
        </div>
        <div class="row mt">
          ${state.testId && canEdit && status !== 'submitted' ? '<button class="btn" data-action="submit-test">Submit for review</button>' : ''}
          ${state.testId && canApprove && status === 'submitted' ? '<button class="btn teal" data-action="approve-test">Approve &amp; sign</button>' : ''}
          ${state.testId && canApprove && status === 'submitted' ? '<button class="btn danger" data-action="reject-test">Reject</button>' : ''}
          ${state.testId && canApprove && locked ? '<button class="btn secondary" data-action="unlock-test">Unlock with justification</button>' : ''}
        </div>
        <div class="row mt">
          ${state.testId && canReport ? '<button class="btn teal" data-action="generate-report">Generate PDF + Word</button>' : ''}
          ${state.testId ? '<button class="btn secondary" data-action="preview-report">Preview report</button>' : ''}
        </div>
        ${state.testId ? `<div class="row mt"><button class="btn ghost" data-action="delete-test">Delete record</button></div>` : ''}
      </div>`;
  }

  function renderAttachmentsPanel(test, locked) {
    const attachments = test.attachments || [];
    return `
      <div class="card">
        <h2>Photographs and supporting documents</h2>
        <p class="hint">Device set-up photographs, certificates or annexures. Each file is hashed and referenced in the report.</p>
        ${
          attachments.length
            ? `<table class="data">
                <thead><tr><th>File</th><th class="num">Size</th><th>SHA-256</th></tr></thead>
                <tbody>
                  ${attachments
                    .map(
                      (attachment) => `<tr>
                        <td><a href="#" data-action="download-attachment" data-test="${esc(test.id)}" data-attachment="${esc(attachment.id)}">${esc(attachment.filename)}</a></td>
                        <td class="num">${(attachment.size / 1024).toFixed(1)} kB</td>
                        <td class="mono">${esc(String(attachment.sha256).slice(0, 16))}…</td>
                      </tr>`,
                    )
                    .join('')}
                </tbody>
              </table>`
            : '<p class="muted small">No attachments yet.</p>'
        }
        ${
          state.testId && !locked
            ? `<div class="field mt">
                 <label for="attachment-input">Attach a file</label>
                 <input id="attachment-input" type="file" multiple />
                 <span class="help">Stored under the test record with its SHA-256 hash.</span>
               </div>`
            : state.testId
              ? ''
              : '<p class="muted small">Create the record first to attach files.</p>'
        }
      </div>`;
  }

  function renderValidationPanel(validation) {
    if (!validation) return '';
    const errors = validation.errors || [];
    const warnings = validation.warnings || [];

    return `
      <div class="card">
        <h2>Validation findings</h2>
        <p class="hint">Blocking findings must be resolved before a report can be approved.</p>
        ${
          errors.length
            ? `<div class="banner fail" style="margin-bottom:10px"><div><b>${errors.length} blocking finding${errors.length === 1 ? '' : 's'}</b>
                 <ul>${errors.slice(0, 12).map((error) => `<li>${esc(error.field)} — ${esc(error.message)}</li>`).join('')}</ul>
                 ${errors.length > 12 ? `<div class="small">…and ${errors.length - 12} more</div>` : ''}
               </div></div>`
            : '<div class="banner pass" style="margin-bottom:10px"><div>No blocking findings.</div></div>'
        }
        ${
          warnings.length
            ? `<div class="banner incomplete"><div><b>${warnings.length} warning${warnings.length === 1 ? '' : 's'}</b>
                 <ul>${warnings.slice(0, 8).map((warning) => `<li>${esc(warning.field)} — ${esc(warning.message)}</li>`).join('')}</ul>
               </div></div>`
            : ''
        }
      </div>`;
  }

  // -------------------------------------------------------------------- rules

  async function viewRules() {
    const rules = state.meta;
    const body = `
      <div class="card">
        <h2>Active rule schema ${rules ? `<span class="clause">${esc(rules.standard)} · revision ${esc(rules.rulesRevision)}</span>` : ''}</h2>
        <p class="hint">
          Every metrological limit the engine applies lives in <span class="mono">rules/oiml-r76.json</span>.
          When OIML R 76 or the Legal Metrology (General) Rules are revised, the schema is updated and the
          engine follows it without code changes. Each report records the revision that produced it.
        </p>
      </div>

      ${(rules?.classes || [])
        .map(
          (definition) => `
        <div class="card">
          <h2>Class ${esc(definition.key)} <span class="clause">${esc(definition.title)}</span></h2>
          <table class="data">
            <thead><tr><th>e range (g)</th><th class="num">n = Max / e min</th><th class="num">n max</th><th class="num">Min (lower limit)</th><th>MPE brackets (in e)</th></tr></thead>
            <tbody>
              ${definition.bands
                .map(
                  (band) => `<tr>
                    <td>${band.eMinGrams} ≤ e ${band.eMaxGrams === null ? '' : `≤ ${band.eMaxGrams}`}</td>
                    <td class="num">${band.intervalsMin}</td>
                    <td class="num">${band.intervalsMax ?? 'unbounded'}</td>
                    <td class="num">${band.minCapacityInE} e</td>
                    <td>${band.mpeBrackets
                      .map((bracket) => `±${bracket.mpeInE} e${bracket.upToInE === null ? ' (above)' : ` ≤ ${bracket.upToInE} e`}`)
                      .join(' · ')}</td>
                  </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </div>`,
        )
        .join('')}

      <div class="card">
        <h2>Automated test modules</h2>
        <table class="data">
          <thead><tr><th>Module</th><th>Clause</th><th>Criterion</th></tr></thead>
          <tbody>
            ${(rules?.testModules || [])
              .map(
                (module) => `<tr>
                  <td><b>${esc(module.title)}</b><div class="muted small">${esc(module.description)}</div></td>
                  <td class="mono small">${esc(module.clause)}</td>
                  <td class="small">${esc(module.criterion)}</td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>

      ${
        state.user?.role === 'admin'
          ? `<div class="card">
               <h2>Publish a revised rule schema</h2>
               <p class="hint">Paste the updated JSON. It is validated before it is activated; the current file is archived first.</p>
               <div class="field">
                 <label for="rules-json">Rule schema JSON</label>
                 <textarea id="rules-json" rows="8" placeholder='{ "standard": "...", "revision": "1.1.0", "classes": { ... } }'></textarea>
               </div>
               <button class="btn teal" data-action="publish-rules">Validate and publish</button>
             </div>`
          : ''
      }`;

    $('#app').innerHTML = shell('OIML R 76 rules', 'Classification limits and maximum permissible errors applied by the engine', body);
  }

  // -------------------------------------------------------------------- audit

  async function viewAudit() {
    $('#app').innerHTML = shell('Audit ledger', 'Loading…', '<div class="card">Loading…</div>');

    let data;
    try {
      data = await api('/api/audit?limit=120');
    } catch (error) {
      $('#app').innerHTML = shell('Audit ledger', 'Unavailable', `<div class="banner fail"><div>${esc(error.message)}</div></div>`);
      return;
    }

    const body = `
      <div class="banner ${data.chain.valid ? 'pass' : 'fail'}">
        <div>
          <div class="big">${data.chain.valid ? 'Integrity chain verified' : 'Integrity chain broken'}</div>
          <div class="small">
            ${data.chain.entries} entries · each entry stores the hash of its predecessor.
            ${data.chain.valid ? 'No history has been altered or removed.' : esc(data.chain.reason)}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="row"><h2 style="margin:0">Ledger</h2><div class="spacer"></div>
          <button class="btn small secondary" data-action="verify-audit">Re-verify chain</button>
        </div>
        <table class="data" style="margin-top:12px">
          <thead><tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Record</th><th>Hash</th></tr></thead>
          <tbody>
            ${data.entries
              .map(
                (entry) => `<tr>
                  <td class="num">${entry.seq}</td>
                  <td class="small">${esc(String(entry.at).slice(0, 19).replace('T', ' '))}</td>
                  <td>${esc(entry.actor?.username || 'system')}<div class="muted small">${esc(entry.actor?.role || '')}</div></td>
                  <td><b>${esc(entry.action)}</b>${entry.details ? `<div class="muted small">${esc(JSON.stringify(entry.details).slice(0, 90))}</div>` : ''}</td>
                  <td class="small mono">${esc(String(entry.testId || '—').slice(0, 8))}</td>
                  <td class="mono">${esc(String(entry.hash).slice(0, 16))}…</td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>`;

    $('#app').innerHTML = shell('Audit ledger', 'Append-only, hash-chained record of every action', body);
  }

  // -------------------------------------------------------------------- admin

  async function viewAdmin() {
    let data;
    $('#app').innerHTML = shell('Administration', 'Loading…', '<div class="card">Loading…</div>');

    try {
      data = await api('/api/users');
    } catch (error) {
      $('#app').innerHTML = shell('Administration', 'Unavailable', `<div class="banner fail"><div>${esc(error.message)}</div></div>`);
      return;
    }

    const body = `
      <div class="card">
        <h2>Users and roles</h2>
        <p class="hint">Permissions are enforced on the server; hiding a control in the interface is never the only protection.</p>
        <table class="data">
          <thead><tr><th>User</th><th>Role</th><th>Last sign-in</th><th>State</th><th>Must change password</th><th></th></tr></thead>
          <tbody>
            ${data.users
              .map(
                (user) => `<tr>
                  <td><b>${esc(user.name)}</b><div class="muted small">${esc(user.username)}</div></td>
                  <td>${esc(user.roleLabel)}</td>
                  <td class="small">${user.lastLoginAt ? esc(String(user.lastLoginAt).slice(0, 16).replace('T', ' ')) : '—'}</td>
                  <td>${user.active ? badge('approved') : badge('rejected')}</td>
                  <td class="small">${user.mustChangePassword ? 'yes (seeded default)' : 'no'}</td>
                  <td class="right"><button class="btn small secondary" data-action="toggle-user" data-id="${esc(user.id)}" data-active="${user.active}">${user.active ? 'Disable' : 'Enable'}</button></td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>Create a user</h2>
        <form id="user-form" class="grid g3">
          <div class="field"><label for="u-username">Username</label><input id="u-username" name="username" required /></div>
          <div class="field"><label for="u-name">Full name</label><input id="u-name" name="name" /></div>
          <div class="field"><label for="u-role">Role</label>
            <select id="u-role" name="role">
              ${Object.entries(state.meta?.roles || {})
                .map(([key, value]) => `<option value="${esc(key)}">${esc(value.label)}</option>`)
                .join('')}
            </select>
          </div>
          <div class="field"><label for="u-lab">Laboratory code</label><input id="u-lab" name="labCode" /></div>
          <div class="field"><label for="u-password">Initial password (≥10 chars, letter + digit)</label><input id="u-password" name="password" type="password" required /></div>
          <div class="field" style="justify-content:flex-end"><button class="btn teal" type="submit">Create user</button></div>
        </form>
      </div>

      <div class="card">
        <h2>Role permissions</h2>
        <table class="data">
          <thead><tr><th>Role</th><th>Purpose</th><th>Permissions</th></tr></thead>
          <tbody>
            ${(state.meta?.roles || [])
              .map(
                (role) => `<tr>
                  <td><b>${esc(role.label)}</b><div class="muted small">${esc(role.key)}</div></td>
                  <td class="small">${esc(role.description)}</td>
                  <td class="small mono">${esc(role.permissions.join(', '))}</td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>`;

    $('#app').innerHTML = shell('Administration', 'Users, roles and permissions', body);
  }

  // ------------------------------------------------------------------ actions

  async function refreshMeta() {
    try {
      state.meta = await api('/api/meta');
    } catch {
      /* metadata is only needed for descriptions */
    }
  }

  function scheduleEvaluate() {
    clearTimeout(state.evaluateTimer);
    state.evaluateTimer = setTimeout(runEvaluation, 550);
    clearTimeout(state.draftTimer);
    state.draftTimer = setTimeout(saveOfflineDraft, 1200);
  }

  async function runEvaluation({ announce = false } = {}) {
    const payload = buildPayload(state.model);
    try {
      const data = await api('/api/evaluate', { method: 'POST', body: { test: payload } });
      state.evaluation = data.evaluation;
      state.validation = data.validation;
      updateEvaluationSurfaces();
      if (announce) toast(`Verdict: ${data.summary.verdict.toUpperCase()}`, data.summary.verdict === 'pass' ? 'ok' : '');
    } catch (error) {
      if (announce) toast(error.message, 'error');
    }
  }

  /**
   * Repaint only the parts that depend on the evaluation. The observation inputs
   * themselves are left untouched so typing is never interrupted or refocused.
   */
  function updateEvaluationSurfaces() {
    const verdict = $('#verdict-host');
    if (verdict) verdict.innerHTML = verdictHostHtml();

    const panel = $('#verdict-panel-host');
    if (panel) panel.innerHTML = renderVerdictPanel(state.evaluation);

    const tabs = $('#module-tabs');
    if (tabs) tabs.innerHTML = moduleTabsHtml();

    const moduleId = state.moduleTab;
    const moduleResult = state.evaluation?.modules?.find((candidate) => candidate.moduleId === moduleId);

    $$('[data-row]').forEach((row) => {
      const index = Number(row.getAttribute('data-row'));
      const point = moduleResult?.points[index];

      const cell = row.querySelector('.result');
      if (cell) cell.innerHTML = rowResultCell(moduleId, index);

      $$('input, select', row).forEach((input) => {
        input.classList.remove('good', 'bad');
        if (point && point.pass === false) input.classList.add('bad');
        else if (point && point.pass === true) input.classList.add('good');
      });
    });

    const validationHost = $('#validation-host');
    if (validationHost) validationHost.innerHTML = renderValidationPanel(state.validation);
  }

  async function saveOfflineDraft() {
    if (!state.model || !window.Offline) return;
    const id = state.testId || 'unsaved';
    try {
      await window.Offline.saveDraft({ id, testId: state.testId, model: state.model });
    } catch {
      /* drafts are best effort */
    }
  }

  async function persist({ create = false, announce = true } = {}) {
    const payload = buildPayload(state.model);

    if (!payload.instrument.manufacturer || !payload.instrument.model) {
      throw new Error('Manufacturer and model are required before the record can be stored.');
    }

    if (create || !state.testId) {
      const created = await api('/api/tests', {
        method: 'POST',
        body: {
          instrument: payload.instrument,
          laboratory: payload.laboratory,
          environmental: payload.environmental,
          modules: payload.modules,
        },
      });
      state.testId = created.test.id;
      state.test = created.test;
      if (announce) toast(`Record ${created.test.reportNumber} created as a draft.`, 'ok');
    } else {
      const updated = await api(`/api/tests/${state.testId}`, {
        method: 'PATCH',
        body: {
          instrument: payload.instrument,
          laboratory: payload.laboratory,
          environmental: payload.environmental,
          modules: payload.modules,
          reason: 'Observations updated from the data-entry screen',
        },
      });
      state.test = updated.test;
      state.validation = updated.validation;
      if (announce) toast('Draft saved.', 'ok');
    }

    if (window.Offline) await window.Offline.deleteDraft(state.testId || 'unsaved');
    await runEvaluation();
    renderEditor();
  }

  async function withBusy(button, work) {
    if (state.busy) return;
    state.busy = true;
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spin"></span>';
    try {
      await work();
    } catch (error) {
      toast(error.message, 'error');
      if (error.details && Array.isArray(error.details) && error.details.length) {
        state.validation = { ...(state.validation || {}), errors: error.details, warnings: state.validation?.warnings || [] };
        renderEditor();
      }
    } finally {
      state.busy = false;
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  // ------------------------------------------------------------- event wiring

  document.addEventListener('click', async (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.getAttribute('data-action');

    if (action === 'open-test') {
      event.preventDefault();
      location.hash = `#/tests/${trigger.getAttribute('data-id')}`;
      return;
    }

    if (action === 'logout') {
      await signOut(true);
      return;
    }

    if (action === 'module-tab') {
      state.moduleTab = trigger.getAttribute('data-module');
      renderEditor();
      return;
    }

    if (action === 'add-row') {
      const moduleId = trigger.getAttribute('data-module');
      const definition = MODULES[moduleId];
      const rows = getPath(state.model.modules[moduleId], definition.list.key) || [];
      const row = {};
      definition.list.columns.forEach((column) => {
        row[column.key] = column.default !== undefined ? column.default : '';
      });
      rows.push(row);
      setPath(state.model.modules[moduleId], definition.list.key, rows);
      renderEditor();
      return;
    }

    if (action === 'remove-row') {
      const moduleId = trigger.getAttribute('data-module');
      const index = Number(trigger.getAttribute('data-index'));
      const definition = MODULES[moduleId];
      const rows = getPath(state.model.modules[moduleId], definition.list.key) || [];
      rows.splice(index, 1);
      setPath(state.model.modules[moduleId], definition.list.key, rows);
      renderEditor();
      return;
    }

    if (action === 'suggest-loads') {
      const moduleId = trigger.getAttribute('data-module');
      try {
        const payload = buildPayload(state.model);
        const data = await api('/api/planning/test-loads', { method: 'POST', body: { instrument: payload.instrument } });
        const rows = data.loads.map((entry) => ({
          load: entry.load,
          indication: '',
          additionalLoad: 0,
          direction: 'increasing',
        }));
        setPath(state.model.modules[moduleId], MODULES[moduleId].list.key, rows);
        renderEditor();
        toast(`${rows.length} load points proposed, covering every MPE bracket.`, 'ok');
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }

    if (action === 'suggest-eccentricity') {
      try {
        const payload = buildPayload(state.model);
        const data = await api('/api/planning/test-loads', { method: 'POST', body: { instrument: payload.instrument } });
        state.model.modules.eccentricity_test.load = data.eccentricityLoad.load;
        renderEditor();
        toast(`Test load set to ${data.eccentricityLoad.load} (${data.eccentricityLoad.basis}).`, 'ok');
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }

    if (action === 'evaluate') {
      await withBusy(trigger, () => runEvaluation({ announce: true }));
      return;
    }

    if (action === 'save-new') {
      await withBusy(trigger, () => persist({ create: true }));
      return;
    }

    if (action === 'save-draft') {
      await withBusy(trigger, () => persist({ create: false }));
      return;
    }

    if (action === 'offline-save') {
      await saveOfflineDraft();
      toast('A copy of this record is stored in this browser for offline use.', 'ok');
      return;
    }

    if (action === 'submit-test') {
      await withBusy(trigger, async () => {
        await persist({ create: !state.testId, announce: false });
        await api(`/api/tests/${state.testId}/submit`, { method: 'POST' });
        toast('Submitted for review.', 'ok');
        await reloadTest();
      });
      return;
    }

    if (action === 'approve-test') {
      const note = prompt('Approval note (optional):') || '';
      await withBusy(trigger, async () => {
        await api(`/api/tests/${state.testId}/approve`, { method: 'POST', body: { note } });
        toast('Report approved and signed; the record is now locked.', 'ok');
        await reloadTest();
      });
      return;
    }

    if (action === 'reject-test') {
      const note = prompt('Reason for rejection (required):');
      if (!note) return;
      await withBusy(trigger, async () => {
        await api(`/api/tests/${state.testId}/reject`, { method: 'POST', body: { note } });
        toast('Record rejected.', 'ok');
        await reloadTest();
      });
      return;
    }

    if (action === 'unlock-test') {
      const reason = prompt('Justification for unlocking an approved record (required, min 8 characters):');
      if (!reason) return;
      await withBusy(trigger, async () => {
        await api(`/api/tests/${state.testId}/unlock`, { method: 'POST', body: { reason } });
        toast('Record unlocked; the previous state was snapshotted.', 'ok');
        await reloadTest();
      });
      return;
    }

    if (action === 'delete-test') {
      if (!confirm('Delete this test record? The audit ledger keeps a record of the deletion.')) return;
      await withBusy(trigger, async () => {
        await api(`/api/tests/${state.testId}`, { method: 'DELETE' });
        toast('Record deleted.', 'ok');
        location.hash = '#/tests';
      });
      return;
    }

    if (action === 'generate-report') {
      await withBusy(trigger, async () => {
        const data = await api(`/api/tests/${state.testId}/report?format=pdf,docx`, { method: 'GET' });
        const lines = data.artifacts.map((artifact) => `${artifact.format.toUpperCase()} ${(artifact.bytes / 1024).toFixed(0)} kB`).join(' · ');
        toast(`Report ${data.reportNumber} generated: ${lines}`, 'ok');

        const pdf = data.artifacts.find((artifact) => artifact.format === 'pdf');
        const docx = data.artifacts.find((artifact) => artifact.format === 'docx');
        modal(
          'Generated report artefacts',
          `<p class="hint">Verdict ${badge(data.verdict)} · integrity <span class="mono">${esc(String(data.integrityHash).slice(0, 32))}…</span></p>
           <table class="data"><thead><tr><th>Format</th><th class="num">Size</th><th>SHA-256</th><th></th></tr></thead><tbody>
             ${data.artifacts
               .map(
                 (artifact) => `<tr>
                   <td><b>${esc(artifact.format.toUpperCase())}</b><div class="muted small">${esc(artifact.filename)}</div></td>
                   <td class="num">${(artifact.bytes / 1024).toFixed(1)} kB</td>
                   <td class="mono small">${esc(String(artifact.sha256).slice(0, 20))}…</td>
                   <td class="right"><button class="btn small teal" data-action="download-artifact" data-url="${esc(artifact.download)}" data-name="${esc(artifact.filename)}">Download</button></td>
                 </tr>`,
               )
               .join('')}
           </tbody></table>
           ${data.errors.length ? `<div class="banner incomplete mt"><div>Some formats failed: ${esc(JSON.stringify(data.errors))}</div></div>` : ''}
           <div class="row mt"><div class="spacer"></div><button class="btn secondary" data-action="close-modal">Close</button></div>`,
        );
      });
      return;
    }

    if (action === 'download-artifact') {
      event.preventDefault();
      await download(trigger.getAttribute('data-url'), trigger.getAttribute('data-name'));
      return;
    }

    if (action === 'preview-report') {
      await withBusy(trigger, () => openPreview(state.testId));
      return;
    }

    if (action === 'download-attachment') {
      event.preventDefault();
      await download(
        `/api/tests/${trigger.getAttribute('data-test')}/attachments/${trigger.getAttribute('data-attachment')}`,
        'attachment',
      );
      return;
    }

    if (action === 'close-modal') {
      $('#modal-root').innerHTML = '';
      return;
    }

    if (action === 'open-password') {
      modal(
        'Change password',
        `<form id="password-form">
           <div class="field"><label for="pw-current">Current password</label><input id="pw-current" name="currentPassword" type="password" required /></div>
           <div class="field"><label for="pw-new">New password</label><input id="pw-new" name="newPassword" type="password" required />
             <span class="help">At least 10 characters, including a letter and a digit.</span></div>
           <div class="row"><div class="spacer"></div><button class="btn" type="submit">Update password</button>
             <button class="btn secondary" type="button" data-action="close-modal">Cancel</button></div>
         </form>`,
      );
      return;
    }

    if (action === 'verify-audit') {
      await withBusy(trigger, async () => {
        const data = await api('/api/audit?limit=1');
        toast(data.chain.valid ? `Integrity chain verified over ${data.chain.entries} entries.` : `Chain broken: ${data.chain.reason}`, data.chain.valid ? 'ok' : 'error');
        await viewAudit();
      });
      return;
    }

    if (action === 'publish-rules') {
      const textarea = $('#rules-json');
      await withBusy(trigger, async () => {
        const schema = JSON.parse(textarea.value);
        await api('/api/rules', { method: 'PUT', body: schema });
        await refreshMeta();
        toast('Rule schema published; previous revision archived.', 'ok');
        await viewRules();
      });
      return;
    }

    if (action === 'toggle-user') {
      await withBusy(trigger, async () => {
        const active = trigger.getAttribute('data-active') === 'true';
        await api(`/api/users/${trigger.getAttribute('data-id')}`, { method: 'PATCH', body: { active: !active } });
        await viewAdmin();
      });
      return;
    }

    if (action === 'sync-queue') {
      await withBusy(trigger, async () => {
        const results = await window.Offline.flush(async (entry) => {
          const response = await fetch(entry.path, {
            method: entry.method,
            headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
            body: entry.body ? JSON.stringify(entry.body) : undefined,
          });
          if (!response.ok) throw new Error(`replay failed (${response.status})`);
          return response.json();
        });
        const failed = results.filter((result) => !result.ok).length;
        state.pending = failed;
        renderOnlineState();
        toast(failed ? `${failed} queued action(s) could not be replayed.` : 'All queued actions were replayed.', failed ? 'error' : 'ok');
      });
      return;
    }
  });

  document.addEventListener('input', (event) => {
    const input = event.target.closest('[data-path]');
    if (input) {
      setPath(state.model, input.getAttribute('data-path'), input.value);
      scheduleEvaluate();
      return;
    }

    const searchInput = event.target.closest('#q');
    if (searchInput) {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        const form = $('#search-form');
        viewRepository(Object.fromEntries(new FormData(form)));
      }, 400);
    }
  });

  document.addEventListener('change', async (event) => {
    const input = event.target.closest('[data-path]');
    if (input) {
      setPath(state.model, input.getAttribute('data-path'), input.value);
      scheduleEvaluate();
    }

    if (event.target.id === 'attachment-input') {
      const files = Array.from(event.target.files || []);
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        try {
          // eslint-disable-next-line no-await-in-loop
          await api(`/api/tests/${state.testId}/attachments`, {
            method: 'POST',
            body: { filename: file.name, mimetype: file.type, contentBase64: base64 },
          });
          toast(`${file.name} attached.`, 'ok');
        } catch (error) {
          toast(`${file.name}: ${error.message}`, 'error');
        }
      }
      await reloadTest();
    }
  });

  document.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (event.target.id === 'login-form') {
      const form = new FormData(event.target);
      try {
        const data = await api('/api/auth/login', {
          method: 'POST',
          body: { username: form.get('username'), password: form.get('password') },
        });
        localStorage.setItem('nawi.token', data.token);
        state.token = data.token;
        state.user = data.user;
        await refreshMeta();
        location.hash = location.hash || '#/dashboard';
        router();
      } catch (error) {
        renderLogin(error.message);
      }
      return;
    }

    if (event.target.id === 'search-form') {
      await viewRepository(Object.fromEntries(new FormData(event.target)));
      return;
    }

    if (event.target.id === 'user-form') {
      const body = Object.fromEntries(new FormData(event.target));
      try {
        await api('/api/users', { method: 'POST', body });
        toast(`User ${body.username} created.`, 'ok');
        await viewAdmin();
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }

    if (event.target.id === 'password-form') {
      const body = Object.fromEntries(new FormData(event.target));
      try {
        await api('/api/auth/password', { method: 'POST', body });
        toast('Password updated.', 'ok');
        $('#modal-root').innerHTML = '';
      } catch (error) {
        toast(error.message, 'error');
      }
    }
  });

  window.addEventListener('hashchange', router);

  window.addEventListener('online', async () => {
    state.online = true;
    renderOnlineState();
    if (window.Offline) {
      const results = await window.Offline.flush(async (entry) => {
        const response = await fetch(entry.path, {
          method: entry.method,
          headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
          body: entry.body ? JSON.stringify(entry.body) : undefined,
        });
        if (!response.ok) throw new Error(`replay failed (${response.status})`);
        return response.json();
      });
      const failed = results.filter((result) => !result.ok).length;
      state.pending = failed;
      renderOnlineState();
      if (results.length) toast(`${results.length - failed} queued action(s) replayed automatically.`, failed ? 'error' : 'ok');
    }
  });

  window.addEventListener('offline', () => {
    state.online = false;
    renderOnlineState();
    toast('Connection lost – observations continue to be recorded and queued.', '');
  });

  function renderOnlineState() {
    const sidebarFooter = $('.sidebar .footer');
    if (sidebarFooter) {
      sidebarFooter.innerHTML = `OIML R 76-1:2006 · revision ${esc(state.meta?.rulesRevision || '')}<br />
        ${state.online ? 'Online' : 'Offline – changes are queued'}${state.pending ? ` · ${state.pending} queued` : ''}`;
    }
  }

  function modal(title, html) {
    $('#modal-root').innerHTML = `
      <div class="modal-backdrop" data-action="close-modal">
        <div class="modal" onclick="event.stopPropagation()">
          <h2>${esc(title)}</h2>
          ${html}
        </div>
      </div>`;
  }

  async function reloadTest() {
    if (!state.testId) return renderEditor();
    const data = await api(`/api/tests/${state.testId}`);
    state.test = data.test;
    state.model = toUiModel(data.test);
    state.evaluation = data.evaluation;
    state.validation = data.validation;
    renderEditor();
  }

  async function signOut(redirect) {
    localStorage.removeItem('nawi.token');
    state.token = null;
    state.user = null;
    if (redirect) location.hash = '#/dashboard';
    renderLogin();
  }

  // -------------------------------------------------------------------- start

  async function boot() {
    if (!state.token) return renderLogin();

    try {
      const data = await api('/api/auth/me');
      state.user = data.user;
    } catch {
      return renderLogin();
    }

    await refreshMeta();
    if (window.Offline) {
      try {
        state.pending = (await window.Offline.listQueue()).length;
      } catch {
        state.pending = 0;
      }
    }

    router();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {
        /* offline shell is a progressive enhancement */
      });
    }
  }

  boot();
})();
