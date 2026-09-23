// Metrological calculation core - OIML R 76.
//
// Every function here is pure: it takes observations plus instrument data and
// returns numbers and verdicts. No file system, no network, no database. That
// keeps the maths independently testable (see tests/engine.test.js) and lets the
// same code run in the browser for offline field use.
//
// Numerical conventions
// ---------------------
// * `e` is the verification scale interval, `d` the actual scale interval, both
//   in the instrument's working unit (mg, g, kg or t).
// * `load` (L) and `indication` (I) are in that same unit.
// * `additionalLoad` (dL) is the change-over sub-weight (typically 1/10 e) that
//   was added to make the indication step up by one interval.
// * Errors are reported both in the working unit and in intervals of e, because
//   OIML R 76 expresses every tolerance in e.

const { mpeForLoad, loadRules } = require('./rules');
const { decimalsForStep } = require('./units');

/** Guard against floating-point noise at exact bracket boundaries. */
const EPS = 1e-9;

function round(value, decimals) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Round a value to a sensible number of decimals for a given scale interval.
 * Two extra decimals are kept so that limits expressed as fractions of e
 * (0.25 e, 0.5 e, 1.5 e) are displayed exactly rather than as 1.3 g instead of
 * 1.25 g.
 */
function roundToStep(value, step) {
  return round(value, Math.min(12, decimalsForStep(step) + 2));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Sample standard deviation (n-1), the form used in repeatability reporting. */
function standardDeviation(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((total, value) => total + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// ---------------------------------------------------------------------------
// Error determination (OIML R 76-1 A.4.4.3)
// ---------------------------------------------------------------------------

/**
 * Indication prior to rounding: P = I + 0.5e - dL.
 */
function preRoundingIndication({ indication, e, additionalLoad = 0 }) {
  return indication + 0.5 * e - additionalLoad;
}

/**
 * Error before correction: E = P - L = I + 0.5e - dL - L.
 */
function errorBeforeCorrection({ indication, load, e, additionalLoad = 0 }) {
  const P = preRoundingIndication({ indication, e, additionalLoad });
  return { P, E: P - load };
}

/**
 * Corrected error: Ec = E - E0, where E0 is the error at zero (or near zero,
 * e.g. 10 e).
 */
function correctedError({ indication, load, e, additionalLoad = 0, zeroError = 0 }) {
  const { P, E } = errorBeforeCorrection({ indication, load, e, additionalLoad });
  return { P, E, Ec: E - zeroError };
}

/**
 * Evaluate a single load point against the MPE table.
 * Returns the full derivation so the report can show the working.
 */
function evaluateLoadPoint(point, context) {
  const { instrument, rules, inService = false, label, extra = {} } = context;
  const e = instrument.e;
  const load = Number(point.load);
  const indication = Number(point.indication);
  const additionalLoad = Number(point.additionalLoad || 0);
  const zeroError = Number(point.zeroError || 0);

  const { P, E, Ec } = correctedError({
    indication,
    load,
    e,
    additionalLoad,
    zeroError,
  });

  const mpeInfo = mpeForLoad({
    accuracyClass: instrument.accuracyClass,
    e,
    eUnit: instrument.unit,
    load,
    loadUnit: instrument.unit,
    inService,
    rules,
  });

  const tolerance = Math.max(EPS, Math.abs(Ec) * 1e-12);
  const absoluteError = Math.abs(Ec);
  const pass = absoluteError <= mpeInfo.mpe + tolerance;
  const decimals = Math.min(9, decimalsForStep(e) + 2);

  return {
    label: label || `${load} ${instrument.unit}`,
    load,
    indication,
    additionalLoad,
    zeroError,
    preRoundingIndication: roundToStep(P, e),
    error: roundToStep(E, e),
    correctedError: roundToStep(Ec, e),
    errorInE: round(Ec / e, 6),
    loadInE: round(mpeInfo.loadInE, 4),
    mpe: roundToStep(mpeInfo.mpe, e),
    mpeInE: mpeInfo.mpeInE,
    margin: roundToStep(mpeInfo.mpe - absoluteError, e),
    marginInE: round((mpeInfo.mpe - absoluteError) / e, 6),
    errorDecimals: decimals,
    pass,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Module evaluators
// ---------------------------------------------------------------------------

function summariseModule(moduleId, points, checks, extra = {}) {
  const failedPoints = points.filter((point) => point.pass === false);
  const failedChecks = (checks || []).filter((check) => check.pass === false);
  const hasObservations = points.length > 0 || (checks || []).length > 0;

  let status = 'incomplete';
  if (hasObservations) {
    status = failedPoints.length || failedChecks.length ? 'fail' : 'pass';
  }

  return {
    moduleId,
    status,
    points,
    checks: checks || [],
    failedPoints: failedPoints.length,
    failedChecks: failedChecks.length,
    ...extra,
  };
}

/** Weighing performance test - errors at increasing and decreasing loads. */
function evaluateWeighingTest(observations = {}, context) {
  const points = Array.isArray(observations.points) ? observations.points : [];
  const zeroError = Number(observations.zeroError || 0);

  const evaluated = points.map((point, index) =>
    evaluateLoadPoint(
      { ...point, zeroError },
      {
        ...context,
        label: `${point.load} ${context.instrument.unit}${point.direction ? ` (${point.direction})` : ''}`,
        extra: { direction: point.direction || null, index },
      },
    ),
  );

  return summariseModule('weighing_test', evaluated, [], {
    increasing: evaluated.filter((point) => point.direction !== 'decreasing').length,
    decreasing: evaluated.filter((point) => point.direction === 'decreasing').length,
  });
}

/**
 * Repeatability test (3.6.1): the difference between the results of repeated
 * weighings of the same load shall not exceed the absolute MPE for that load.
 */
function evaluateRepeatabilityTest(observations = {}, context) {
  const sets = Array.isArray(observations.sets)
    ? observations.sets
    : observations.load
      ? [{ load: observations.load, readings: observations.readings || [] }]
      : [];

  const points = [];
  const checks = [];

  sets.forEach((set, index) => {
    const readings = (set.readings || []).map(Number).filter(Number.isFinite);
    if (readings.length < 2) {
      points.push({
        label: `Set ${index + 1}`,
        load: set.load,
        readings,
        pass: false,
        incomplete: true,
        reason: 'At least two readings are required for a repeatability determination.',
      });
      return;
    }

    const mpeInfo = mpeForLoad({
      accuracyClass: context.instrument.accuracyClass,
      e: context.instrument.e,
      eUnit: context.instrument.unit,
      load: Number(set.load),
      loadUnit: context.instrument.unit,
      inService: context.inService,
      rules: context.rules,
    });

    const range = Math.max(...readings) - Math.min(...readings);
    const sigma = standardDeviation(readings);
    const limit = mpeInfo.mpe;
    const pass = range <= limit + EPS;
    const e = context.instrument.e;

    points.push({
      label: `Load ${set.load} ${context.instrument.unit}`,
      load: Number(set.load),
      readings,
      mean: roundToStep(mean(readings), e),
      range: roundToStep(range, e),
      rangeInE: round(range / e, 6),
      standardDeviation: roundToStep(sigma, e),
      standardDeviationInE: round(sigma / e, 6),
      mpe: roundToStep(limit, e),
      mpeInE: mpeInfo.mpeInE,
      marginInE: round((limit - range) / e, 6),
      pass,
    });
  });

  return summariseModule('repeatability_test', points, checks, {
    criterion: 'range of results <= absolute MPE for the load (OIML R 76-1 3.6.1)',
  });
}

/**
 * Eccentricity test (3.6.2). When a centre reading is supplied the criterion is
 * the difference between the error at each position and the error at the centre;
 * otherwise each position is checked directly against the MPE.
 */
function evaluateEccentricityTest(observations = {}, context) {
  const e = context.instrument.e;
  const unit = context.instrument.unit;
  const load = Number(observations.load);
  const zeroError = Number(observations.zeroError || 0);
  const positions = Array.isArray(observations.points) ? observations.points : [];

  const mpeInfo = mpeForLoad({
    accuracyClass: context.instrument.accuracyClass,
    e,
    eUnit: unit,
    load,
    loadUnit: unit,
    inService: context.inService,
    rules: context.rules,
  });

  let centreError = null;
  if (observations.centre && Number.isFinite(Number(observations.centre.indication))) {
    centreError = correctedError({
      indication: Number(observations.centre.indication),
      load,
      e,
      additionalLoad: Number(observations.centre.additionalLoad || 0),
      zeroError,
    }).Ec;
  }

  const points = positions.map((position) => {
    const { Ec } = correctedError({
      indication: Number(position.indication),
      load,
      e,
      additionalLoad: Number(position.additionalLoad || 0),
      zeroError,
    });

    const compared = centreError === null ? Ec : Ec - centreError;
    const pass = Math.abs(compared) <= mpeInfo.mpe + EPS;

    return {
      label: position.position || 'position',
      position: position.position || null,
      load,
      indication: Number(position.indication),
      additionalLoad: Number(position.additionalLoad || 0),
      correctedError: roundToStep(Ec, e),
      differenceFromCentre: centreError === null ? null : roundToStep(compared, e),
      comparedValueInE: round(compared / e, 6),
      mpe: roundToStep(mpeInfo.mpe, e),
      mpeInE: mpeInfo.mpeInE,
      marginInE: round((mpeInfo.mpe - Math.abs(compared)) / e, 6),
      pass,
    };
  });

  return summariseModule('eccentricity_test', points, [], {
    load,
    mpe: roundToStep(mpeInfo.mpe, e),
    mpeInE: mpeInfo.mpeInE,
    centreError: centreError === null ? null : roundToStep(centreError, e),
    criterion:
      centreError === null
        ? 'each position shall meet the MPE (OIML R 76-1 3.6.2)'
        : 'difference from the centre reading shall meet the MPE (OIML R 76-1 3.6.2)',
  });
}

/** Zero-setting, zero-accuracy and zero-tracking (4.5). */
function evaluateZeroTest(observations = {}, context) {
  const e = context.instrument.e;
  const unit = context.instrument.unit;
  const rules = context.rules;
  const settings = rules.zeroSetting;
  const points = [];
  const checks = [];

  if (Number.isFinite(Number(observations.initialZeroLoad))) {
    const initialLoad = Number(observations.initialZeroLoad);
    const limit = (settings.initialZeroSettingMaxPercentOfMax / 100) * context.instrument.maxCapacity;
    const pass = Math.abs(initialLoad) <= limit + EPS;
    checks.push({
      id: 'initial_zero_range',
      label: 'Initial zero-setting range',
      criterion: `<= ${settings.initialZeroSettingMaxPercentOfMax}% of Max (OIML R 76-1 4.5.1)`,
      value: roundToStep(initialLoad, e),
      limit: roundToStep(limit, e),
      unit,
      pass,
    });
  }

  if (Number.isFinite(Number(observations.zeroError))) {
    const zeroError = Number(observations.zeroError);
    const limit = settings.accuracyE * e;
    checks.push({
      id: 'zero_accuracy',
      label: 'Zero-setting accuracy',
      criterion: `|E0| <= ${settings.accuracyE} e (OIML R 76-1 4.5.2)`,
      value: roundToStep(zeroError, e),
      valueInE: round(zeroError / e, 6),
      limit: roundToStep(limit, e),
      unit,
      pass: Math.abs(zeroError) <= limit + EPS,
    });
  }

  if (Number.isFinite(Number(observations.trackingDeviation))) {
    const deviation = Number(observations.trackingDeviation);
    const limit = (settings.trackingMaxDeviationE || 0.5) * e;
    checks.push({
      id: 'zero_tracking',
      label: 'Automatic zero-tracking deviation',
      criterion: `|deviation| <= ${settings.trackingMaxDeviationE || 0.5} e (OIML R 76-1 3.9.4 / 4.5)`,
      value: roundToStep(deviation, e),
      valueInE: round(deviation / e, 6),
      limit: roundToStep(limit, e),
      unit,
      pass: Math.abs(deviation) <= limit + EPS,
    });
  }

  return summariseModule('zero_setting_test', points, checks);
}

/** Tare device accuracy plus MPE applied to net values (3.5.3.4, 4.6). */
function evaluateTareTest(observations = {}, context) {
  const e = context.instrument.e;
  const unit = context.instrument.unit;
  const rules = context.rules;
  const points = [];
  const checks = [];

  if (Number.isFinite(Number(observations.indicationAfterTare))) {
    // With the tare device set, a zero indication is the target. The residual is
    // read through the change-over point like any other error determination.
    const residual = preRoundingIndication({
      indication: Number(observations.indicationAfterTare),
      e,
      additionalLoad: Number(observations.additionalLoad || 0),
    });
    const limit = rules.tare.accuracyE * e;

    checks.push({
      id: 'tare_accuracy',
      label: 'Tare device accuracy',
      criterion: `|residual| <= ${rules.tare.accuracyE} e (OIML R 76-1 4.6.3)`,
      value: roundToStep(residual, e),
      valueInE: round(residual / e, 6),
      limit: roundToStep(limit, e),
      unit,
      pass: Math.abs(residual) <= limit + EPS,
    });
  }

  const netPoints = Array.isArray(observations.netPoints) ? observations.netPoints : [];
  const zeroError = Number(observations.zeroError || 0);
  netPoints.forEach((point) => {
    points.push(
      evaluateLoadPoint(
        { ...point, zeroError },
        {
          ...context,
          label: `Net ${point.load} ${unit}${Number(observations.tareLoad) ? ` (tare ${observations.tareLoad} ${unit})` : ''}`,
        },
      ),
    );
  });

  return summariseModule('tare_test', points, checks, {
    tareLoad: observations.tareLoad ?? null,
    criterion: 'MPE apply to the net value for every possible tare load (OIML R 76-1 3.5.3.4)',
  });
}

/** Temperature influence: error at each temperature vs MPE, plus zero drift. */
function evaluateTemperatureTest(observations = {}, context) {
  const e = context.instrument.e;
  const unit = context.instrument.unit;
  const rules = context.rules;
  const points = [];
  const checks = [];
  const zeroError = Number(observations.zeroError || 0);
  const pointsRaw = Array.isArray(observations.points) ? observations.points : [];

  const evaluated = pointsRaw.map((point) =>
    evaluateLoadPoint(
      { ...point, zeroError },
      {
        ...context,
        label: `${point.temperatureCelsius} °C @ ${point.load} ${unit}`,
        extra: { temperatureCelsius: Number(point.temperatureCelsius) },
      },
    ),
  );

  evaluated.forEach((point, index) => {
    if (
      index === 0 &&
      Number.isFinite(point.temperatureCelsius) &&
      point.load <= 10 * e &&
      evaluated.length > 1
    ) {
      const last = evaluated[evaluated.length - 1];
      const deltaT = Math.abs(last.temperatureCelsius - point.temperatureCelsius);
      if (deltaT > EPS) {
        const driftPerStep = Math.abs(last.correctedError - point.correctedError) / deltaT;
        const perCelsius = rules.temperature.zeroDriftPerCelsius[context.instrument.accuracyClass] || 5;
        const allowed = e / perCelsius;
        checks.push({
          id: 'temperature_zero_drift',
          label: 'Zero indication drift with temperature',
          criterion: `<= 1 e per ${perCelsius} °C (OIML R 76-1 3.9.2.3)`,
          value: roundToStep(driftPerStep * perCelsius, e),
          valueInE: round((driftPerStep * perCelsius) / e, 6),
          limit: roundToStep(e, e),
          limitInE: 1,
          unit,
          pass: driftPerStep <= allowed + EPS,
        });
      }
    }
    points.push(point);
  });

  return summariseModule('temperature_test', points, checks, {
    criterion: 'error at every test temperature shall not exceed the MPE for the applied load (3.9.2)',
  });
}

/** Power supply (voltage) influence (3.9.3). */
function evaluatePowerSupplyTest(observations = {}, context) {
  const e = context.instrument.e;
  const unit = context.instrument.unit;
  const rules = context.rules;
  const points = [];
  const checks = [];
  const zeroError = Number(observations.zeroError || 0);
  const nominalVoltage = Number(observations.nominalVoltage) || context.instrument.nominalVoltage || null;

  const rawPoints = Array.isArray(observations.points) ? observations.points : [];

  rawPoints.forEach((point) => {
    let factor = Number(point.voltageFactor);
    if (!Number.isFinite(factor) && nominalVoltage && Number.isFinite(Number(point.voltage))) {
      factor = Number(point.voltage) / nominalVoltage;
    }

    if (Number.isFinite(factor)) {
      const withinLimits =
        factor >= rules.powerSupply.mainsLowerFactor - EPS &&
        factor <= rules.powerSupply.mainsUpperFactor + EPS;
      checks.push({
        id: `voltage_range_${points.length + checks.length}`,
        label: `Voltage ${factor.toFixed(3)} × Unom`,
        criterion: `${rules.powerSupply.mainsLowerFactor}–${rules.powerSupply.mainsUpperFactor} × Unom (OIML R 76-1 3.9.3)`,
        value: factor,
        unit: '× Unom',
        pass: withinLimits,
      });
    }

    points.push(
      evaluateLoadPoint(
        { ...point, zeroError },
        {
          ...context,
          label: `${Number.isFinite(factor) ? `${factor.toFixed(2)} × Unom` : 'voltage point'} @ ${point.load} ${unit}`,
          extra: { voltageFactor: Number.isFinite(factor) ? factor : null },
        },
      ),
    );
  });

  return summariseModule('power_supply_test', points, checks, {
    nominalVoltage,
    criterion: 'error at every voltage shall not exceed the MPE for the applied load (3.9.3)',
  });
}

/** Creep while loaded, and deviation on returning to zero (3.9.4). */
function evaluateCreepTest(observations = {}, context) {
  const e = context.instrument.e;
  const unit = context.instrument.unit;
  const rules = context.rules;
  const points = [];
  const checks = [];
  const rawPoints = (Array.isArray(observations.points) ? observations.points : [])
    .map((point) => ({
      elapsedMinutes: Number(point.elapsedMinutes),
      indication: Number(point.indication),
    }))
    .filter((point) => Number.isFinite(point.elapsedMinutes) && Number.isFinite(point.indication))
    .sort((a, b) => a.elapsedMinutes - b.elapsedMinutes);

  if (rawPoints.length >= 2) {
    const first = rawPoints.find((point) => point.elapsedMinutes >= 1) || rawPoints[0];
    const deviation = Math.abs(
      rawPoints[rawPoints.length - 1].indication - first.indication,
    );
    const limit = rules.creep.maxDeviationE * e;
    checks.push({
      id: 'creep_deviation',
      label: 'Deviation of indication while loaded',
      criterion: `<= ${rules.creep.maxDeviationE} e after ${rules.creep.observationMinutes} min (OIML R 76-1 3.9.4)`,
      value: roundToStep(deviation, e),
      valueInE: round(deviation / e, 6),
      limit: roundToStep(limit, e),
      unit,
      pass: deviation <= limit + EPS,
    });

    points.push({
      label: `Load ${observations.load} ${unit}`,
      load: Number(observations.load),
      readings: rawPoints,
      observedDeviation: roundToStep(deviation, e),
      deviationInE: round(deviation / e, 6),
      limit: roundToStep(limit, e),
      pass: deviation <= limit + EPS,
    });
  }

  if (Number.isFinite(Number(observations.returnToZeroIndication))) {
    const deviation = Math.abs(Number(observations.returnToZeroIndication));
    const limit = rules.creep.maxDeviationE * e;
    checks.push({
      id: 'return_to_zero',
      label: 'Deviation on returning to zero',
      criterion: `<= ${rules.creep.maxDeviationE} e (OIML R 76-1 3.9.4)`,
      value: roundToStep(deviation, e),
      valueInE: round(deviation / e, 6),
      limit: roundToStep(limit, e),
      unit,
      pass: deviation <= limit + EPS,
    });
  }

  return summariseModule('creep_test', points, checks, {
    load: observations.load ?? null,
  });
}

/** Discrimination check (3.8): gentle addition of 1.4 d must step one interval. */
function evaluateDiscrimination(observation = {}, context) {
  const d = Number(context.instrument.d || context.instrument.e);
  const rules = context.rules;
  const required = rules.discrimination.gentleAdditionalLoadInD * d;
  const applied = Number(observation.additionalLoad);
  const stepped = Boolean(observation.indicationChanged);

  if (!Number.isFinite(applied)) return null;

  return {
    id: 'discrimination',
    label: 'Discrimination threshold',
    criterion: `additional load of ${rules.discrimination.gentleAdditionalLoadInD} d shall step one interval (OIML R 76-1 3.8)`,
    value: roundToStep(applied, d),
    limit: roundToStep(required, d),
    unit: context.instrument.unit,
    pass: stepped && applied <= required + EPS,
  };
}

const MODULE_EVALUATORS = {
  weighing_test: evaluateWeighingTest,
  repeatability_test: evaluateRepeatabilityTest,
  eccentricity_test: evaluateEccentricityTest,
  zero_setting_test: evaluateZeroTest,
  tare_test: evaluateTareTest,
  temperature_test: evaluateTemperatureTest,
  power_supply_test: evaluatePowerSupplyTest,
  creep_test: evaluateCreepTest,
};

module.exports = {
  EPS,
  round,
  roundToStep,
  mean,
  standardDeviation,
  preRoundingIndication,
  errorBeforeCorrection,
  correctedError,
  evaluateLoadPoint,
  evaluateWeighingTest,
  evaluateRepeatabilityTest,
  evaluateEccentricityTest,
  evaluateZeroTest,
  evaluateTareTest,
  evaluateTemperatureTest,
  evaluatePowerSupplyTest,
  evaluateCreepTest,
  evaluateDiscrimination,
  MODULE_EVALUATORS,
  loadRules,
};
