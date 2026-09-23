// Authentication and role-based access control.
//
// Passwords are stored as scrypt hashes with a per-user salt. Sessions are
// HMAC-SHA256 signed tokens: no session table, no third-party dependency, and
// the signature is verified with a timing-safe comparison.

const crypto = require('crypto');
const fs = require('fs');

const { config } = require('./config');
const { store } = require('./store');

const ROLES = {
  technician: {
    label: 'Laboratory Technician',
    description: 'Records instrument data, environmental conditions and test observations.',
    permissions: [
      'test:create', 'test:update', 'test:read', 'test:submit',
      'report:read', 'dashboard:read', 'rules:read',
    ],
  },
  lab_manager: {
    label: 'Laboratory Manager / Evaluator',
    description: 'Reviews, approves, locks and signs test reports.',
    permissions: [
      'test:create', 'test:update', 'test:read', 'test:submit',
      'test:approve', 'test:lock', 'test:unlock', 'test:delete',
      'report:read', 'report:generate', 'dashboard:read', 'rules:read', 'audit:read',
    ],
  },
  auditor: {
    label: 'Auditor',
    description: 'Read-only access to records, reports and the integrity ledger.',
    permissions: ['test:read', 'report:read', 'dashboard:read', 'rules:read', 'audit:read'],
  },
  admin: {
    label: 'Administrator',
    description: 'Full access, including user administration and rule-schema updates.',
    permissions: ['*'],
  },
};

function permissionsFor(role) {
  return ROLES[role] ? [...ROLES[role].permissions] : [];
}

function can(user, permission) {
  if (!user) return false;
  const permissions = permissionsFor(user.role);
  return permissions.includes('*') || permissions.includes(permission);
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const derived = crypto.scryptSync(String(password), salt, expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });

  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function passwordProblems(password) {
  const problems = [];
  if (typeof password !== 'string' || password.length < 10) problems.push('must be at least 10 characters');
  if (!/[A-Za-z]/.test(password || '')) problems.push('must contain a letter');
  if (!/[0-9]/.test(password || '')) problems.push('must contain a digit');
  return problems;
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

function sessionSecret() {
  if (process.env.SESSION_SECRET) return Buffer.from(process.env.SESSION_SECRET, 'utf8');
  const file = config.sessionSecretFile;
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  const secret = crypto.randomBytes(48);
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  fs.writeFileSync(file, secret.toString('base64'), { mode: 0o600 });
  return secret;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payload) {
  return base64url(crypto.createHmac('sha256', sessionSecret()).update(payload).digest());
}

function issueToken(user) {
  const issuedAt = Date.now();
  const body = {
    sub: user.id,
    username: user.username,
    role: user.role,
    labCode: user.labCode || null,
    iat: issuedAt,
    exp: issuedAt + config.sessionHours * 3600 * 1000,
  };
  const payload = base64url(JSON.stringify(body));
  return { token: `${payload}.${sign(payload)}`, expiresAt: body.exp };
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return { valid: false, error: 'malformed token' };
  const [payload, signature] = token.split('.');
  const expected = sign(payload);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, error: 'bad signature' };

  let body;
  try {
    body = JSON.parse(fromBase64url(payload).toString('utf8'));
  } catch {
    return { valid: false, error: 'unreadable payload' };
  }

  if (!body.exp || body.exp < Date.now()) return { valid: false, error: 'expired' };

  const user = store.getUser(body.sub);
  if (!user || user.active === false) return { valid: false, error: 'unknown or inactive user' };

  return { valid: true, user, claims: body };
}

// ---------------------------------------------------------------------------
// Seeding and user administration
// ---------------------------------------------------------------------------

const DEFAULT_USERS = [
  { username: 'admin', role: 'admin', name: 'System Administrator', password: 'Admin@26035' },
  { username: 'manager', role: 'lab_manager', name: 'Laboratory Manager', password: 'Manager@26035' },
  { username: 'technician', role: 'technician', name: 'Laboratory Technician', password: 'Technician@26035' },
  { username: 'auditor', role: 'auditor', name: 'Internal Auditor', password: 'Auditor@26035' },
];

function seedDefaultUsers() {
  const existing = store.listUsers();
  const created = [];

  DEFAULT_USERS.forEach((definition) => {
    if (existing.some((user) => user.username === definition.username)) return;
    const user = store.createUser({
      username: definition.username,
      name: definition.name,
      role: definition.role,
      passwordHash: hashPassword(definition.password),
      active: true,
      mustChangePassword: true,
      seeded: true,
    });
    created.push({ username: user.username, role: user.role });
  });

  return created;
}

function login(username, password) {
  const user = store.findUserByUsername(username);
  if (!user) return { ok: false, error: 'Invalid username or password' };
  if (user.active === false) return { ok: false, error: 'This account is disabled' };
  if (!verifyPassword(password, user.passwordHash)) return { ok: false, error: 'Invalid username or password' };

  const { token, expiresAt } = issueToken(user);
  store.audit({ actor: { id: user.id, username: user.username, role: user.role }, action: 'auth.login', testId: null });

  return {
    ok: true,
    token,
    expiresAt,
    user: publicUser(user),
  };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    roleLabel: ROLES[user.role] ? ROLES[user.role].label : user.role,
    permissions: permissionsFor(user.role),
    labCode: user.labCode || null,
    active: user.active !== false,
    mustChangePassword: Boolean(user.mustChangePassword),
    createdAt: user.createdAt || null,
    lastLoginAt: user.lastLoginAt || null,
  };
}

module.exports = {
  ROLES,
  DEFAULT_USERS,
  permissionsFor,
  can,
  hashPassword,
  verifyPassword,
  passwordProblems,
  issueToken,
  verifyToken,
  seedDefaultUsers,
  login,
  publicUser,
};
