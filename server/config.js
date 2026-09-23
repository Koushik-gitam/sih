// Runtime configuration.
//
// Storage is file based by default so the application runs on a laboratory
// laptop with zero infrastructure. The repository interface in store.js is the
// only place that touches storage, so swapping in PostgreSQL later means
// reimplementing that one module.

const path = require('path');
const fs = require('fs');

require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');

const config = {
  root: ROOT,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  env: process.env.NODE_ENV || 'development',

  dataDir: process.env.NAWI_DATA_DIR ? path.resolve(process.env.NAWI_DATA_DIR) : path.join(ROOT, 'data'),
  rulesPath: process.env.NAWI_RULES_PATH ? path.resolve(process.env.NAWI_RULES_PATH) : path.join(ROOT, 'rules', 'oiml-r76.json'),
  sessionSecretFile: process.env.NAWI_SECRET_FILE
    ? path.resolve(process.env.NAWI_SECRET_FILE)
    : path.join(ROOT, 'data', 'session.secret'),

  sessionHours: Number(process.env.SESSION_HOURS || 12),
  maxUploadBytes: Number(process.env.NAWI_MAX_UPLOAD_BYTES || 8 * 1024 * 1024),
  generatedDir: null,
  uploadsDir: null,
};

config.generatedDir = path.join(config.dataDir, 'generated');
config.uploadsDir = path.join(config.dataDir, 'uploads');

function ensureDirs() {
  [config.dataDir, config.generatedDir, config.uploadsDir].forEach((directory) => {
    fs.mkdirSync(directory, { recursive: true });
  });
}

module.exports = { config, ensureDirs };
