#!/usr/bin/env node
/* eslint-disable no-console */
//
// Convert the generated PowerPoint deck to PDF with LibreOffice, so the file
// uploaded to the SIH portal is byte-for-byte the same deck as the .pptx.
//
//   npm run deck:ppt-pdf     ->  out/SIH26035-NAWI-Deck.pdf
//
// LibreOffice is required for this step; the PPTX itself is produced by
// scripts/build-pptx.js and needs nothing but Node.

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'out');
const pptxPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(outDir, 'SIH26035-NAWI-Deck.pptx');
const pdfPath = pptxPath.replace(/\.pptx$/i, '.pdf');

function findSoffice() {
  for (const candidate of ['soffice', 'libreoffice', '/usr/bin/soffice', '/usr/bin/libreoffice']) {
    if (candidate.startsWith('/')) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    try {
      const resolved = execFileSync('which', [candidate], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (resolved) return resolved;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

if (!fs.existsSync(pptxPath)) {
  console.error(`Deck not found: ${pptxPath}`);
  console.error('Run "npm run deck:pptx" first.');
  process.exit(1);
}

const soffice = findSoffice();
if (!soffice) {
  console.error('LibreOffice was not found. Open the .pptx in PowerPoint, Google Slides');
  console.error('or LibreOffice and export to PDF manually, then check it is under 10 MB.');
  process.exit(1);
}

// LibreOffice writes <name>.pdf into --outdir, so converting in place refreshes
// the PDF next to the PPTX.
const result = spawnSync(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, pptxPath], {
  encoding: 'utf8',
  timeout: 180000,
});

if (!fs.existsSync(pdfPath)) {
  console.error('Conversion failed:', (result.stderr || result.stdout || '').toString().slice(0, 600));
  process.exit(1);
}

const sizeMB = fs.statSync(pdfPath).size / (1024 * 1024);
console.log(`Deck PDF written: ${pdfPath}`);
console.log(`Size: ${sizeMB.toFixed(2)} MB${sizeMB > 10 ? '  <- OVER the 10 MB portal limit' : '  (under the 10 MB portal limit)'}`);

if (sizeMB > 10) process.exit(2);
