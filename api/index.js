// Vercel serverless entry point.
//
// The laboratory build assumes a machine with a real disk: the report
// repository, uploaded photographs and generated documents persist between
// requests. A Vercel function is different - its bundle is read-only, and only
// /tmp is writable (per instance, for the life of that instance). So this entry
// point redirects every mutable path into a writable runtime directory and
// seeds the demonstration repository whenever it finds that directory empty.
//
// What that means in practice, stated plainly:
//   * records created through a Vercel deployment are ephemeral - they vanish
//     when the instance is recycled, and two instances do not share them;
//   * PDF rendering needs a Chromium binary, which the serverless runtime does
//     not provide, so report export falls back to editable Word and the
//     printable HTML view;
//   * the laboratory build that runs on a machine with a real disk stores
//     everything durably, which is what a live DoCA trial would use.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolve the runtime directory before anything else reads configuration,
// because server/config.js resolves its paths at require time.
const runtimeDir = process.env.NAWI_DATA_DIR || path.join(os.tmpdir(), 'nawi-runtime');
fs.mkdirSync(runtimeDir, { recursive: true });

// The schema is `require`d rather than copied so that the serverless bundler
// traces it into the deployment, then written where the engine can read it.
const runtimeRules = path.join(runtimeDir, 'oiml-r76.json');
if (!fs.existsSync(runtimeRules)) {
  fs.writeFileSync(runtimeRules, JSON.stringify(require('../rules/oiml-r76.json'), null, 2), 'utf8');
}

process.env.NAWI_DATA_DIR = runtimeDir;
process.env.NAWI_RULES_PATH = process.env.NAWI_RULES_PATH || runtimeRules;
process.env.NAWI_SECRET_FILE = process.env.NAWI_SECRET_FILE || path.join(runtimeDir, 'session.secret');

const { app } = require('../server/index');
const { ensureDirs, config } = require('../server/config');
const auth = require('../server/auth');
const { store } = require('../server/store');
const { seedDemo } = require('../scripts/seed-demo');

let bootstrapped = false;

function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;

  ensureDirs();
  const createdUsers = auth.seedDefaultUsers();

  let seeded = { created: 0 };
  if (store.listTests().length === 0) {
    seeded = seedDemo({ quiet: true });
  }

  console.log(
    `NAWI runtime ready - data ${config.dataDir}; seeded ${createdUsers.length} user(s) and ${seeded.created} demo record(s)`,
  );
}

bootstrap();

module.exports = app;
