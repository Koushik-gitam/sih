// OIML R 76-2 style test report renderer (HTML).
//
// One template produces the printable report. It is rendered to PDF by the
// headless browser and is also returned as HTML so the laboratory can print it
// from any workstation without the server.
//
// Layout follows the OIML R 76-2 pattern evaluation report structure:
//   1 General information   2 Instrument data      3 Test conditions
//   4 Test summary          5 Detailed results     6 Compliance statement
//   7 Attachments / signatures / integrity

const { decimalsForStep } = require('../engine/units');

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(value, decimals = 2) {
  if (value === null || value === undefined || value === '') return '&ndash;';
  if (typeof value !== 'number' || !Number.isFinite(value)) return escapeHtml(value);
  const places = value === 0 ? 0 : decimals;
  return value.toFixed(places).replace(/\.?0+$/, (match) => (match.includes('.') ? '' : match));
}

function verdictBadge(status) {
  const map = {
    pass: ['PASS', 'ok'],
    fail: ['FAIL', 'bad'],
    incomplete: ['INCOMPLETE', 'warn'],
    not_tested: ['NOT TESTED', 'muted'],
  };
  const [label, tone] = map[status] || [String(status || '').toUpperCase(), 'muted'];
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function verdictText(verdict) {
  const map = {
    pass: 'CONFORMING - the instrument complies with the metrological requirements tested.',
    fail: 'NOT CONFORMING - at least one requirement was exceeded.',
    invalid: 'INCOMPLETE RECORD - input validation failed, no compliance claim is made.',
    incomplete: 'INCOMPLETE - no test observations were recorded.',
  };
  return map[verdict] || 'Verdict not available.';
}

function detailTable(point, unit, e) {
  const decimals = Math.min(9, decimalsForStep(e) + 2);
  return `
    <table class="grid">
      <thead>
        <tr>
          <th>Load L</th><th>Indication I</th><th>&Delta;L</th>
          <th>P = I + 0.5e &minus; &Delta;L</th><th>E = P &minus; L</th><th>E<sub>c</sub> = E &minus; E<sub>0</sub></th>
          <th>E<sub>c</sub> / e</th><th>MPE</th><th>MPE in e</th><th>Margin (e)</th><th>Result</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${fmt(point.load, decimals)} ${escapeHtml(unit)}</td>
          <td>${fmt(point.indication, decimals)}</td>
          <td>${fmt(point.additionalLoad, decimals)}</td>
          <td>${fmt(point.preRoundingIndication, decimals)}</td>
          <td>${fmt(point.error, decimals)}</td>
          <td class="${point.pass ? 'good' : 'bad'}"><b>${fmt(point.correctedError, decimals)}</b></td>
          <td>${fmt(point.errorInE, 3)}</td>
          <td>${fmt(point.mpe, decimals)}</td>
          <td>&plusmn;${fmt(point.mpeInE, 2)} e</td>
          <td>${fmt(point.marginInE, 3)}</td>
          <td>${verdictBadge(point.pass ? 'pass' : 'fail')}</td>
        </tr>
      </tbody>
    </table>`;
}

function repeatabilityTable(point, unit, e) {
  const decimals = Math.min(9, decimalsForStep(e) + 2);
  return `
    <table class="grid">
      <thead>
        <tr><th>Load</th><th>Readings</th><th>Mean</th><th>Range</th><th>Range / e</th><th>Std. deviation &sigma;</th><th>MPE</th><th>Result</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>${fmt(point.load, decimals)} ${escapeHtml(unit)}</td>
          <td>${(point.readings || []).map((reading) => fmt(reading, decimals)).join(', ')}</td>
          <td>${fmt(point.mean, decimals)}</td>
          <td><b>${fmt(point.range, decimals)}</b></td>
          <td>${fmt(point.rangeInE, 3)}</td>
          <td>${fmt(point.standardDeviation, decimals)}</td>
          <td>${fmt(point.mpe, decimals)} (&plusmn;${fmt(point.mpeInE, 2)} e)</td>
          <td>${verdictBadge(point.pass ? 'pass' : 'fail')}</td>
        </tr>
      </tbody>
    </table>`;
}

function eccentricityTable(module, unit, e) {
  const decimals = Math.min(9, decimalsForStep(e) + 2);
  return `
    <table class="grid">
      <thead>
        <tr><th>Position</th><th>Indication</th><th>&Delta;L</th><th>E<sub>c</sub></th><th>Difference from centre</th><th>Compared / e</th><th>MPE</th><th>Result</th></tr>
      </thead>
      <tbody>
        ${module.points
          .map(
            (point) => `<tr>
          <td>${escapeHtml(point.label)}</td>
          <td>${fmt(point.indication, decimals)}</td>
          <td>${fmt(point.additionalLoad, decimals)}</td>
          <td>${fmt(point.correctedError, decimals)}</td>
          <td><b>${point.differenceFromCentre === null ? '&ndash;' : fmt(point.differenceFromCentre, decimals)}</b></td>
          <td>${fmt(point.comparedValueInE, 3)}</td>
          <td>${fmt(point.mpe, decimals)} (&plusmn;${fmt(point.mpeInE, 2)} e)</td>
          <td>${verdictBadge(point.pass ? 'pass' : 'fail')}</td>
        </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
}

function checksTable(checks, unit) {
  if (!checks || !checks.length) return '';
  return `
    <table class="grid">
      <thead><tr><th>Check</th><th>Requirement</th><th>Recorded</th><th>Limit</th><th>Result</th></tr></thead>
      <tbody>
        ${checks
          .map(
            (check) => `<tr>
          <td>${escapeHtml(check.label)}</td>
          <td class="clause">${escapeHtml(check.criterion)}</td>
          <td>${fmt(check.value, 4)}${check.valueInE !== undefined && check.valueInE !== null ? ` (${fmt(check.valueInE, 3)} e)` : ''}</td>
          <td>${fmt(check.limit, 4)} ${check.unit && check.unit !== '× Unom' ? escapeHtml(unit || '') : escapeHtml(check.unit || '')}</td>
          <td>${verdictBadge(check.pass ? 'pass' : 'fail')}</td>
        </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
}

function moduleSection(module, unit, e) {
  const isRepeatability = module.moduleId === 'repeatability_test';
  const isEccentricity = module.moduleId === 'eccentricity_test';

  let table = '';
  if (isRepeatability) {
    table = module.points.map((point) => repeatabilityTable(point, unit, e)).join('');
  } else if (isEccentricity) {
    table = eccentricityTable(module, unit, e);
  } else if (module.points.length) {
    table = module.points.map((point) => detailTable(point, unit, e)).join('');
  }

  return `
    <section class="module">
      <h3>${escapeHtml(module.title)} <span class="clause">OIML R 76-1 ${escapeHtml(module.clause)}</span> ${verdictBadge(module.status)}</h3>
      ${module.note ? `<p class="note">${escapeHtml(module.note)}</p>` : ''}
      ${module.criterion ? `<p class="note">Criterion: ${escapeHtml(module.criterion)}</p>` : ''}
      ${checksTable(module.checks, unit)}
      ${table}
      ${
        module.status === 'not_tested'
          ? '<p class="note">No observations were recorded for this module; it is not covered by this report.</p>'
          : ''
      }
    </section>`;
}

/**
 * Render the full report.
 * @param {object} evaluation  result of engine/evaluate.js::evaluateTest
 * @param {object} [options]   { generatedAt, reportNumber, attachments, signatures }
 */
function renderReport(evaluation, options = {}) {
  const instrument = evaluation.instrument || {};
  const unit = instrument.unit || 'g';
  const e = Number(instrument.e) || 1;
  const laboratory = evaluation.laboratory || {};
  const environmental = evaluation.environmental || {};
  const generatedAt = options.generatedAt || new Date().toISOString();
  const attachments = options.attachments || [];
  const signatures = options.signatures || [];
  const rules = evaluation.ruleView;

  const testDate = environmental.testDate ? new Date(environmental.testDate) : null;
  const instrumentRows = [
    ['Manufacturer', instrument.manufacturer],
    ['Model / type designation', instrument.model],
    ['Serial number', instrument.serialNumber],
    ['Accuracy class', `Class ${instrument.accuracyClass || ''} (${instrument.classTitle || ''})`],
    ['Maximum capacity (Max)', `${instrument.maxCapacity} ${unit}`],
    ['Minimum capacity (Min)', `${instrument.minCapacity} ${unit}`],
    ['Verification scale interval (e)', `${instrument.e} ${unit}`],
    ['Actual scale interval (d)', `${instrument.d} ${unit}`],
    ['Number of intervals (n = Max / e)', evaluation.classification?.intervals ?? '&ndash;'],
    ['Working temperature range', instrument.temperatureRange ? `${instrument.temperatureRange.min} to ${instrument.temperatureRange.max} °C` : '&ndash;'],
    ['Load receptor support points', instrument.loadReceptorSupportPoints ?? '&ndash;'],
    ['Nominal voltage', instrument.nominalVoltage ? `${instrument.nominalVoltage} V` : '&ndash;'],
    ['Instrument type', instrument.instrumentType ? String(instrument.instrumentType).replace(/_/g, ' ') : '&ndash;'],
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(evaluation.reportNumber || options.reportNumber || 'Test report')} - OIML R 76 test report</title>
<style>
  @page { size: A4; margin: 16mm 14mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: "Inter", "Segoe UI", Roboto, Arial, sans-serif; color: #0f172a; font-size: 10.5pt; line-height: 1.45; margin: 0; }
  header { border-bottom: 3px solid #0a192f; padding-bottom: 10px; margin-bottom: 14px; }
  .org { font-size: 9.5pt; letter-spacing: .14em; text-transform: uppercase; color: #64748b; }
  h1 { font-size: 17pt; margin: 4px 0 2px; color: #0a192f; }
  .subtitle { color: #475569; font-size: 10pt; }
  .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 2px 18px; margin-top: 8px; font-size: 9.5pt; }
  .meta div { display: flex; gap: 6px; }
  .meta b { color: #475569; font-weight: 600; min-width: 112px; }
  h2 { font-size: 12pt; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #cbd5e1; color: #0a192f; }
  h3 { font-size: 10.5pt; margin: 14px 0 5px; color: #0a192f; }
  .clause { font-weight: 400; color: #64748b; font-size: 8.5pt; }
  table { width: 100%; border-collapse: collapse; margin-top: 5px; }
  table.grid th { background: #0a192f; color: #fff; font-size: 8.5pt; text-align: left; padding: 4px 5px; font-weight: 600; }
  table.grid td { border-bottom: 1px solid #e2e8f0; padding: 4px 5px; font-size: 9.5pt; }
  table.grid tr:nth-child(even) td { background: #f8fafc; }
  table.kv td { padding: 3px 6px; border-bottom: 1px solid #eef2f7; font-size: 10pt; }
  table.kv td:first-child { color: #475569; width: 34%; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 8pt; font-weight: 700; letter-spacing: .04em; }
  .badge.ok { background: #d1fae5; color: #065f46; }
  .badge.bad { background: #fee2e2; color: #991b1b; }
  .badge.warn { background: #fef3c7; color: #92400e; }
  .badge.muted { background: #e2e8f0; color: #475569; }
  .good { color: #047857; }
  .bad { color: #b91c1c; }
  .note { color: #475569; font-size: 9pt; margin: 3px 0; }
  .verdict { border: 2px solid #0a192f; border-radius: 8px; padding: 10px 12px; margin-top: 10px; background: #f8fafc; }
  .verdict .verdict-label { font-size: 13pt; font-weight: 800; letter-spacing: .04em; }
  .verdict.pass { border-color: #059669; }
  .verdict.fail { border-color: #dc2626; }
  .verdict.invalid, .verdict.incomplete { border-color: #d97706; }
  .findings { margin: 6px 0 0 16px; padding: 0; font-size: 9.5pt; }
  .findings li { margin-bottom: 2px; }
  .hash { font-family: "Consolas", "SFMono-Regular", monospace; font-size: 8pt; word-break: break-all; }
  .sig-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin-top: 8px; }
  .sig-box { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 10px; min-height: 74px; }
  .sig-box .role { font-size: 9pt; font-weight: 700; color: #0a192f; }
  .sig-box .line { margin-top: 26px; border-top: 1px solid #94a3b8; padding-top: 3px; font-size: 8.5pt; color: #475569; }
  footer { margin-top: 18px; border-top: 1px solid #cbd5e1; padding-top: 6px; font-size: 8pt; color: #64748b; }
  .page-break { page-break-before: always; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
</style>
</head>
<body>

<header>
  <div class="org">${escapeHtml(laboratory.name || 'Designated testing laboratory')} &middot; Legal Metrology &middot; Government of India</div>
  <h1>Test Report - Non-Automatic Weighing Instrument</h1>
  <div class="subtitle">Pattern evaluation as per OIML R 76-1:2006, reported in the format of OIML R 76-2</div>
  <div class="meta">
    <div><b>Report number</b><span>${escapeHtml(evaluation.reportNumber || options.reportNumber || 'DRAFT')}</span></div>
    <div><b>Test date</b><span>${testDate && !Number.isNaN(testDate.valueOf()) ? escapeHtml(testDate.toISOString().slice(0, 10)) : '&ndash;'}</span></div>
    <div><b>Laboratory code</b><span>${escapeHtml(laboratory.labCode || '&ndash;')}</span></div>
    <div><b>Tested by</b><span>${escapeHtml(environmental.testedBy || '&ndash;')}</span></div>
    <div><b>Standard applied</b><span>${escapeHtml(evaluation.standard || 'OIML R 76-1:2006')}</span></div>
    <div><b>Rule schema revision</b><span>${escapeHtml(evaluation.rulesRevision || '&ndash;')}</span></div>
  </div>
</header>

<h2>1. General information</h2>
<table class="kv">
  <tr><td>Laboratory</td><td>${escapeHtml(laboratory.name || '&ndash;')}</td></tr>
  <tr><td>Laboratory address</td><td>${escapeHtml(laboratory.address || '&ndash;')}</td></tr>
  <tr><td>Applicant / manufacturer</td><td>${escapeHtml(instrument.manufacturer || '&ndash;')}</td></tr>
  <tr><td>Model approval reference</td><td>${escapeHtml(instrument.modelApprovalReference || '&ndash;')}</td></tr>
  <tr><td>Instrument type</td><td>${escapeHtml(String(instrument.instrumentType || 'non-automatic weighing instrument').replace(/_/g, ' '))}</td></tr>
</table>

<h2>2. Instrument data and technical characteristics</h2>
<table class="kv">
  ${instrumentRows
    .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${formatValue(value)}</td></tr>`)
    .join('')}
</table>

<h2>3. Test conditions</h2>
<div class="two-col">
  <table class="kv">
    <tr><td>Ambient temperature</td><td>${fmt(environmental.ambientTemperatureCelsius, 1)} °C</td></tr>
    <tr><td>Relative humidity</td><td>${fmt(environmental.relativeHumidityPercent, 1)} %</td></tr>
    <tr><td>Barometric pressure</td><td>${fmt(environmental.barometricPressureKpa, 1)} kPa</td></tr>
  </table>
  <table class="kv">
    <tr><td>Test standard weights</td><td>${escapeHtml(environmental.standardWeights || '&ndash;')}</td></tr>
    <tr><td>Weights traceability</td><td>${escapeHtml(environmental.weightsTraceability || '&ndash;')}</td></tr>
    <tr><td>In-service testing</td><td>${evaluation.summary?.inService ? 'Yes (MPE doubled per 3.5.2)' : 'No (initial verification MPE)'}</td></tr>
  </table>
</div>

<h2>4. Maximum permissible errors applied</h2>
<p class="note">Class ${escapeHtml(rules?.className || instrument.accuracyClass || '')} (${escapeHtml(rules?.classTitle || '')}), load m expressed in verification scale intervals e = ${fmt(e, 6)} ${escapeHtml(unit)}.</p>
<table class="grid">
  <thead><tr><th>Load range (in e)</th><th>MPE</th><th>MPE in ${escapeHtml(unit)}</th></tr></thead>
  <tbody>
    ${(rules?.mpeTable || [])
      .map(
        (row, index, all) => `<tr>
      <td>${index === 0 ? '0 &le; m &le; ' : `${all[index - 1].upToInE} &lt; m &le; `}${row.upToInE === null ? 'unbounded' : row.upToInE}</td>
      <td>&plusmn; ${fmt(row.mpeInE, 2)} e</td>
      <td>&plusmn; ${fmt(row.mpe, 6)}</td>
    </tr>`,
      )
      .join('')}
  </tbody>
</table>

<h2>5. Summary of test results</h2>
<table class="grid">
  <thead><tr><th>Test module</th><th>Clause</th><th>Observations</th><th>Failed</th><th>Result</th></tr></thead>
  <tbody>
    ${evaluation.modules
      .map(
        (module) => `<tr>
      <td>${escapeHtml(module.title)}</td>
      <td class="clause">${escapeHtml(module.clause)}</td>
      <td>${module.points.length + (module.checks || []).length}</td>
      <td>${module.failedPoints + (module.failedChecks || 0)}</td>
      <td>${verdictBadge(module.status)}</td>
    </tr>`,
      )
      .join('')}
  </tbody>
</table>

<h2 class="page-break">6. Detailed test results</h2>
${evaluation.modules
  .filter((module) => module.status !== 'not_tested')
  .map((module) => moduleSection(module, unit, e))
  .join('')}

<h2>7. Compliance statement</h2>
<div class="verdict ${escapeHtml(evaluation.summary.verdict)}">
  <div class="verdict-label">${escapeHtml(String(evaluation.summary.verdict).toUpperCase())}</div>
  <div>${escapeHtml(verdictText(evaluation.summary.verdict))}</div>
  <ul class="findings">
    <li>Modules tested: ${evaluation.summary.modulesTested}; passed: ${evaluation.summary.modulesPassed}; failed: ${evaluation.summary.modulesFailed}; not tested: ${evaluation.summary.modulesNotTested}.</li>
    <li>Load points evaluated: ${evaluation.summary.pointsEvaluated}; outside tolerance: ${evaluation.summary.pointsFailed}; failed checks: ${evaluation.summary.checksFailed}.</li>
    <li>Coverage: ${
      evaluation.summary.coverageComplete
        ? 'all expected modules recorded.'
        : `missing ${evaluation.summary.expectedModulesMissing
            .map((moduleId) => escapeHtml(moduleId.replace(/_/g, ' ')))
            .join(', ')}.`
    }</li>
    ${
      evaluation.validation.warnings.length
        ? `<li>Warnings recorded during input validation: ${evaluation.validation.warnings.length} (see attached validation log).</li>`
        : ''
    }
  </ul>
</div>

${
  evaluation.validation.errors.length
    ? `<h3>Input validation findings (blocking)</h3>
       <ul class="findings">
         ${evaluation.validation.errors
           .slice(0, 40)
           .map((error) => `<li><b>${escapeHtml(error.field)}</b> - ${escapeHtml(error.message)}</li>`)
           .join('')}
       </ul>`
    : ''
}

<h2>8. Attachments, signatures and integrity</h2>
<h3>Attachments</h3>
${
  attachments.length
    ? `<table class="grid">
        <thead><tr><th>File</th><th>Type</th><th>Size</th><th>SHA-256</th><th>Attached</th></tr></thead>
        <tbody>
          ${attachments
            .map(
              (file) => `<tr>
            <td>${escapeHtml(file.filename)}</td>
            <td>${escapeHtml(file.mimetype || '')}</td>
            <td>${fmt((file.size || 0) / 1024, 1)} kB</td>
            <td class="hash">${escapeHtml(String(file.sha256 || '').slice(0, 32))}&hellip;</td>
            <td>${escapeHtml(String(file.uploadedAt || '').slice(0, 10))}</td>
          </tr>`,
            )
            .join('')}
        </tbody>
      </table>`
    : '<p class="note">No photographs or supporting documents are attached to this report.</p>'
}

<div class="sig-grid">
  <div class="sig-box">
    <div class="role">Tested by - Laboratory Technician</div>
    ${
      signatures.find((signature) => signature.meaning === 'tested')
        ? `<div>${escapeHtml(signatures.find((signature) => signature.meaning === 'tested').name)}<br><span class="clause">${escapeHtml(String(signatures.find((signature) => signature.meaning === 'tested').at).slice(0, 19).replace('T', ' '))}</span></div>`
        : '<div class="line">Signature</div>'
    }
  </div>
  <div class="sig-box">
    <div class="role">Approved by - Laboratory Manager / Evaluator</div>
    ${
      signatures.find((signature) => signature.meaning === 'approved')
        ? `<div>${escapeHtml(signatures.find((signature) => signature.meaning === 'approved').name)}<br><span class="clause">${escapeHtml(String(signatures.find((signature) => signature.meaning === 'approved').at).slice(0, 19).replace('T', ' '))}</span></div>`
        : '<div class="line">Signature</div>'
    }
  </div>
</div>

<h3>Integrity</h3>
<table class="kv">
  <tr><td>Record integrity hash (SHA-256)</td><td class="hash">${escapeHtml(evaluation.integrityHash || '')}</td></tr>
  <tr><td>Rule schema</td><td>${escapeHtml(evaluation.standard || '')} - revision ${escapeHtml(evaluation.rulesRevision || '')}</td></tr>
  <tr><td>Report generated</td><td>${escapeHtml(generatedAt)}</td></tr>
</table>
<p class="note">The integrity hash is computed over the instrument data, the recorded environmental conditions and every observation in this report. Any subsequent change to the record changes the hash, so a copy can be verified against the repository at any time.</p>

<footer>
  ${escapeHtml(evaluation.reportNumber || options.reportNumber || 'DRAFT')} &middot; generated by the NAWI Test Report System for SIH 26035 &middot; hash ${escapeHtml(String(evaluation.integrityHash || '').slice(0, 16))}&hellip;
</footer>

</body>
</html>`;
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '&ndash;';
  if (typeof value === 'number') return fmt(value, 6);
  return escapeHtml(value);
}

module.exports = { renderReport, escapeHtml, fmt, verdictBadge, verdictText };
