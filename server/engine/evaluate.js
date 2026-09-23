// Test-record evaluation.
//
// Takes a stored test record (instrument snapshot + environmental conditions +
// raw observations), runs every module through the metrology core, and returns
// everything a report needs: per-point derivations, per-module verdicts, the
// overall compliance verdict, and an integrity hash over the source data.

const { loadRules, listTestModules, getTestModule, mpeForLoad } = require('./rules');
const { MODULE_EVALUATORS, evaluateDiscrimination } = require('./metrology');
const { validateTestRecord } = require('./validate');
const { stableStringify, sha256 } = require('../util');

// Modules a complete type-evaluation record is expected to contain. Missing
// modules are reported as coverage gaps rather than failures.
const EXPECTED_MODULES = [
  'weighing_test',
  'eccentricity_test',
  'repeatability_test',
  'zero_setting_test',
];

/**
 * SHA-256 over the frozen source data of a test. Any later edit to an
 * instrument parameter or an observation changes this hash, which is printed on
 * the report so a reviewer can detect tampering.
 */
function integrityHash(record, rulesRevision) {
  const payload = {
    instrument: record.instrument || null,
    environmental: record.environmental || null,
    modules: record.modules || null,
    ruleRevision: rulesRevision,
    standard: 'OIML R 76-2',
  };
  return sha256(payload);
}

/** Public classification + MPE tables for the instrument, for the report header. */
function buildRuleView(instrument, rules) {
  const classKey = String(instrument.accuracyClass || '').trim().toUpperCase().replace(/^CLASS\s*/, '');
  const definition = rules.classes[classKey];
  if (!definition) return null;

  const band = definition.bands.find((candidate) => {
    const eGrams = instrument.e * (instrument.unit === 'kg' ? 1000 : instrument.unit === 'mg' ? 0.001 : instrument.unit === 't' ? 1e6 : 1);
    const aboveMin = eGrams >= candidate.eMinGrams - 1e-12;
    const belowMax = candidate.eMaxGrams === null || eGrams <= candidate.eMaxGrams + 1e-12;
    return aboveMin && belowMax;
  }) || definition.bands[0];

  return {
    className: classKey,
    classTitle: definition.title,
    band,
    mpeTable: band.mpeBrackets.map((bracket) => ({
      mpeInE: bracket.mpeInE,
      upToInE: bracket.upToInE,
      mpe: bracket.mpeInE * instrument.e,
    })),
  };
}

/**
 * Evaluate a test record.
 * @param {object} record  { testId, instrument, environmental, modules }
 * @param {{ rules?: object, rulesRevision?: string }} [options]
 */
