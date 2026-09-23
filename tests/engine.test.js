// Engine test suite - run with `npm test` (node --test).
//
// The MPE expectations below are taken directly from OIML R 76-1:2006 Table 6,
// and the corrected-error example reproduces the worked example in A.4.4.3.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRules, mpeForLoad, classify, validateRules } = require('../server/engine/rules');
const {
  correctedError,
  errorBeforeCorrection,
  evaluateLoadPoint,
  evaluateWeighingTest,
  evaluateRepeatabilityTest,
  evaluateEccentricityTest,
  evaluateZeroTest,
  evaluateTareTest,
  standardDeviation,
} = require('../server/engine/metrology');
const {
  validateInstrument,
  validateEnvironmental,
  validateModuleObservations,
} = require('../server/engine/validate');
const { evaluateTest, integrityHash } = require('../server/engine/evaluate');
const { suggestTestLoads, eccentricityLoad } = require('../server/engine/planning');
const { toGrams, convert } = require('../server/engine/units');

const rules = loadRules();

function instrument(overrides = {}) {
  return {
    manufacturer: 'Test Instruments Pvt Ltd',
    model: 'TI-3000',
    serialNumber: 'SN-001',
    accuracyClass: 'III',
    unit: 'g',
    maxCapacity: 15000,
    minCapacity: 100,
    e: 5,
    d: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rule schema
// ---------------------------------------------------------------------------

test('rule schema is structurally valid', () => {
  assert.deepEqual(validateRules(rules), []);
  assert.equal(rules.standard, 'OIML R 76-1:2006 (E)');
  assert.equal(rules.mpeInServiceMultiplier, 2);
});

test('rule schema is served from rules/oiml-r76.json', () => {
  assert.ok(rules.classes.I && rules.classes.II && rules.classes.III && rules.classes.IIII);
  assert.equal(rules.testModules.length, 8);
});

// ---------------------------------------------------------------------------
// MPE brackets - OIML R 76-1 Table 6
// ---------------------------------------------------------------------------

test('class III MPE brackets follow Table 6', () => {
  const base = { accuracyClass: 'III', e: 5, eUnit: 'g', loadUnit: 'g', rules };
  assert.equal(mpeForLoad({ ...base, load: 0 }).mpe, 2.5);          // 0 e
  assert.equal(mpeForLoad({ ...base, load: 2500 }).mpe, 2.5);       // 500 e  -> ±0.5 e
  assert.equal(mpeForLoad({ ...base, load: 2505 }).mpe, 5);         // 501 e  -> ±1.0 e
  assert.equal(mpeForLoad({ ...base, load: 10000 }).mpe, 5);        // 2000 e -> ±1.0 e
  assert.equal(mpeForLoad({ ...base, load: 10005 }).mpe, 7.5);      // 2001 e -> ±1.5 e
  assert.equal(mpeForLoad({ ...base, load: 50000 }).mpe, 7.5);      // 10000 e
});

test('class I MPE brackets follow Table 6', () => {
  const base = { accuracyClass: 'I', e: 0.001, eUnit: 'g', loadUnit: 'g', rules };
  assert.equal(mpeForLoad({ ...base, load: 0.001 * 50000 }).mpeInE, 0.5);
  assert.equal(mpeForLoad({ ...base, load: 0.001 * 50001 }).mpeInE, 1);
  assert.equal(mpeForLoad({ ...base, load: 0.001 * 200000 }).mpeInE, 1);
  assert.equal(mpeForLoad({ ...base, load: 0.001 * 200001 }).mpeInE, 1.5);
});

test('class II stops at 100 000 e and class IIII at 1 000 e', () => {
  const classII = { accuracyClass: 'II', e: 0.01, eUnit: 'g', loadUnit: 'g', rules };
  assert.equal(mpeForLoad({ ...classII, load: 0.01 * 100000 }).mpeInE, 1.5);
  assert.throws(() => mpeForLoad({ ...classII, load: 0.01 * 100001 }), /exceeds the maximum measurable range/);

  const classIIII = { accuracyClass: 'IIII', e: 100, eUnit: 'g', loadUnit: 'g', rules };
  assert.equal(mpeForLoad({ ...classIIII, load: 100 * 1000 }).mpeInE, 1.5);
  assert.throws(() => mpeForLoad({ ...classIIII, load: 100 * 1001 }), /exceeds the maximum measurable range/);
});

test('MPE in service is twice the MPE on initial verification (3.5.2)', () => {
  const result = mpeForLoad({
    accuracyClass: 'III', e: 5, eUnit: 'g', load: 2500, loadUnit: 'g', inService: true, rules,
  });
  assert.equal(result.mpeInE, 1);
  assert.equal(result.mpe, 5);
});

test('e below a class band is rejected, and 5 g is valid for class III (Table 3)', () => {
  // Class I has no upper e bound in Table 3, but e < 1 mg falls outside every band
  assert.throws(
    () => mpeForLoad({ accuracyClass: 'I', e: 0.0001, eUnit: 'g', load: 1, loadUnit: 'g', rules }),
    /does not fall in a valid range for class I/,
  );
  // 5 g is valid for class III (second band: e >= 5 g)
  const { band } = classify({ accuracyClass: 'III', e: 5, eUnit: 'g', maxCapacity: 15000, rules });
  assert.equal(band.minCapacityInE, 20);
});

test('class I has no upper e bound but demands n >= 50 000 and Min >= 100 e', () => {
  const { band } = classify({ accuracyClass: 'I', e: 5, eUnit: 'g', maxCapacity: 15000, rules });
  assert.equal(band.minCapacityInE, 100);

  const check = validateInstrument(instrument({ accuracyClass: 'I' }), rules);
  assert.ok(check.errors.some((error) => error.code === 'interval_range'));
  assert.ok(check.errors.some((error) => error.code === 'min_capacity'));
});

test('loads must be in e units consistent with the instrument (kg instruments)', () => {
  // e = 0.005 kg = 5 g -> class III second band
  const result = mpeForLoad({
    accuracyClass: 'III', e: 0.005, eUnit: 'kg', load: 10, loadUnit: 'kg', rules,
  });
  assert.equal(result.loadInE, 2000);
  assert.equal(result.mpeInE, 1);
  assert.equal(result.mpe, 0.005);

  assert.throws(
    () => mpeForLoad({ accuracyClass: 'III', e: 0.005, eUnit: 'kg', load: 10, loadUnit: 'g', rules }),
    /same unit/,
  );
});

// ---------------------------------------------------------------------------
// Error determination - A.4.4.3 worked example
// ---------------------------------------------------------------------------

test('reproduces the OIML R 76-1 A.4.4.3 worked example', () => {
  const observation = { indication: 1000, load: 1000, e: 5, additionalLoad: 1.5 };
  const { P, E } = errorBeforeCorrection(observation);
  assert.equal(P, 1001);
  assert.equal(E, 1);

  const { Ec } = correctedError({ ...observation, zeroError: 0.5 });
  assert.equal(Ec, 0.5);
});

test('load point verdict compares |Ec| with the MPE for that load', () => {
  const context = { instrument: instrument(), rules, inService: false };

  // 1000 g = 200 e -> MPE = 0.5 e = 2.5 g.
  // Without a zero error, Ec = E = 1000 + 2.5 - 1.5 - 1000 = 1 g -> pass
  const pass = evaluateLoadPoint({ load: 1000, indication: 1000, additionalLoad: 1.5 }, context);
  assert.equal(pass.correctedError, 1);
  assert.equal(pass.mpe, 2.5);
  assert.equal(pass.pass, true);

  // With the zero error from A.4.4.3 (E0 = +0.5 g) the corrected error is 0.5 g
  const corrected = evaluateLoadPoint(
    { load: 1000, indication: 1000, additionalLoad: 1.5, zeroError: 0.5 },
    context,
  );
  assert.equal(corrected.correctedError, 0.5);
  assert.equal(corrected.pass, true);

  // Same load, indication 1005 g -> Ec = 7.5 g -> fail
  const fail = evaluateLoadPoint({ load: 1000, indication: 1005 }, context);
  assert.equal(fail.correctedError, 7.5);
  assert.equal(fail.pass, false);
  assert.ok(fail.marginInE < 0);
});

// ---------------------------------------------------------------------------
// Test modules
// ---------------------------------------------------------------------------

test('weighing test aggregates increasing and decreasing loads', () => {
  const result = evaluateWeighingTest(
    {
      points: [
        { load: 100, indication: 100, direction: 'increasing' },
        { load: 2500, indication: 2500, direction: 'increasing' },
        { load: 2500, indication: 2500, direction: 'decreasing' },
        { load: 15000, indication: 15000, direction: 'decreasing' },
      ],
    },
    { instrument: instrument(), rules },
  );
  assert.equal(result.status, 'pass');
  assert.equal(result.increasing, 2);
  assert.equal(result.decreasing, 2);
  assert.equal(result.failedPoints, 0);
});

test('weighing test fails when any single point exceeds the MPE (3.6)', () => {
  const result = evaluateWeighingTest(
    { points: [{ load: 1000, indication: 1004 }] },
    { instrument: instrument(), rules },
  );
  assert.equal(result.status, 'fail');
  assert.equal(result.failedPoints, 1);
});

test('repeatability criterion is the range against the MPE for the load (3.6.1)', () => {
  const context = { instrument: instrument(), rules };

  const pass = evaluateRepeatabilityTest({ sets: [{ load: 1000, readings: [1000, 1001, 1002] }] }, context);
  assert.equal(pass.status, 'pass');
  assert.equal(pass.points[0].range, 2);
  assert.equal(pass.points[0].mpe, 2.5);

  const fail = evaluateRepeatabilityTest({ sets: [{ load: 1000, readings: [1000, 1004] }] }, context);
  assert.equal(fail.status, 'fail');
  assert.equal(fail.points[0].range, 4);

  const tooFew = evaluateRepeatabilityTest({ sets: [{ load: 1000, readings: [1000] }] }, context);
  assert.equal(tooFew.status, 'fail');
  assert.equal(tooFew.points[0].incomplete, true);
});

test('sample standard deviation is computed as reported', () => {
  assert.equal(standardDeviation([1000, 1001, 1002]), 1);
  assert.equal(Number(standardDeviation([10, 12, 14]).toFixed(4)), 2);
});

test('eccentricity compares each position with the centre reading (3.6.2)', () => {
  const context = { instrument: instrument(), rules };
  const result = evaluateEccentricityTest(
    {
      load: 5000,
      centre: { indication: 5000, additionalLoad: 2 },
      points: [
        { position: 'front-left', indication: 5000, additionalLoad: 2 },
        { position: 'front-right', indication: 5001, additionalLoad: 2 },
        { position: 'rear-left', indication: 5010, additionalLoad: 2 },
      ],
    },
    context,
  );

  assert.equal(result.status, 'fail');
  assert.equal(result.points[0].pass, true);
  assert.equal(result.points[2].pass, false);
  assert.equal(result.points[0].differenceFromCentre, 0);
  // 5000 g = 1000 e -> MPE = 1.0 e = 5 g
  assert.equal(result.mpe, 5);
});

test('eccentricity without a centre reading checks each position against the MPE', () => {
  const context = { instrument: instrument(), rules };
  const result = evaluateEccentricityTest(
    { load: 5000, points: [{ position: 'front-left', indication: 5000 }] },
    context,
  );
  assert.equal(result.criterion.includes('each position shall meet the MPE'), true);
  assert.equal(result.points[0].pass, true);
});

test('zero-setting checks range, accuracy and tracking (4.5)', () => {
  const context = { instrument: instrument(), rules };

  const pass = evaluateZeroTest({ initialZeroLoad: 2500, zeroError: 1, trackingDeviation: 2 }, context);
  assert.equal(pass.status, 'pass');
  assert.equal(pass.checks.length, 3);

  // Initial zero-setting is limited to 20 % of Max = 3000 g
  const failRange = evaluateZeroTest({ initialZeroLoad: 3500 }, context);
  assert.equal(failRange.status, 'fail');

  // Zero-setting accuracy is ±0.25 e = ±1.25 g
  const failAccuracy = evaluateZeroTest({ zeroError: 1.5 }, context);
  assert.equal(failAccuracy.status, 'fail');
});

test('tare accuracy limit is 0.25 e and net values carry the instrument MPE (3.5.3.4)', () => {
  const context = { instrument: instrument(), rules };
  const result = evaluateTareTest(
    {
      tareLoad: 1000,
      indicationAfterTare: 0,
      // residual = 0 + 0.5 e - dL = 2.5 - 2.0 = 0.5 g, inside the 0.25 e = 1.25 g limit
      additionalLoad: 2,
      netPoints: [{ load: 2000, indication: 2000 }],
    },
    context,
  );

  assert.equal(result.status, 'pass');
  assert.equal(result.checks[0].value, 0.5);
  assert.equal(result.checks[0].limit, 1.25);
  assert.equal(result.points[0].load, 2000);
});

// ---------------------------------------------------------------------------
// Instrument validation
// ---------------------------------------------------------------------------

test('instrument validation rejects Max <= Min, d > e and e above the class range', () => {
  const maxMin = validateInstrument(instrument({ maxCapacity: 50, minCapacity: 100 }), rules);
  assert.equal(maxMin.valid, false);
  assert.ok(maxMin.errors.some((error) => error.code === 'max_min'));

  const dGreaterThanE = validateInstrument(instrument({ d: 10 }), rules);
  assert.ok(dGreaterThanE.errors.some((error) => error.code === 'd_gt_e'));

  // 1 g e is impossible for class IIII (Table 3 requires e >= 5 g)
  const badE = validateInstrument(instrument({ accuracyClass: 'IIII', e: 1, d: 1 }), rules);
  assert.ok(badE.errors.some((error) => error.code === 'class_band'));
});

test('instrument validation enforces n = Max / e limits and Min >= 20 e', () => {
  const tooManyIntervals = validateInstrument(instrument({ maxCapacity: 150000 }), rules);
  assert.ok(tooManyIntervals.errors.some((error) => error.code === 'interval_range'));

  const minTooSmall = validateInstrument(instrument({ minCapacity: 50 }), rules);
  assert.ok(minTooSmall.errors.some((error) => error.code === 'min_capacity'));

  const valid = validateInstrument(instrument(), rules);
  assert.equal(valid.valid, true);
  assert.equal(valid.classification.intervals, 3000);
  assert.equal(valid.classification.className, 'III');
});

test('classification reports the applicable band and temperature span requirements', () => {
  const narrowSpan = validateInstrument(
    instrument({ temperatureRange: { min: 15, max: 25 } }),
    rules,
  );
  assert.ok(narrowSpan.errors.some((error) => error.code === 'temperature_span'));

  const okSpan = validateInstrument(instrument({ temperatureRange: { min: -10, max: 40 } }), rules);
  assert.equal(okSpan.valid, true);
});

test('environmental conditions are mandatory before submission', () => {
  const missing = validateEnvironmental({}, rules);
  assert.equal(missing.valid, false);
  assert.equal(missing.errors.length, 4);

  const implausible = validateEnvironmental(
    { ambientTemperatureCelsius: 120, relativeHumidityPercent: 60, barometricPressureKpa: 101, testDate: '2026-09-23' },
    rules,
  );
  assert.equal(implausible.valid, false);

  const ok = validateEnvironmental(
    { ambientTemperatureCelsius: 24, relativeHumidityPercent: 58, barometricPressureKpa: 101.3, testDate: '2026-09-23' },
    rules,
  );
  assert.equal(ok.valid, true);
});

test('observation validation blocks loads above Max and oversized sub-weights', () => {
  const above = validateModuleObservations('weighing_test', { points: [{ load: 16000, indication: 16000 }] }, instrument(), rules);
  assert.ok(above.errors.some((error) => error.code === 'load_gt_max'));

  const bigSubWeight = validateModuleObservations(
    'weighing_test',
    { points: [{ load: 1000, indication: 1000, additionalLoad: 12 }] },
    instrument(),
    rules,
  );
  assert.ok(bigSubWeight.errors.some((error) => error.code === 'sub_weight_large'));

  const subWeightStep = validateModuleObservations(
    'weighing_test',
    { points: [{ load: 1000, indication: 1000, additionalLoad: 2 }] },
    instrument(),
    rules,
  );
  assert.ok(subWeightStep.warnings.some((warning) => warning.code === 'sub_weight_step'));
});

// ---------------------------------------------------------------------------
// Whole-record evaluation
// ---------------------------------------------------------------------------

function fullRecord(overrides = {}) {
  return {
    testId: 'TEST-1',
    reportNumber: 'RRSL/2026/001',
    instrument: instrument(),
    laboratory: { name: 'Regional Reference Standard Laboratory', labCode: 'RRSL-AND-01' },
    environmental: {
      ambientTemperatureCelsius: 24, relativeHumidityPercent: 58,
      barometricPressureKpa: 101.3, testDate: '2026-09-23', testedBy: 'technician@lab',
    },
    modules: {
      weighing_test: {
        points: [
          { load: 100, indication: 100, direction: 'increasing' },
          { load: 2500, indication: 2500, direction: 'increasing' },
          { load: 15000, indication: 15000, direction: 'increasing' },
          { load: 15000, indication: 15000, direction: 'decreasing' },
          { load: 2500, indication: 2500, direction: 'decreasing' },
        ],
      },
      repeatability_test: { sets: [{ load: 7500, readings: [7500, 7501, 7500] }] },
      eccentricity_test: {
        load: 5000,
        centre: { indication: 5000 },
        points: [
          { position: 'front-left', indication: 5000 },
          { position: 'front-right', indication: 5001 },
        ],
      },
      zero_setting_test: { initialZeroLoad: 1500, zeroError: 0.5, trackingDeviation: 1 },
    },
    ...overrides,
  };
}

test('a complete conforming record passes with full coverage', () => {
  const evaluation = evaluateTest(fullRecord(), { rules });
  assert.equal(evaluation.summary.verdict, 'pass');
  assert.equal(evaluation.summary.modulesFailed, 0);
  assert.equal(evaluation.summary.coverageComplete, true);
  assert.equal(evaluation.validation.valid, true);
  assert.equal(evaluation.ruleView.className, 'III');
  assert.equal(evaluation.ruleView.mpeTable.length, 3);
});

test('a failing observation fails the record and points to the module', () => {
  const record = fullRecord();
  record.modules.weighing_test.points[1] = { load: 2500, indication: 2508, direction: 'increasing' };
  const evaluation = evaluateTest(record, { rules });

  assert.equal(evaluation.summary.verdict, 'fail');
  assert.equal(evaluation.summary.modulesFailed, 1);
  const weighing = evaluation.modules.find((module) => module.moduleId === 'weighing_test');
  assert.equal(weighing.status, 'fail');
  assert.equal(weighing.points[1].pass, false);
});

test('untested modules are reported as coverage gaps, not failures', () => {
  const record = fullRecord();
  delete record.modules.eccentricity_test;
  delete record.modules.repeatability_test;
  const evaluation = evaluateTest(record, { rules });

  assert.equal(evaluation.summary.verdict, 'pass');
  assert.equal(evaluation.summary.coverageComplete, false);
  assert.deepEqual(evaluation.summary.expectedModulesMissing, ['eccentricity_test', 'repeatability_test']);
});

test('invalid input yields the invalid verdict instead of a compliance claim', () => {
  const record = fullRecord({ environmental: {} });
  const evaluation = evaluateTest(record, { rules });
  assert.equal(evaluation.summary.verdict, 'invalid');
  assert.ok(evaluation.validation.errors.length >= 4);
});

test('integrity hash is stable for identical data and changes when data changes', () => {
  const a = integrityHash(fullRecord(), rules.revision);
  const b = integrityHash(fullRecord(), rules.revision);
  assert.equal(a, b);
  assert.equal(a.length, 64);

  const tampered = fullRecord();
  tampered.modules.weighing_test.points[0].indication = 101;
  assert.notEqual(integrityHash(tampered, rules.revision), a);
});

// ---------------------------------------------------------------------------
// Planning helpers
// ---------------------------------------------------------------------------

test('suggested test loads cover every MPE bracket and stay inside Min..Max', () => {
  const suggestions = suggestTestLoads(instrument(), rules);
  const loads = suggestions.map((entry) => entry.load);

  assert.ok(loads.includes(100), 'includes Min');
  assert.ok(loads.includes(15000), 'includes Max');
  assert.ok(loads.includes(2505), 'includes the first interval above 500 e');
  assert.ok(loads.includes(10005), 'includes the first interval above 2000 e');
  assert.ok(loads.every((load) => load >= 100 && load <= 15000));
  assert.deepEqual([...loads].sort((a, b) => a - b), loads, 'loads are sorted');

  const bracketAt2505 = suggestions.find((entry) => entry.load === 2505);
  assert.equal(bracketAt2505.mpeInE, 1);
  const bracketAt2500 = suggestions.find((entry) => entry.load === 2500);
  assert.equal(bracketAt2500.mpeInE, 0.5);
});

test('eccentricity load uses 1/3 of Max, or 1/(n-1) for more than four supports', () => {
  assert.equal(eccentricityLoad(instrument(), rules).load, 5000);
  assert.equal(eccentricityLoad(instrument({ loadReceptorSupportPoints: 8 }), rules).load, 2145);
});

test('unit helpers convert between mg, g, kg and t', () => {
  assert.equal(toGrams(2.5, 'kg'), 2500);
  assert.equal(convert(1, 't', 'kg'), 1000);
  assert.equal(toGrams(1500, 'mg'), 1.5);
  assert.throws(() => toGrams(1, 'furlongs'), /Unsupported mass unit/);
});
