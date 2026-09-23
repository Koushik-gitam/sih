# Requirement traceability — SIH problem statement 26035

Every bullet of the problem statement, mapped to the artefact that satisfies it. Use this table when
demonstrating the solution to evaluators: each row is a claim that can be exercised in the running
application.

## A. System capabilities listed in the description

| # | Requirement | Implementation | How to see it |
|---|---|---|---|
| A1 | Capturing instrument details and technical specifications | `public/app.js` (instrument editor), `server/engine/validate.js` | *New test record* → **1. Instrument data** |
| A2 | Recording laboratory and environmental conditions | Environmental editor; mandatory checks in `validate.js` | *New test record* → **2. Laboratory and environmental conditions** |
| A3 | Entering observations from various OIML R 76 test procedures | `rules/oiml-r76.json` `testModules`, editors in `public/app.js` | **3. Test observations** → eight module tabs |
| A4 | Automatically calculating permissible errors and compliance status | `server/engine/rules.js` (MPE brackets), `server/engine/metrology.js` | Type a load; the MPE and E꜀ appear in the Result column immediately |
| A5 | Performing validation checks on entered test data | `server/engine/validate.js` | Enter `Max = 0.05`, `Min = 10` → blocking finding *Max must be greater than Min* |
| A6 | Automatically determining pass/fail criteria | `server/engine/metrology.js` (per module), `engine/evaluate.js` (record verdict) | Verdict banner, module dots, per-row PASS/FAIL badges |
| A7 | Generating standardized digital test reports in printable formats | `server/reports/document.js`, `pdf.js` | **Preview report** → printable OIML R 76-2 layout |
| A8 | Maintaining a digital repository of completed test reports | `server/store.js`, repository view | *Test repository* → search, filter, open |
| A9 | Secure user access with role-based permissions | `server/auth.js` | Sign in as `auditor` and try to create a record → refused |
| A10 | Supporting future updates when OIML recommendations are revised | `rules/oiml-r76.json`, `PUT /api/rules`, `rules/archive/` | *OIML R 76 rules* → publish a revised schema (administrator) |

## B. Expected solution deliverables

| # | Deliverable | Implementation | How to see it |
|---|---|---|---|
| B1 | User-friendly desktop and/or web-based application | Progressive web app, installable (`public/manifest.webmanifest`, `public/sw.js`) | Browser → *Install app* |
| B2 | Digital data entry forms for all applicable tests | Eight module editors generated from the rule schema | Module tabs in the test editor |
| B3 | Automated calculations and compliance verification | `server/engine/` (pure functions, 32 unit tests) | `npm test` |
| B4 | Standardized reports in PDF **and** editable Word | `server/reports/pdf.js`, `server/reports/docx.js` | **Generate PDF + Word**, then download both |
| B5 | Instrument-wise test history and report repository | Records keyed by instrument with history, revisions and signatures (`server/store.js`) | Open a record; view history in the audit ledger filtered by record id |
| B6 | Dashboard for monitoring testing activities and report status | Dashboard view, `GET /api/dashboard` | *Dashboard* |
| B7 | Search and retrieval of previously generated reports | `store.searchTests()`, `GET /api/tests?query=…` | Search by report number, manufacturer, model, serial, class, status |
| B8 | Technical documentation (architecture, calculation methodology, deployment) | `docs/architecture.md`, `docs/calculation-methodology.md`, `docs/deployment.md` | Repository |

## C. Key functional requirements

| # | Requirement | Implementation |
|---|---|---|
| C1 | Entry of manufacturer, instrument specification, model and technical parameters | Instrument editor; validated in `validate.js` (required fields, `Max > Min`, `d ≤ e`, `n` limits, `Min ≥ 20 e`, temperature span) |
| C2 | Compliance determination as per OIML R 76 | `rules.js` (Table 3, Table 6, in-service doubling) + `metrology.js` |
| C3 | Entry of observations for all prescribed tests | Weighing, eccentricity, repeatability, zero-setting, tare, temperature, power supply, creep |
| C4 | Automatic validation of input data and related calculations | Validation panel with blocking findings and warnings |
| C5 | Automatic preparation of standardized reports with auto-populated laboratory and instrument details | `renderReport()` writes the header, instrument table and test conditions from the record |
| C6 | Attachment of photographs and supporting documents | Attachment panel; files hashed and listed in the report |
| C7 | Digital signatures (optional) | Signature block (tested / approved) with name, role, timestamp and record hash; PKI integration point documented |
| C8 | Export to PDF and editable formats | PDF, DOCX and printable HTML artefacts, each with a SHA-256 hash |
| C9 | Dashboard for report management (completed, in process, history) | Status and verdict statistics, pending-approval count, recent records |

## D. Non-functional claims and where they are proven

| Claim | Evidence |
|---|---|
| The MPE and error arithmetic matches OIML R 76-1 | `tests/engine.test.js` — full Table 6 for all four classes and the A.4.4.3 worked example |
| Nothing is calculated until the input is valid | `engine/validate.js`; end-to-end checks in `scripts/smoke-test.js` |
| Approved records cannot be edited silently | Locked records reject edits with HTTP 423; unlocking requires a written justification and snapshots the previous state |
| History cannot be rewritten | Hash-chained audit ledger, `verifyAuditChain()`, surfaced on the dashboard |
| A report can be checked against the record | SHA-256 integrity hash printed on the report and stored with the approval signature |
| The system works at a site with no connectivity | Service-worker shell cache, IndexedDB drafts, replay queue, in-browser calculations |
| The rules can change without a code change | Rule schema, archive of previous revisions, revision stamped on every report |
