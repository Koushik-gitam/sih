#!/usr/bin/env node
// Seed the repository with representative test records.
//
//   npm run seed            keep existing records
//   npm run seed -- --force delete existing records first
//
// The records are built with the engine's own load planner, so the observation
// sets exercise every MPE bracket of each instrument's class.

const { config, ensureDirs } = require('../server/config');
const { store } = require('../server/store');
const auth = require('../server/auth');
const { loadRules } = require('../server/engine/rules');
const { evaluateTest } = require('../server/engine/evaluate');

const rules = loadRules();

function actor(user) {
  return { id: user.id, username: user.username, role: user.role };
}

/** Load points that step through every bracket boundary, with passing indications. */
function weighingPoints(instrument) {
  const e = instrument.e;
  const max = instrument.maxCapacity;
  const min = instrument.minCapacity;

  const candidates = [min, max / 4, max / 2, max];

  const classKey = String(instrument.accuracyClass).toUpperCase();
  const definition = rules.classes[classKey];
  const band = definition.bands.find((candidate) => candidate.eMaxGrams === null || candidate.eMinGrams <= candidate.eMinGrams) || definition.bands[0];
  const eGrams = instrument.unit === 'kg' ? e * 1000 : instrument.unit === 't' ? e * 1e6 : e;
  const applicable = definition.bands.find(
    (candidate) => eGrams >= candidate.eMinGrams - 1e-12 && (candidate.eMaxGrams === null || eGrams <= candidate.eMaxGrams + 1e-12),
  ) || band;

  applicable.mpeBrackets.forEach((bracket) => {
    if (bracket.upToInE === null) return;
    candidates.push(bracket.upToInE * e);
    candidates.push(bracket.upToInE * e + e);
  });

  const loads = [...new Set(candidates.map((load) => Math.round(load / e) * e))]
    .filter((load) => load >= min - 1e-9 && load <= max + 1e-9)
    .sort((a, b) => a - b);

  return loads;
}

function makeRecord({ instrument, laboratory, environmental, moduleOverrides = {}, failAt = null }) {
  const loads = weighingPoints(instrument);
  const e = instrument.e;

  const points = loads.map((load) => ({
    load,
    // An indication equal to the load with no sub-weight means a true error of
    // +0.5 e, which is inside the MPE in every bracket.
    indication: load === failAt ? load + 2 * e : load,
    additionalLoad: 0,
    direction: 'increasing',
  }));

  // Return in the reverse direction to complete the A.4.4.1 sequence.
  const decreasing = [...points]
    .reverse()
    .slice(0, Math.min(3, points.length))
    .map((point) => ({ ...point, direction: 'decreasing' }));

  // Repeatability sits at half of Max, where the MPE has real headroom: at a
  // bracket boundary the MPE is only 0.5 e, so a half-interval spread would be
  // the most the instrument could show and still conform.
  const repeatabilityLoad = Math.round(instrument.maxCapacity / 2 / e) * e;

  // The eccentricity offsets are kept to half an interval so that the test is
  // meaningful for every class (at 1/3 of Max on a class IIII instrument the
  // MPE is still only 0.5 e).
  const eccentricityTestLoad = Math.round(instrument.maxCapacity / 3 / e) * e;

  const modules = {
    weighing_test: { points: [...points, ...decreasing] },
    repeatability_test: {
      sets: [
        {
          load: repeatabilityLoad,
          readings: [repeatabilityLoad, repeatabilityLoad, repeatabilityLoad + e / 2],
        },
      ],
    },
    eccentricity_test: {
      load: eccentricityTestLoad,
      centre: { indication: eccentricityTestLoad, additionalLoad: 0 },
      points: [
        { position: 'front-left', indication: eccentricityTestLoad, additionalLoad: 0 },
        { position: 'front-right', indication: eccentricityTestLoad + e / 2, additionalLoad: 0 },
        { position: 'rear-left', indication: eccentricityTestLoad, additionalLoad: 0 },
        { position: 'rear-right', indication: eccentricityTestLoad - e / 2, additionalLoad: 0 },
      ],
    },
    zero_setting_test: {
      initialZeroLoad: Math.round((instrument.maxCapacity * 0.05) / e) * e,
      zeroError: 0,
      trackingDeviation: e / 2,
    },
    ...moduleOverrides,
  };

  if (instrument.nominalVoltage) {
    modules.power_supply_test = {
      nominalVoltage: instrument.nominalVoltage,
      points: [
        { voltage: instrument.nominalVoltage * 0.85, load: Math.round(instrument.maxCapacity / 2 / e) * e, indication: Math.round(instrument.maxCapacity / 2 / e) * e, additionalLoad: 0 },
        { voltage: instrument.nominalVoltage * 1.1, load: Math.round(instrument.maxCapacity / 2 / e) * e, indication: Math.round(instrument.maxCapacity / 2 / e) * e, additionalLoad: 0 },
      ],
    };
  }

  const record = {
    instrument,
    laboratory,
    environmental,
    modules,
  };

  return { record, loads };
}

