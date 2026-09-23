# NAWI Test Report System — OIML R 76

Software application for **generation of test reports for Non-Automatic Weighing Instruments (NAWI)
as per OIML Recommendation R 76**.

**Smart India Hackathon 2026 · Problem Statement 26035 · Category: Software**
**Organisation:** Ministry of Consumer Affairs, Food & Public Distribution — Department of Consumer Affairs (DoCA)

---

## What this solves

Under the Legal Metrology Act, 2009 and the Legal Metrology (General) Rules, 2011, every commercial
scale and weighbridge needs Model Approval before manufacture or import. Designated laboratories
(RRSLs, CSIR-NPL, GATCs) evaluate instruments according to OIML R 76, but today the observations are
recorded on paper or in spreadsheets and the report is assembled by hand. That is slow, produces
inconsistent report layouts and — most importantly — invites arithmetic mistakes in the
**maximum permissible error (MPE)** and **change-over point true error (E<sub>c</sub>)** calculations,
which are not constants but depend on the accuracy class, the verification scale interval *e* and
the applied load.

This application replaces that manual step with a deterministic engine:

```
instrument data + environmental conditions + raw observations
        │
        ▼
  validation (physical & metrological constraints)
        │
        ▼
  OIML R 76 calculation engine  →  MPE bracket, E, Ec, repeatability, eccentricity, tare, influence
        │
        ▼
  compliance verdict per load point, per module and for the whole record
        │
        ▼
  standardized report: OIML R 76-2 layout, PDF + editable Word, SHA-256 integrity hash,
  searchable repository, append-only audit ledger
```

## Highlights

| Capability | Implementation |
|---|---|
| Deterministic metrology core | `server/engine/` — pure functions, no I/O, 32 unit tests reproducing OIML R 76-1 Table 6 and the A.4.4.3 worked example |
| Automated MPE / true error | Class-wise MPE brackets and `E = I + 0.5e − ΔL − L`, `E<sub>c</sub> = E − E<sub>0</sub>` |
| All prescribed test modules | Weighing, eccentricity, repeatability, zero-setting, tare, temperature, power supply, creep |
| Input validation | Max ≥ Min, d ≤ e, n = Max/e inside the class limits, Min ≥ required e, load ≤ Max, sub-weight sanity, mandatory environmental records |
| Live verdicts | The engine evaluates on every keystroke and marks each load point PASS / FAIL |
| Standardized reports | OIML R 76-2 style layout rendered to **PDF** (headless Chromium) and **editable .docx**, plus printable HTML |
| Tamper evidence | SHA-256 over instrument + environmental + observation data, printed on the report; hash-chained audit ledger |
| Role-based access | Technician · Laboratory Manager · Auditor · Administrator, enforced server-side |
| Offline field use | PWA with IndexedDB draft storage and a replay queue for remote weighbridge sites |
| Future-proof rules | All metrological limits live in `rules/oiml-r76.json`; an administrator can publish a new revision without touching code |
| Repository & dashboard | Search by report number, manufacturer, model, serial, class, status; status and verdict statistics |

## Quick start

```bash
cd sih26035-nawi
npm install
npm run seed          # optional: four representative test records
npm start             # http://localhost:3000
```

Sign-in accounts created on first start (change the passwords immediately):

| Username | Role | Default password |
|---|---|---|
| `admin` | Administrator | `Admin@26035` |
| `manager` | Laboratory Manager / Evaluator | `Manager@26035` |
| `technician` | Laboratory Technician | `Technician@26035` |
| `auditor` | Auditor | `Auditor@26035` |

PDF rendering needs a Chromium/Chrome binary. It is auto-detected; set `CHROME_BIN` if yours is in
an unusual place. Without a browser the application still generates the printable HTML and the
`.docx` report.

### npm scripts

| Script | Purpose |
|---|---|
| `npm start` | Start the application server |
| `npm run dev` | Start with file watching |
| `npm test` | Engine and validation unit tests (`node --test`) |
| `npm run test:api` | End-to-end workflow test: boots the server and walks sign-in → approval → report |
| `npm run seed` | Seed four representative records (`-- --force` to replace) |
| `npm run report:sample` | Generate a complete sample report in HTML, PDF and DOCX under `out/` |
| `npm run deck:pdf` | Export the SIH presentation deck to `out/SIH26035-NAWI-Deck.pdf` |

## Presentation deck

`deck/slides.html` is the 10-slide SIH pitch (16:9, print-ready). Export it with `npm run deck:pdf`
and upload the resulting PDF to the portal. `deck/image-prompts.md` holds optional AI image prompts
if the team wants richer graphics; the deck is complete without them.

## Repository layout

