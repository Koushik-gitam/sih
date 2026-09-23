# Calculation methodology

This document states exactly what the engine computes, which clause of OIML R 76-1:2006 each rule
comes from, and how the result produces a pass/fail verdict. Every limit quoted here is also present
in `rules/oiml-r76.json`, which is the source of truth at runtime.

## 1. Quantities and units

| Symbol | Meaning |
|---|---|
| `L` | Applied load |
| `I` | Indication (the displayed value) |
| `ΔL` | Additional change-over sub-weights added until the indication steps up by one interval |
| `e` | Verification scale interval |
| `d` | Actual scale interval |
| `n` | Number of verification scale intervals, `n = Max / e` |
| `P` | Indication prior to rounding |
| `E` | Error before correction |
| `E₀` | Error at zero (or near zero, e.g. 10 e) |
| `E꜀` | Corrected (true) error at the change-over point |
| `m` | Load expressed in verification scale intervals, `m = L / e` |

Instruments are recorded in mg, g, kg or t. The rule schema states the interval limits in grams, so
every comparison against the schema converts through `server/engine/units.js`. All other arithmetic
stays in the instrument's working unit.

## 2. Classification (OIML R 76-1 Table 3)

| Class | e | n = Max/e min | n max | Min (lower limit) |
|---|---|---|---|---|
| I (special) | e ≥ 0.001 g | 50 000 | unbounded | 100 e |
| II (high) | 0.001 g ≤ e ≤ 0.05 g | 100 | 100 000 | 20 e |
| II (high) | e ≥ 0.1 g | 5 000 | 100 000 | 50 e |
| III (medium) | 0.1 g ≤ e ≤ 2 g | 100 | 10 000 | 20 e |
| III (medium) | e ≥ 5 g | 500 | 10 000 | 20 e |
| IIII (ordinary) | e ≥ 5 g | 100 | 1 000 | 10 e |

The minimum capacity falls to **5 e** for grading instruments (those determining a transport tariff
or toll). The instrument record has a `minCapacityMode` field for this.

Validation rejects an instrument whose `e` falls outside every band of the declared class, whose
`n` is outside the permitted range, or whose declared Min is below the required value.

## 3. Maximum permissible errors (OIML R 76-1 Table 6)

MPE on initial verification, for loads `m` expressed in verification scale intervals:

| MPE | Class I | Class II | Class III | Class IIII |
|---|---|---|---|---|
| ±0.5 e | 0 ≤ m ≤ 50 000 | 0 ≤ m ≤ 5 000 | 0 ≤ m ≤ 500 | 0 ≤ m ≤ 50 |
| ±1.0 e | 50 000 < m ≤ 200 000 | 5 000 < m ≤ 20 000 | 500 < m ≤ 2 000 | 50 < m ≤ 200 |
| ±1.5 e | m > 200 000 | 20 000 < m ≤ 100 000 | 2 000 < m ≤ 10 000 | 200 < m ≤ 1 000 |

Implemented by `rules.js::mpeForLoad()`. The upper bound of each bracket is **inclusive**, matching
the inequalities above; a load beyond the last bracket of a bounded class is refused rather than
silently given a tolerance that does not exist.

MPE **in service** is twice the initial-verification value (clause 3.5.2) and is selected by the
`inService` flag on the record or on the query.

## 4. Error determination (clause 3.5.3, Annex A.4.4.3)

Rounding hides the true error of a digital indication, so change-over sub-weights (about 1/10 e) are
added until the indication unambiguously steps up by one interval:

```
P  = I + 0.5 e − ΔL            indication prior to rounding
E  = P − L = I + 0.5 e − ΔL − L error before correction
E꜀ = E − E₀                     corrected error  ≤ MPE
```

`E꜀` is compared with the absolute MPE for the applied load. Equality passes: the requirement is
"shall not exceed".

**Worked example (the A.4.4.3 example, reproduced in `tests/engine.test.js`).** With `e = 5 g`, a
1 000 g load indicating 1 000 g, and the indication stepping up at ΔL = 1.5 g:

```
P  = 1000 + 2.5 − 1.5 = 1001 g
E  = 1001 − 1000       = +1 g
E₀ = +0.5 g  →  E꜀ = 1 − 0.5 = +0.5 g
```

## 5. Test modules and their criteria