const laboratory = {
  name: 'Regional Reference Standard Laboratory',
  labCode: 'RRSL-AND-01',
  address: 'Ahmedabad, Gujarat',
};

const baseEnvironment = {
  ambientTemperatureCelsius: 24.5,
  relativeHumidityPercent: 56,
  barometricPressureKpa: 101.1,
  testDate: new Date().toISOString().slice(0, 10),
  testedBy: 'technician',
  standardWeights: 'OIML F1 class test weights, 1 mg to 20 kg',
  weightsTraceability: 'Traceable to CSIR-NPL, certificate NPL/2026/1187',
};

const CASES = [
  {
    label: 'Class III bench scale, conforming',
    instrument: {
      manufacturer: 'Bharat Weighing Systems', model: 'BWS-15K', serialNumber: 'BWS15-2026-0142',
      accuracyClass: 'III', unit: 'kg', maxCapacity: 15, minCapacity: 0.1, e: 0.005, d: 0.005,
      loadReceptorSupportPoints: 4, instrumentType: 'single_interval',
      temperatureRange: { min: -10, max: 40 }, nominalVoltage: 230,
      modelApprovalReference: 'Applied for - DoCA/MA/2026/0331',
    },
    status: 'approved',
  },
  {
    label: 'Class III weighbridge, non-conforming weighing test',
    instrument: {
      manufacturer: 'Indus Weighbridge Co.', model: 'IWB-60T', serialNumber: 'IWB60-2026-0007',
      accuracyClass: 'III', unit: 'kg', maxCapacity: 60000, minCapacity: 400, e: 20, d: 20,
      loadReceptorSupportPoints: 8, instrumentType: 'single_interval',
      temperatureRange: { min: -10, max: 40 }, nominalVoltage: 230,
      modelApprovalReference: 'DoCA/MA/2025/0912',
    },
    status: 'submitted',
    failAtFraction: 0.5,
  },
  {
    label: 'Class II laboratory balance, conforming',
    instrument: {
      manufacturer: 'Precision Labs GmbH', model: 'PL-500S', serialNumber: 'PL500S-8891',
      accuracyClass: 'II', unit: 'g', maxCapacity: 500, minCapacity: 0.2, e: 0.01, d: 0.01,
      loadReceptorSupportPoints: 4, instrumentType: 'single_interval',
      temperatureRange: { min: 10, max: 30 }, nominalVoltage: 230,
      modelApprovalReference: 'DoCA/MA/2026/0017',
    },
    status: 'approved',
  },
  {
    label: 'Class IIII platform scale, conforming',
    instrument: {
      manufacturer: 'Gramin Scales Pvt Ltd', model: 'GS-1000', serialNumber: 'GS1000-2261',
      // Class IIII needs n = Max / e >= 100, so e = 10 kg for a 1000 kg platform.
      accuracyClass: 'IIII', unit: 'kg', maxCapacity: 1000, minCapacity: 100, e: 10, d: 10,
      loadReceptorSupportPoints: 4, instrumentType: 'single_interval',
      temperatureRange: { min: -10, max: 40 },
      modelApprovalReference: 'DoCA/MA/2026/0188',
    },
    status: 'draft',
  },
];