```
sih26035-nawi/
├── rules/oiml-r76.json         Rule schema: classes, MPE brackets, tolerances, test modules
├── server/
│   ├── index.js                Express application and REST API
│   ├── auth.js                 Password hashing, signed sessions, RBAC
│   ├── store.js                Repository, report records, hash-chained audit ledger
│   ├── engine/
│   │   ├── rules.js            Schema loading, validation, MPE bracket lookup
│   │   ├── metrology.js        Errors, true error, repeatability, eccentricity, zero, tare, influence
│   │   ├── validate.js         Instrument, environmental and observation validation
│   │   ├── evaluate.js         Whole-record evaluation, verdict, integrity hash
│   │   ├── planning.js         Test-load planner (covers every MPE bracket)
│   │   └── units.js            mg / g / kg / t handling
│   └── reports/
│       ├── document.js         OIML R 76-2 style HTML report
│       ├── docx.js             Editable Word report
│       ├── pdf.js              Headless-browser PDF renderer
│       └── report.js           Artefact generation with hashes
├── public/                     Progressive web app (no build step)
├── scripts/                    Seed, sample report, deck export, end-to-end test
├── tests/                      Engine unit tests
├── docs/                       Architecture, calculation methodology, deployment, traceability
└── data/                       Runtime repository, uploads and generated reports (git-ignored)
```

## API summary

All endpoints except `/api/health`, `/api/meta` and `/api/auth/login` require
`Authorization: Bearer <token>`.

| Method and path | Purpose |
|---|---|
| `GET /api/health` | Service status, rule schema, PDF renderer, audit-chain state |
| `GET /api/meta` | Classes, MPE tables, test modules, roles, statuses |
| `POST /api/auth/login` | Sign in, returns a signed session token |
| `GET /api/auth/me`, `POST /api/auth/password` | Session details, password change |
| `GET/POST /api/users`, `PATCH /api/users/:id` | User administration (administrator) |
| `GET /api/rules`, `PUT /api/rules`, `GET /api/rules/history` | Rule schema read, publish, revision history |
| `GET/POST /api/tests`, `GET/PATCH/DELETE /api/tests/:id` | Test records (repository) |
| `POST /api/tests/:id/evaluate`, `POST /api/evaluate` | Evaluate a stored record / an unsaved payload |
| `POST /api/tests/:id/submit` | Submit for review (blocked on validation findings) |
| `POST /api/tests/:id/approve`, `/reject`, `/unlock` | Manager workflow; unlocking needs a written justification |
| `POST /api/tests/:id/attachments` | Attach photographs/documents (base64 JSON, hashed on arrival) |
| `GET /api/tests/:id/report?format=pdf,docx` | Generate report artefacts |
| `GET /api/tests/:id/report/preview` | Printable HTML preview |
| `GET /api/reports/:filename` | Download a generated artefact |
| `POST /api/planning/test-loads`, `/api/planning/mpe` | Suggested load set; MPE for a load |
| `GET /api/dashboard`, `GET /api/audit` | Statistics; audit ledger and chain verification |

## Requirement coverage

`docs/traceability.md` maps every bullet of the problem statement to the file that implements it.
A condensed view:

| Problem statement requirement | Where |
|---|---|
| Capture instrument details and technical specifications | Test editor → *Instrument data* (`server/engine/validate.js`) |
| Record laboratory and environmental conditions | Test editor → *Laboratory and environmental conditions* |
| Enter observations for all prescribed tests | Eight module editors (`public/app.js`, `rules/oiml-r76.json`) |
| Automatically calculate permissible errors and compliance | `server/engine/metrology.js` |
| Validation checks on entered data | `server/engine/validate.js` |
| Automatic pass/fail determination | `server/engine/evaluate.js` |
| Standardized printable reports | `server/reports/document.js`, `pdf.js`, `docx.js` |
| Digital repository of completed reports | `server/store.js`, repository view |
| Secure access with role-based permissions | `server/auth.js` |
| Support future OIML revisions | `rules/oiml-r76.json`, `PUT /api/rules` |
| Dashboard, search and retrieval | Dashboard and repository views, `GET /api/tests` |
| Technical documentation | `docs/` |

## Documentation

* [`docs/architecture.md`](docs/architecture.md) — layers, data flow, storage model, security, offline design
* [`docs/calculation-methodology.md`](docs/calculation-methodology.md) — every formula, limit and criterion, with worked examples
* [`docs/deployment.md`](docs/deployment.md) — local, laboratory-server and container deployment, back-up and hardening
* [`docs/traceability.md`](docs/traceability.md) — requirement-to-code traceability for evaluation

## Scope and honesty notes

* The metrological limits were transcribed from **OIML R 76-1:2006** (Table 3 classification,
  Table 6 maximum permissible errors, clause 3.5.2 in-service MPE, 3.6 permissible differences,
  3.9.2–3.9.4 influence quantities, 4.5 zero-setting, 4.6 tare, A.4.4 error determination).
  OIML recommendations are copyright material; the laboratories deploying this should verify
  `rules/oiml-r76.json` against their own licensed copy, and the schema carries a revision number so
  any adjustment is traceable in the reports it produces.
* Two limits in the schema are engineering interpretations rather than direct quotations
  (automatic zero-tracking deviation and the return-to-zero deviation). They are flagged in the
  schema notes and are trivially adjustable.
* Multi-interval and multiple-range instruments are selectable in the instrument record and the
  classification rules are applied to the relevant band, but per-partial-range MPE tables are not
  yet modelled — the schema is the place to extend.
* Reports are digitally *hashed*, not cryptographically signed with an X.509 certificate.
  PKI/e-Sign integration is an optional feature in the problem statement; the signature block and
  the hash are in place for it to be added.
* The report layout follows the structure and content of the OIML R 76-2 report format; it is not
  claimed to be a byte-identical reproduction of the published form.