| Module | Clause | Criterion implemented |
|---|---|---|
| **Weighing performance** | A.4.4.1–A.4.4.3 | `|E꜀| ≤ MPE(m)` for every load point, increasing and decreasing |
| **Eccentricity (corner load)** | 3.6.2, A.4.7 | Where a centre reading is supplied: `|E꜀(position) − E꜀(centre)| ≤ MPE(m)`. Otherwise every position is checked against the MPE directly. Conventional test load is 1/3 of Max; for load receptors with more than four support points, `Max / (n − 1)`; 1/10 of Max for minimal off-centre loading |
| **Repeatability** | 3.6.1, A.4.4.2 | `max(readings) − min(readings) ≤ |MPE(m)|` for the applied load. The mean, range and sample standard deviation (n−1) are reported |
| **Zero-setting and zero-tracking** | 4.5 | Initial zero-setting range ≤ 20 % of Max (4.5.1); accuracy after zero setting `|E₀| ≤ 0.25 e` (4.5.2); zero-tracking deviation ≤ 0.5 e |
| **Tare device** | 4.6, 3.5.3.4 | Tare residual ≤ 0.25 e (4.6.3); MPE applied to net values for every tare load |
| **Temperature influence** | 3.9.2 | `|E꜀| ≤ MPE(m)` at every test temperature; default working range −10 °C…+40 °C, with minimum spans of 5 °C (I), 15 °C (II) and 30 °C (III/IIII) for declared ranges; zero drift ≤ 1 e per 1 °C (class I) or per 5 °C (other classes) |
| **Power supply influence** | 3.9.3 | `|E꜀| ≤ MPE(m)` at every voltage between 0.85 and 1.10 × U_nom |
| **Creep and return to zero** | 3.9.4 | Deviation of the indication while loaded ≤ 0.5 e over the observation period; deviation on returning to zero ≤ 0.5 e |
| **Discrimination** (check) | 3.8 | A gentle additional load of 1.4 d must produce a change of one scale interval |

Two limits are engineering interpretations rather than direct quotations, because the published
clause expresses them as stability behaviour rather than as a single number: the automatic
zero-tracking deviation (0.5 e) and the return-to-zero deviation (0.5 e). Both are named in the
schema with a note, and both are one-line edits.

## 6. Validation rules applied before any verdict

**Instrument** (`validate.js::validateInstrument`)

* Required: manufacturer, model, serial number, accuracy class, unit, Max, Min, e, d
* `Max > Min`; `d ≤ e`; `e > 0`; `d > 0`
* `e` inside a band of the declared class; `n = Max / e` inside the class interval limits
* `Min ≥` the required capacity of the class (20 e, 100 e, 50 e or 10 e as applicable)
* Declared temperature range spans at least the class minimum (5 / 15 / 30 °C)
* Warnings: `n` not a whole number, unusual support-point count, humidity above 85 %

**Environmental** (`validateEnvironmental`)

* Ambient temperature, relative humidity, barometric pressure and test date are mandatory and are
  recorded before a test can be submitted (clause 3.5.3.1 requires errors to be determined under
  normal test conditions)
* Plausible ranges are enforced (temperature −20…60 °C, humidity 0…100 %)

**Observations** (`validateModuleObservations`)

* Numeric fields present and numeric
* Load ≤ Max; a load below Min raises a warning
* Change-over sub-weight not negative, not larger than one interval, and warned when it departs from
  the conventional 1/10 e step
* Repeatability needs at least two readings per load (three recommended)
* Eccentricity warns when fewer than four positions are recorded and when the test load departs from
  1/3 of Max by more than 5 %
* Temperature points must lie inside the declared range; voltage points inside 0.85–1.10 × U_nom
* At least one module must contain observations

## 7. Verdicts

| Verdict | Meaning |
|---|---|
| `pass` | Every module tested passed and every load point is inside the MPE |
| `fail` | At least one load point, check or module is outside tolerance |
| `incomplete` | No observations recorded yet — a normal draft state |
| `invalid` | Blocking validation findings (impossible instrument data, missing environmental records, …). No compliance claim is made |

Coverage is reported separately: `coverageComplete` is true only when the weighing, eccentricity,
repeatability and zero-setting modules are all present. Missing modules are named, never silently
treated as passing.

## 8. Integrity hash

```
SHA-256( canonical-json( { instrument, environmental, modules, ruleRevision, reportFormat } ) )
```

Canonical JSON sorts object keys recursively (`server/util.js::stableStringify`) so the hash is
reproducible across machines and after a round trip through storage. Any later edit to an instrument
parameter or an observation changes the hash, and the hash is printed on the report and stored with
the record's approval signature.

## 9. Test-load planning

`engine/planning.js` proposes a load set for the weighing test: Min, Max, quarter and half of Max, and
the values immediately either side of every MPE bracket boundary of the class. Crossing the
boundaries is what proves the instrument is accurate in each bracket, so the planner guarantees the
test is meaningful rather than merely long. Eccentricity loads follow clause 3.6.2.

## 10. Verification

* `npm test` — 32 unit tests, including the whole Table 6 for all four classes, the A.4.4.3 worked
  example, each module's criterion, the validation rules, hash stability and the load planner
* `npm run test:api` — 61 end-to-end checks over the running HTTP API: authentication, RBAC denials,
  validation blocking, evaluation, submission, approval, locking, justified unlocking, report
  generation and download, attachments, dashboard and audit-chain verification
* `npm run report:sample` — produces a complete conforming report in all three formats and prints the
  verdict, MPE brackets and integrity hash
