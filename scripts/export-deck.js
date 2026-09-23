#!/usr/bin/env node
// Export deck/slides.html to a portal-ready PDF.
//
//   npm run deck:pdf            -> out/SIH26035-NAWI-Deck.pdf
//
// The SIH portal requires a PDF under 10 MB; this script reports the size and
// warns if the deck exceeds the limit.

const fs = require('fs');
const path = require('path');

const { htmlToPdf } = require('../server/reports/pdf');

const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'deck', 'slides.html');
const outPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'out', 'SIH26035-NAWI-Deck.pdf');

if (!fs.existsSync(htmlPath)) {
  console.error(`Deck source not found: ${htmlPath}`);
  process.exit(1);
}

const result = htmlToPdf({ htmlPath, outPath });

if (!result.ok) {
  console.error('Deck PDF export failed:', result.error);
  console.error('Tip: set CHROME_BIN=/path/to/chrome and retry.');
  process.exit(1);
}

const sizeMB = result.bytes / (1024 * 1024);
console.log(`Deck exported: ${outPath}`);
console.log(`Size: ${sizeMB.toFixed(2)} MB (${result.bytes} bytes) via ${result.binary}`);
if (sizeMB > 10) {
  console.error('WARNING: portal upload limit is 10 MB - reduce embedded images.');
  process.exit(2);
}
console.log('Portal check: under the 10 MB limit.');
