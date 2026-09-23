// Report artefact generation.
//
// Produces, from one evaluation object:
//   * a printable HTML report (always available, no browser required)
//   * a PDF rendered by a headless Chromium, when one is installed
//   * an editable .docx for the review stage
//
// Every artefact is hashed so it can be verified later against the repository.

const fs = require('fs');
const path = require('path');

const { config } = require('../config');
const { sha256, slug, nowIso } = require('../util');
const { renderReport } = require('./document');
const { buildReportDocx } = require('./docx');
const { htmlToPdf, findChrome } = require('./pdf');

function fileBase(evaluation, test) {
  const reportNumber = evaluation.reportNumber || test?.reportNumber || test?.id || 'report';
  return slug(String(reportNumber).replace(/\//g, '-'), 'report');
}

/**
 * @param {object} evaluation  from engine/evaluate.js
 * @param {object} [options]   { test, formats: ['pdf','docx'], attachments, signatures }
 * @returns {Promise<{artifacts: Array, errors: Array, integrityHash: string, rulesRevision: string}>}
 */
async function generateReportArtifacts(evaluation, options = {}) {
  const {
    test = null,
    formats = ['pdf', 'docx'],
    attachments = test?.attachments || [],
    signatures = test?.signatures || [],
  } = options;

  fs.mkdirSync(config.generatedDir, { recursive: true });

  const generatedAt = nowIso();
  const base = `${fileBase(evaluation, test)}-${generatedAt.replace(/[:.]/g, '-')}`;
  const artifacts = [];
  const errors = [];

  const html = renderReport(evaluation, {
    generatedAt,
    reportNumber: evaluation.reportNumber || test?.reportNumber,
    attachments,
    signatures,
  });

  // The printable HTML is always produced: it is the fallback when no headless
  // browser is available, and it is what the browser view uses.
  const htmlPath = path.join(config.generatedDir, `${base}.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');
  artifacts.push({
    format: 'html',
    filename: path.basename(htmlPath),
    path: htmlPath,
    bytes: fs.statSync(htmlPath).size,
    sha256: sha256(html),
    generatedAt,
  });

  if (formats.includes('pdf')) {
    const pdfPath = path.join(config.generatedDir, `${base}.pdf`);
    const result = htmlToPdf({ html, outPath: pdfPath });
    if (result.ok) {
      artifacts.push({
        format: 'pdf',
        filename: path.basename(pdfPath),
        path: pdfPath,
        bytes: result.bytes,
        sha256: sha256(fs.readFileSync(pdfPath)),
        generatedAt,
      });
    } else {
      errors.push({ format: 'pdf', error: result.error });
    }
  }

  if (formats.includes('docx')) {
    try {
      const buffer = await buildReportDocx(evaluation, { generatedAt, attachments, signatures });
      const docxPath = path.join(config.generatedDir, `${base}.docx`);
      fs.writeFileSync(docxPath, buffer);
      artifacts.push({
        format: 'docx',
        filename: path.basename(docxPath),
        path: docxPath,
        bytes: buffer.length,
        sha256: sha256(buffer),
        generatedAt,
      });
    } catch (error) {
      errors.push({ format: 'docx', error: error.message });
    }
  }

  return {
    artifacts,
    errors,
    integrityHash: evaluation.integrityHash,
    rulesRevision: evaluation.rulesRevision,
    pdfAvailable: Boolean(findChrome()),
  };
}

/** Find a previously generated artefact inside the generated directory. */
function resolveArtifact(filename) {
  const safe = path.basename(String(filename || ''));
  const full = path.join(config.generatedDir, safe);
  if (!full.startsWith(config.generatedDir)) return null;
  return fs.existsSync(full) ? full : null;
}

module.exports = { generateReportArtifacts, resolveArtifact, renderReport, findChrome };
