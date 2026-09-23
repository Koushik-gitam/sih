// Small shared helpers.

const crypto = require('crypto');

/**
 * Deterministic JSON serialisation (keys sorted recursively) so that a hash
 * computed now still matches a hash computed after a round trip through disk or
 * the network.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** SHA-256 hex digest of any JSON-serialisable value (or of a string/Buffer). */
function sha256(value) {
  const input = Buffer.isBuffer(value) || typeof value === 'string' ? value : stableStringify(value);
  return crypto.createHash('sha256').update(input).digest('hex');
}

function sha256File(filePath) {
  return sha256(require('fs').readFileSync(filePath));
}

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

/** Filesystem-safe slug for report file names. */
function slug(text, fallback = 'record') {
  const value = String(text || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return value || fallback;
}

/** Parse a number, returning `fallback` when it is not finite. */
function toNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Keep only the listed keys of an object, dropping empty values. */
function pick(object = {}, keys = []) {
  return keys.reduce((result, key) => {
    if (object[key] !== undefined) result[key] = object[key];
    return result;
  }, {});
}

module.exports = { stableStringify, sha256, sha256File, uuid, nowIso, slug, toNumber, pick };
