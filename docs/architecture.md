# Software architecture

## 1. Design goals

1. **Deterministic correctness first.** A metrology report is evidence. The calculation core is a set
   of pure functions with no I/O, unit tested against the published tables, and it is the only place
   that decides compliance.
2. **Runs where the work happens.** A weighbridge never leaves its site. The application is a
   progressive web app that installs on a laboratory laptop or a field tablet, computes locally and
   queues writes while offline.
3. **Rules are data.** Every limit that can change when OIML R 76 or the Legal Metrology (General)
   Rules are revised lives in a versioned JSON schema, not in code.
4. **Nothing is silently altered.** Records carry an integrity hash, the audit ledger is hash
   chained, and an approved record is locked until a manager unlocks it with a written justification.
5. **Deployable on a laboratory scale.** No external services, no build step, and a file-backed
   repository so a single laptop or a small server is a complete installation.

## 2. Layers

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Client — progressive web app (public/)                                        │
│   dashboard · test editor with live verdicts · repository · report viewer     │
│   offline: IndexedDB draft store + replay queue + service-worker app shell    │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │ HTTPS/JSON, Bearer session token
┌───────────────────────────────▼───────────────────────────────────────────────┐
│ Application layer — Express (server/index.js)                                 │
│   authentication and RBAC middleware · REST resources · workflow transitions   │
└──────┬─────────────────────┬───────────────────────────┬──────────────────────┘
       │                     │                           │
┌──────▼──────────┐  ┌───────▼───────────────┐  ┌────────▼─────────────────────┐
│ Engine          │  │ Repository            │  │ Report layer                 │
│ engine/rules    │  │ store.js              │  │ reports/document (HTML)      │
│ engine/metrology│  │  tests · users ·      │  │ reports/pdf (Chromium)       │
│ engine/validate │  │  report artefacts ·   │  │ reports/docx (Word)          │
│ engine/evaluate │  │  hash-chained audit   │  │ reports/report (artefacts +  │
│ engine/planning │  │ engine/units          │  │  SHA-256)                    │
└─────────────────┘  └───────────────────────┘  └──────────────────────────────┘
```

Requests flow strictly downwards; the engine never reaches into storage and the storage layer never
decides compliance. Swapping the file-backed repository for PostgreSQL means reimplementing the
exported functions of `store.js` and nothing else.

## 3. Request flows

**Recording a test**

```
technician types an observation
   → app.js updates the UI model and calls POST /api/evaluate (debounced)
   → engine validates the whole record, evaluates every module, returns per-point verdicts
   → UI marks each row PASS/FAIL and each module dot without re-rendering the inputs
   → PATCH /api/tests/:id persists; history and audit entries are appended
```

**Producing a report**

```
manager presses Generate
   → POST-less workflow: GET /api/tests/:id/report?format=pdf,docx
   → evaluate → same evaluation object
   → renderReport()  → printable HTML (always)
   → htmlToPdf()     → PDF via headless Chromium, staged file written next to the output
   → buildReportDocx() → editable Word document
   → each artefact hashed with SHA-256 and listed in the audit ledger
   → GET /api/reports/:filename streams it back with the session token
```

**Approval**

```
submit   → validation must be clean, verdict recorded, 'tested' signature appended
approve  → manager only, blocked on verdict invalid/incomplete/fail
         → 'approved' signature appended, record locked
unlock   → manager only, ≥ 8 character justification required
         → current state snapshotted into revisions[], status returns to submitted
```

## 4. Storage model

| Collection | Contents |
|---|---|
| `data/users.json` | Accounts: id, username, name, role, lab code, scrypt password hash, flags |
| `data/tests.json` | Test records: instrument, laboratory, environmental, modules, history, signatures, revisions, attachments metadata, last evaluation |
| `data/audit.json` | Append-only ledger: actor, action, record id, details, previous hash, hash |
| `data/generated/` | Rendered report artefacts (HTML, PDF, DOCX) with their hashes |
| `data/uploads/<testId>/` | Attached photographs and supporting documents |
| `data/session.secret` | 48-byte secret for session token signatures (created on first start, mode 600) |

Collections are JSON documents written atomically (temp file + `rename`) with an mtime-validated read
cache. The audit ledger is hash chained:

```
entry.hash = SHA-256( { seq, at, prevHash, actor, action, testId, details } )
```

`verifyAuditChain()` recomputes the chain and reports the first entry that fails to link or fails to
match its own hash, so deleting or editing history is detectable. `GET /api/audit` exposes the result
and the dashboard surfaces it.

## 5. Security

| Concern | Approach |
|---|---|
| Passwords | scrypt (N = 16384, r = 8, p = 1) with a 16-byte random salt, constant-time comparison |
| Sessions | HMAC-SHA256 signed tokens carrying subject, role, issue and expiry; verified with a timing-safe comparison; 12-hour default lifetime |
| Authorisation | Permission list per role, checked by `requirePermission()` on every route; the UI hides nothing that the server does not also refuse |
| Roles | Technician (record), Laboratory Manager (approve, generate, unlock), Auditor (read-only), Administrator (users, rule schema) |
| Segregation of duties | The technician who records cannot approve; approval requires a different role, and the signature chain records both |
| Record integrity | SHA-256 over instrument + environmental + observations, printed on the report; immutable audit ledger; locked approved records |
| Uploads | Size limit, written under the record's own directory, hashed on arrival and listed in the report |
| Session secrets | Generated per installation, stored outside source control with mode 600 |

For a laboratory deployment this is complemented by TLS at the reverse proxy and a file-system backup
policy — see `deployment.md`.

## 6. Offline and field operation

* The service worker caches the application shell, so the editor opens with no connectivity.
* `public/offline.js` stores drafts in IndexedDB (`drafts`) and queues failed writes (`queue`).
* Every mutation that cannot reach the server is queued with its path, method and body, and replayed
  automatically on the `online` event, or on demand through **Sync queued**.
* Calculations are unaffected offline: the same engine code runs in the browser as on the server, so
  a technician still sees PASS/FAIL per load point on a weighbridge with no signal.
* API responses are never cached — stale compliance data would be worse than none.

## 7. Extensibility

* **New OIML limits** — publish a revised `rules/oiml-r76.json`: the current file is archived under
  `rules/archive/`, the new schema is validated before it is activated, and each generated report
  records the revision that produced it.
* **New test modules** — add the module to the schema's `testModules`, add an evaluator to
  `metrology.js` and register it in `MODULE_EVALUATORS`, add the editor definition in
  `public/app.js`. The report and dashboard pick it up automatically.
* **PostgreSQL** — implement the `store.js` interface against a database; the engine, reports and UI
  are untouched.
* **Direct scale capture** — the observation model is a plain array of numbers, so a serial-port
  reader (Web Serial in the browser, or a small local bridge) can populate it without engine changes.
* **Digital signatures** — the signature block and hash are already carried through the report and
  the record, so an X.509/PKI signature provider can be attached at approval time.

## 8. Performance and scale

The workload of a laboratory is small: a type evaluation is a few dozen observations, a report is a
few hundred kilobytes, and approvals arrive at human pace. The design therefore optimises for
verifiability rather than throughput. The heaviest operation is PDF rendering, which shells out to a
headless browser (~1–2 s per report) and is performed on demand. Thousands of stored records remain
comfortable with the file-backed repository; beyond that, move `store.js` to a database and add an
index on report number, manufacturer and status.