/**
 * Create the demonstration repository.
 *
 * Safe to call repeatedly: when records already exist and `force` is not set it
 * does nothing. Exported so that a serverless cold start can populate a fresh
 * runtime directory without shelling out to this script.
 *
 * @param {{ force?: boolean, quiet?: boolean }} [options]
 */
function seedDemo({ force = false, quiet = false } = {}) {
  const log = quiet ? () => {} : (...args) => console.log(...args);

  ensureDirs();
  auth.seedDefaultUsers();

  const technician = store.findUserByUsername('technician');
  const manager = store.findUserByUsername('manager');
  const auditor = store.findUserByUsername('auditor');

  const existing = store.listTests();
  if (existing.length && !force) {
    log(`${existing.length} test records already exist. Re-run with "--force" to replace them.`);
    return { created: 0, skipped: existing.length, dataDir: config.dataDir };
  }

  if (existing.length && force) {
    existing.forEach((test) => store.deleteTest(test.id, actor(auditor)));
    log(`Removed ${existing.length} existing test records.`);
  }

let created = 0;

CASES.forEach((entry, index) => {
  const e = entry.instrument.e;
  const failAt = entry.failAtFraction
    ? Math.round((entry.instrument.maxCapacity * entry.failAtFraction) / e) * e
    : null;

  const { record, loads } = makeRecord({
    instrument: entry.instrument,
    laboratory,
    environmental: { ...baseEnvironment, testedBy: technician.username, testDate: new Date(Date.now() - index * 86400000).toISOString().slice(0, 10) },
    failAt,
  });

  const test = store.createTest(record, actor(technician));
  const evaluation = evaluateTest({ ...record, testId: test.id, reportNumber: test.reportNumber }, { rules });
  store.recordEvaluation(test.id, evaluation, actor(technician));
  store.addSignature(test.id, {
    meaning: 'tested', by: actor(technician), name: technician.name, role: technician.role,
    at: new Date().toISOString(), hash: evaluation.integrityHash,
  }, actor(technician));

  if (entry.status === 'submitted' || entry.status === 'approved') {
    store.setStatus(test.id, 'submitted', actor(technician), { note: 'Submitted for review' });
  }
  if (entry.status === 'approved') {
    store.addSignature(test.id, {
      meaning: 'approved', by: actor(manager), name: manager.name, role: manager.role,
      at: new Date().toISOString(), hash: evaluation.integrityHash,
    }, actor(manager));
    store.setStatus(test.id, 'approved', actor(manager), { note: 'Approved after review of the audit trail' });
  }

  created += 1;
  log(
    `${test.reportNumber}  ${evaluation.summary.verdict.toUpperCase().padEnd(10)} ${entry.label}` +
      `  (${loads.length} load points, ${evaluation.summary.pointsFailed} outside tolerance)`,
  );
});

  log(`\nSeeded ${created} test records into ${config.dataDir}`);

  const chain = store.verifyAuditChain();
  log(`Audit ledger: ${chain.entries} entries, chain ${chain.valid ? 'verified' : 'BROKEN'}`);

  return { created, skipped: 0, dataDir: config.dataDir, audit: { entries: chain.entries, valid: chain.valid } };
}

if (require.main === module) {
  const summary = seedDemo({ force: process.argv.includes('--force') });
  if (summary.skipped) process.exit(0);
}

module.exports = { seedDemo, weighingPoints, CASES };
