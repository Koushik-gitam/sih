// Headless-browser HTML -> PDF renderer.
//
// Used by:
//   * scripts/export-deck.js        (presentation deck)
//   * server/reports/report.js      (OIML R 76-2 test reports)
//
// Requires a Chromium/Chrome binary on the host. If none is available the
// caller can fall back to the printable HTML, so the application never becomes
// unusable because of a missing browser.

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const CANDIDATES = [
  process.env.CHROME_BIN,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  '/snap/bin/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

let cachedBinary;

/** Locate a usable Chromium/Chrome binary, or return null. */
function findChrome() {
  if (cachedBinary !== undefined) return cachedBinary;

  for (const candidate of CANDIDATES) {
    if (candidate.includes(path.sep) || candidate.includes('/') || candidate.endsWith('.exe')) {
      if (fs.existsSync(candidate)) {
        cachedBinary = candidate;
        return cachedBinary;
      }
      continue;
    }
    try {
      const resolved = execFileSync('which', [candidate], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      if (resolved) {
        cachedBinary = resolved;
        return cachedBinary;
      }
    } catch {
      /* keep looking */
    }
  }

  cachedBinary = null;
  return cachedBinary;
}

/**
 * Render an HTML string or file to PDF.
 * @param {{ html?: string, htmlPath?: string, outPath: string, landscape?: boolean, timeoutMs?: number }} options
 * @returns {{ ok: boolean, outPath?: string, bytes?: number, binary?: string, error?: string }}
 */
function htmlToPdf(options) {
  const { html, htmlPath, outPath, timeoutMs = 90000 } = options;
  const binary = findChrome();

  if (!binary) {
    return { ok: false, error: 'No Chromium/Chrome binary found. Set CHROME_BIN to enable PDF export.' };
  }

  let sourcePath = htmlPath;
  let tempFile = null;

  // The staging HTML is written *next to the output*, not in the system temp
  // directory: sandboxed browser builds (Snap, Flatpak, containers) run with
  // their own /tmp namespace and would otherwise render an empty error page.
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });

  if (!sourcePath) {
    if (typeof html !== 'string') {
      return { ok: false, error: 'htmlToPdf requires either `html` or `htmlPath`.' };
    }
    tempFile = path.join(path.dirname(path.resolve(outPath)), `.render-${process.pid}-${Date.now()}.html`);
    fs.writeFileSync(tempFile, html, 'utf8');
    sourcePath = tempFile;
  }

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-dev-shm-usage',
    '--virtual-time-budget=20000',
    '--run-all-compositor-stages-before-draw',
    '--no-pdf-header-footer',
    `--print-to-pdf=${path.resolve(outPath)}`,
    `file://${path.resolve(sourcePath)}`,
  ];

  try {
    const result = spawnSync(binary, args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });

    if (tempFile) fs.rmSync(tempFile, { force: true });

    const exists = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
    if (!exists) {
      return {
        ok: false,
        binary,
        error: (result.stderr || result.stdout || 'Chrome produced no output').toString().slice(0, 800),
      };
    }

    return { ok: true, outPath, bytes: fs.statSync(outPath).size, binary };
  } catch (error) {
    if (tempFile) fs.rmSync(tempFile, { force: true });
    return { ok: false, binary, error: error.message };
  }
}

module.exports = { htmlToPdf, findChrome };