function evaluateTest(record = {}, options = {}) {
  const rules = options.rules || loadRules();
  const instrument = record.instrument || {};
  const modules = record.modules || {};
  const validation = validateTestRecord(record, rules);
  const moduleDefinitions = listTestModules(rules);

  const evaluatedModules = moduleDefinitions.map((definition) => {
    const observations = modules[definition.id];
    const evaluator = MODULE_EVALUATORS[definition.id];

    if (!observations || !Object.keys(observations).length) {
      return {
        moduleId: definition.id,
        title: definition.title,
        clause: definition.clause,
        status: 'not_tested',
        points: [],
        checks: [],
        failedPoints: 0,
        failedChecks: 0,
      };
    }

    if (!evaluator) {
      return {
        moduleId: definition.id,
        title: definition.title,
        clause: definition.clause,
        status: 'incomplete',
        points: [],
        checks: [],
        failedPoints: 0,
        failedChecks: 0,
        note: 'No evaluator is registered for this module.',
      };
    }

    let result;
    try {
      result = evaluator(observations, { instrument, rules, inService: Boolean(record.inService) });
    } catch (error) {
      return {
        moduleId: definition.id,
        title: definition.title,
        clause: definition.clause,
        status: 'incomplete',
        points: [],
        checks: [],
        failedPoints: 0,
        failedChecks: 0,
        note: error.message,
      };
    }

    return { ...result, title: definition.title, clause: definition.clause };
  });

  const discriminationCheck = evaluateDiscrimination(record.discrimination || {}, { instrument, rules });

  const tested = evaluatedModules.filter((module) => module.status !== 'not_tested');
  const failed = tested.filter((module) => module.status === 'fail');
  const missing = EXPECTED_MODULES.filter(
    (moduleId) => !tested.some((module) => module.moduleId === moduleId),
  );

  // "Nothing recorded yet" is a normal draft state, not an invalid record, so
  // the missing-observations finding is not treated as a data problem here.
  const blockingErrors = validation.errors.filter((error) => error.code !== 'no_modules');

  let verdict;
  if (blockingErrors.length) verdict = 'invalid';
  else if (!tested.length) verdict = 'incomplete';
  else if (failed.length) verdict = 'fail';
  else verdict = 'pass';

  const testId = record.testId || record.id || null;
  const rulesRevision = options.rulesRevision || record.rulesRevision || rules.revision;

  return {
    testId,
    reportNumber: record.reportNumber || null,
    evaluatedAt: new Date().toISOString(),
    standard: rules.standard,
    reportFormat: rules.reportFormat,
    rulesRevision,
    instrument: {
      ...instrument,
      classTitle: buildRuleView(instrument, rules)?.classTitle || null,
    },
    laboratory: record.laboratory || null,
    environmental: record.environmental || null,
    classification: validation.classification,
    ruleView: buildRuleView(instrument, rules),
    modules: evaluatedModules,
    discrimination: discriminationCheck,
    summary: {
      verdict,
      blockingFindings: blockingErrors.length,
      modulesTested: tested.length,
      modulesPassed: tested.filter((module) => module.status === 'pass').length,
      modulesFailed: failed.length,
      modulesNotTested: evaluatedModules.length - tested.length,
      pointsEvaluated: tested.reduce((total, module) => total + module.points.length, 0),
      pointsFailed: tested.reduce((total, module) => total + module.failedPoints, 0),
      checksFailed: tested.reduce((total, module) => total + module.failedChecks, 0),
      expectedModulesMissing: missing,
      coverageComplete: missing.length === 0,
      inService: Boolean(record.inService),
    },
    validation,
    integrityHash: integrityHash(record, rulesRevision),
  };
}

/**
 * Flatten an evaluation into rows for the report tables.
 * Each row is one observation with its derivation, so the printed report shows
 * the same working a reviewer would reproduce by hand.
 */
function reportRows(evaluation) {
  return evaluation.modules
    .filter((module) => module.status !== 'not_tested')
    .map((module) => ({
      moduleId: module.moduleId,
      title: module.title,
      clause: module.clause,
      status: module.status,
      points: module.points.map((point) => ({
        label: point.label,
        load: point.load ?? null,
        indication: point.indication ?? null,
        additionalLoad: point.additionalLoad ?? 0,
        preRoundingIndication: point.preRoundingIndication ?? null,
        error: point.error ?? null,
        correctedError: point.correctedError ?? null,
        errorInE: point.errorInE ?? (Number.isFinite(point.comparedValueInE) ? point.comparedValueInE : null),
        mpe: point.mpe ?? null,
        mpeInE: point.mpeInE ?? null,
        marginInE: point.marginInE ?? null,
        pass: point.pass,
      })),
      checks: module.checks || [],
    }));
}

/** Absolute MPE for one load, exposed for API clients and the UI. */
function mpeAt(instrument, load, { inService = false, rules = loadRules() } = {}) {
  return mpeForLoad({
    accuracyClass: instrument.accuracyClass,
    e: instrument.e,
    eUnit: instrument.unit,
    load,
    loadUnit: instrument.unit,
    inService,
    rules,
  });
}

function moduleDefinition(moduleId, rules = loadRules()) {
  return getTestModule(rules, moduleId);
}

module.exports = {
  EXPECTED_MODULES,
  stableStringify,
  integrityHash,
  evaluateTest,
  reportRows,
  mpeAt,
  moduleDefinition,
  buildRuleView,
};
