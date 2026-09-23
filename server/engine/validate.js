// Input validation.
//
// The problem statement asks for "automatic validation of input data". Nothing
// is calculated on the server until these checks pass, so an impossible
// instrument record (Max < Min, e outside the class range, a load above Max)
// can never reach the report.

const { classify, resolveBand, loadRules, mpeForLoad } = require('./rules');
const { isSupportedUnit, toGrams, normaliseUnit } = require('./units');

function finding(severity, field, message, code) {
  return { severity, field, message, code: code || null };
}

const REQUIRED_INSTRUMENT_FIELDS = [
  ['manufacturer', 'Manufacturer name'],
  ['model', 'Model designation'],
  ['serialNumber', 'Serial number'],
  ['accuracyClass', 'Accuracy class'],
  ['unit', 'Working unit'],
  ['maxCapacity', 'Maximum capacity (Max)'],
  ['minCapacity', 'Minimum capacity (Min)'],
  ['e', 'Verification scale interval (e)'],
  ['d', 'Actual scale interval (d)'],
];

/** Validate an instrument record against the classification rules (Table 3). */
function validateInstrument(instrument = {}, rules = loadRules()) {
  const errors = [];
  const warnings = [];

  REQUIRED_INSTRUMENT_FIELDS.forEach(([field, label]) => {
    const value = instrument[field];
    if (value === undefined || value === null || value === '') {
      errors.push(finding('error', field, `${label} is required.`, 'required'));
    }
  });

  if (errors.length) return { valid: false, errors, warnings };

  const unit = instrument.unit;
  if (!isSupportedUnit(unit)) {
    errors.push(finding('error', 'unit', `Unsupported unit "${unit}". Use mg, g, kg or t.`, 'unit'));
    return { valid: false, errors, warnings };
  }

  const maxCapacity = Number(instrument.maxCapacity);
  const minCapacity = Number(instrument.minCapacity);
  const e = Number(instrument.e);
  const d = Number(instrument.d);

  if (!(e > 0)) errors.push(finding('error', 'e', 'Verification scale interval e must be greater than zero.', 'range'));
  if (!(d > 0)) errors.push(finding('error', 'd', 'Actual scale interval d must be greater than zero.', 'range'));
  if (!(maxCapacity > 0)) errors.push(finding('error', 'maxCapacity', 'Max must be greater than zero.', 'range'));
  if (!(minCapacity > 0)) errors.push(finding('error', 'minCapacity', 'Min must be greater than zero.', 'range'));

  if (errors.length) return { valid: false, errors, warnings };

  if (maxCapacity <= minCapacity) {
    errors.push(
      finding('error', 'maxCapacity', `Max (${maxCapacity}) must be greater than Min (${minCapacity}).`, 'max_min'),
    );
  }

  if (d > e + 1e-12) {
    errors.push(
      finding('error', 'd', `Actual scale interval d (${d}) cannot exceed the verification scale interval e (${e}).`, 'd_gt_e'),
    );
  }

  if (normaliseUnit(instrument.minCapacityUnit || unit) !== normaliseUnit(unit)) {
    warnings.push(
      finding('warning', 'minCapacity', 'Min, Max, e and d are interpreted in the declared working unit.', 'unit_consistency'),
    );
  }

  let classification = null;
  try {
    classification = classify({
      accuracyClass: instrument.accuracyClass,
      e,
      eUnit: unit,
      maxCapacity,
      minCapacity,
      minCapacityMode: instrument.minCapacityMode,
      rules,
    });
  } catch (error) {
    errors.push(finding('error', 'e', error.message, 'class_band'));
    return { valid: false, errors, warnings };
  }

  // Number of verification scale intervals, n = Max / e.
  if (classification.intervals !== null) {
    const n = classification.intervals;
    if (!Number.isInteger(Math.round(n)) || Math.abs(n - Math.round(n)) > 1e-6) {
      warnings.push(
        finding(
          'warning',
          'maxCapacity',
          `n = Max / e = ${n} is not a whole number; confirm Max and e are both recorded in ${unit}.`,
          'non_integer_intervals',
        ),
      );
    }
    if (!classification.intervalsWithinLimits) {
      const band = classification.band;
      errors.push(
        finding(
          'error',
          'maxCapacity',
          `n = Max / e = ${n} is outside the permitted range for class ${classification.className} (${band.intervalsMin} to ${band.intervalsMax ?? 'unbounded'}).`,
          'interval_range',
        ),
      );
    }
  }

  if (minCapacity < classification.requiredMinCapacity - 1e-12) {
    errors.push(
      finding(
        'error',
        'minCapacity',
        `Min (${minCapacity} ${unit}) is below the minimum capacity of ${classification.requiredMinCapacityInE} e = ${classification.requiredMinCapacity} ${unit} required for class ${classification.className}.`,
        'min_capacity',
      ),
    );
  }

  // Classification e limits, reported as a warning when a neighbouring band
  // would apply to a different capacity range.
  try {
    const { band } = resolveBand(rules, instrument.accuracyClass, e, unit);
    if (band.eMaxGrams !== null && toGrams(e, unit) > band.eMaxGrams) {
      warnings.push(
        finding('warning', 'e', `e is above the usual upper limit (${band.eMaxGrams} g) for this class band.`, 'e_band'),
      );
    }
  } catch {
    /* already reported by classify() */
  }

  if (instrument.loadReceptorSupportPoints !== undefined) {
    const supportPoints = Number(instrument.loadReceptorSupportPoints);
    if (!Number.isInteger(supportPoints) || supportPoints < 3) {
      warnings.push(
        finding('warning', 'loadReceptorSupportPoints', 'Load receptor support points should be 3 or more.', 'support_points'),
      );
    }
  }

  if (instrument.temperatureRange) {
    const { min, max } = instrument.temperatureRange;
    const span = Number(max) - Number(min);
    const requiredSpan = rules.temperature.minimumSpanCelsius[classification.className];
    if (!Number.isFinite(span) || span <= 0) {
      errors.push(finding('error', 'temperatureRange', 'Declared temperature range must have max above min.', 'temperature_range'));
    } else if (requiredSpan && span < requiredSpan) {
      errors.push(
        finding(
          'error',
          'temperatureRange',
          `Declared temperature range of ${span} °C is narrower than the ${requiredSpan} °C minimum for class ${classification.className}.`,
          'temperature_span',
        ),
      );
    }
    if (min !== undefined && (Number(min) < -20 || Number(max) > 60)) {
      warnings.push(
        finding('warning', 'temperatureRange', 'Declared range extends outside the range the laboratory can usually reproduce.', 'temperature_practical'),
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings, classification };
}

/** Environmental conditions must be recorded before a test is accepted (3.5.3.1). */
function validateEnvironmental(environmental = {}, rules = loadRules()) {
  const errors = [];
  const warnings = [];
  const config = rules.environmentalRecording;

  config.required.forEach((field) => {
    const value = environmental[field];
    if (value === undefined || value === null || value === '') {
      errors.push(finding('error', field, `${field} must be recorded before the test is submitted.`, 'required'));
      return;
    }
    if (!Number.isFinite(Number(value))) {
      errors.push(finding('error', field, `${field} must be numeric.`, 'numeric'));
    }
  });

  const temperature = Number(environmental.ambientTemperatureCelsius);
  const humidity = Number(environmental.relativeHumidityPercent);

  if (Number.isFinite(temperature)) {
    const [low, high] = config.allowedTemperatureRangeCelsius;
    if (temperature < low || temperature > high) {
      errors.push(
        finding('error', 'ambientTemperatureCelsius', `Ambient temperature ${temperature} °C is outside the plausible range ${low} to ${high} °C.`, 'range'),
      );
    }
  }

  if (Number.isFinite(humidity)) {
    const [low, high] = config.relativeHumidityPercentRange;
    if (humidity < low || humidity > high) {
      errors.push(
        finding('error', 'relativeHumidityPercent', `Relative humidity must be between ${low} and ${high} %.`, 'range'),
      );
    } else if (humidity > 85) {
      warnings.push(
        finding('warning', 'relativeHumidityPercent', 'Humidity above 85 % may require the damp heat test sequence.', 'humidity_high'),
      );
    }
  }

  if (!environmental.testDate) {
    errors.push(finding('error', 'testDate', 'Test date is required for the report header.', 'required'));
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Observation validation per test module
// ---------------------------------------------------------------------------

function numericField(errors, field, value, label) {
  if (value === undefined || value === null || value === '') {
    errors.push(finding('error', field, `${label} is required.`, 'required'));
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    errors.push(finding('error', field, `${label} must be numeric.`, 'numeric'));
    return null;
  }
  return number;
}

function checkLoadAgainstInstrument(errors, warnings, field, load, instrument) {
  if (load === null) return;
  if (load > Number(instrument.maxCapacity) + 1e-9) {
    errors.push(finding('error', field, `Load ${load} ${instrument.unit} exceeds Max (${instrument.maxCapacity} ${instrument.unit}).`, 'load_gt_max'));
  }
  if (load !== 0 && load < Number(instrument.minCapacity) - 1e-9) {
    warnings.push(
      finding('warning', field, `Load ${load} ${instrument.unit} is below Min (${instrument.minCapacity} ${instrument.unit}).`, 'load_lt_min'),
    );
  }
}

function checkSubWeight(errors, warnings, field, additionalLoad, instrument) {
  if (additionalLoad === null || additionalLoad === 0) return;
  if (additionalLoad < 0) {
    errors.push(finding('error', field, 'Change-over sub-weights cannot be negative.', 'sub_weight'));
  } else if (additionalLoad > instrument.e + 1e-12) {
    errors.push(
      finding('error', field, `Change-over sub-weight ΔL (${additionalLoad}) should not exceed one scale interval e (${instrument.e}).`, 'sub_weight_large'),
    );
  } else if (Math.abs(additionalLoad / instrument.e - 0.1) > 0.05) {
    warnings.push(
      finding('warning', field, 'OIML R 76-1 A.4.4.3 uses change-over sub-weights of about 1/10 e.', 'sub_weight_step'),
    );
  }
}

function validateModuleObservations(moduleId, observations = {}, instrument, rules = loadRules()) {
  const errors = [];
  const warnings = [];

  switch (moduleId) {
    case 'weighing_test': {
      const points = observations.points || [];
      if (!points.length) errors.push(finding('error', 'points', 'At least one load point is required.', 'required'));
      points.forEach((point, index) => {
        const load = numericField(errors, `points[${index}].load`, point.load, `Point ${index + 1} load`);
        numericField(errors, `points[${index}].indication`, point.indication, `Point ${index + 1} indication`);
        const additional = Number(point.additionalLoad || 0);
        checkLoadAgainstInstrument(errors, warnings, `points[${index}].load`, load, instrument);
        checkSubWeight(errors, warnings, `points[${index}].additionalLoad`, additional, instrument);
      });
      if (points.length && !points.some((point) => Number(point.load) >= Number(instrument.maxCapacity))) {
        warnings.push(finding('warning', 'points', 'A weighing test normally includes a point at or near Max.', 'max_missing'));
      }
      break;
    }

    case 'repeatability_test': {
      const sets = observations.sets || [];
      if (!sets.length) errors.push(finding('error', 'sets', 'At least one load with repeated readings is required.', 'required'));
      sets.forEach((set, index) => {
        const load = numericField(errors, `sets[${index}].load`, set.load, `Set ${index + 1} load`);
        checkLoadAgainstInstrument(errors, warnings, `sets[${index}].load`, load, instrument);
        const readings = (set.readings || []).filter((value) => Number.isFinite(Number(value)));
        if (readings.length < 2) {
          errors.push(finding('error', `sets[${index}].readings`, `Set ${index + 1} needs at least two readings.`, 'readings'));
        } else if (readings.length < rules.repeatability.recommendedReadingsPerLoad) {
          warnings.push(
            finding('warning', `sets[${index}].readings`, `Set ${index + 1} has ${readings.length} readings; ${rules.repeatability.recommendedReadingsPerLoad} are recommended.`, 'readings_recommended'),
          );
        }
      });
      break;
    }

    case 'eccentricity_test': {
      const load = numericField(errors, 'load', observations.load, 'Eccentricity test load');
      checkLoadAgainstInstrument(errors, warnings, 'load', load, instrument);
      const positions = observations.points || [];
      if (positions.length < rules.eccentricity.positionsForSupportPoints) {
        warnings.push(
          finding('warning', 'points', `Eccentricity testing normally uses ${rules.eccentricity.positionsForSupportPoints} positions plus a centre reading.`, 'positions'),
        );
      }
      positions.forEach((position, index) => {
        numericField(errors, `points[${index}].indication`, position.indication, `Position ${index + 1} indication`);
        checkSubWeight(errors, warnings, `points[${index}].additionalLoad`, Number(position.additionalLoad || 0), instrument);
      });
      if (load !== null) {
        const expected = rules.eccentricity.testLoadFraction.default * Number(instrument.maxCapacity);
        if (Math.abs(load - expected) / expected > 0.05) {
          warnings.push(
            finding('warning', 'load', `Conventional eccentricity load is 1/3 of Max (${expected.toFixed(2)} ${instrument.unit}); recorded ${load} ${instrument.unit}.`, 'eccentric_load'),
          );
        }
      }
      break;
    }

    case 'zero_setting_test': {
      const provided = ['initialZeroLoad', 'zeroError', 'trackingDeviation'].filter(
        (field) => observations[field] !== undefined && observations[field] !== null && observations[field] !== '',
      );
      if (!provided.length) {
        errors.push(finding('error', 'observations', 'Record the initial zero-setting load, zero error or zero-tracking deviation.', 'required'));
      }
      provided.forEach((field) => numericField(errors, field, observations[field], field));
      if (observations.initialZeroLoad !== undefined) {
        checkLoadAgainstInstrument(errors, warnings, 'initialZeroLoad', Number(observations.initialZeroLoad), instrument);
      }
      break;
    }

    case 'tare_test': {
      const tareLoad = numericField(errors, 'tareLoad', observations.tareLoad, 'Tare load');
      checkLoadAgainstInstrument(errors, warnings, 'tareLoad', tareLoad, instrument);
      numericField(errors, 'indicationAfterTare', observations.indicationAfterTare, 'Indication after taring');
      (observations.netPoints || []).forEach((point, index) => {
        numericField(errors, `netPoints[${index}].load`, point.load, `Net point ${index + 1} load`);
        numericField(errors, `netPoints[${index}].indication`, point.indication, `Net point ${index + 1} indication`);
      });
      break;
    }

    case 'temperature_test': {
      const points = observations.points || [];
      if (points.length < 2) {
        errors.push(finding('error', 'points', 'At least two temperature points are required.', 'required'));
      }
      points.forEach((point, index) => {
        const temperature = numericField(errors, `points[${index}].temperatureCelsius`, point.temperatureCelsius, `Point ${index + 1} temperature`);
        numericField(errors, `points[${index}].load`, point.load, `Point ${index + 1} load`);
        numericField(errors, `points[${index}].indication`, point.indication, `Point ${index + 1} indication`);
        checkLoadAgainstInstrument(errors, warnings, `points[${index}].load`, Number(point.load), instrument);
        const range = instrument.temperatureRange;
        if (range && Number.isFinite(temperature) && (temperature < Number(range.min) || temperature > Number(range.max))) {
          errors.push(
            finding(
              'error',
              `points[${index}].temperatureCelsius`,
              `Temperature ${temperature} °C is outside the instrument's declared range ${range.min} to ${range.max} °C.`,
              'temperature_outside',
            ),
          );
        }
      });
      break;
    }

    case 'power_supply_test': {
      const points = observations.points || [];
      if (points.length < 2) {
        errors.push(finding('error', 'points', 'At least two voltage points are required.', 'required'));
      }
      const nominal = Number(observations.nominalVoltage || instrument.nominalVoltage);
      if (!Number.isFinite(nominal) && points.some((point) => !Number.isFinite(Number(point.voltageFactor)))) {
        errors.push(finding('error', 'nominalVoltage', 'Nominal voltage is required to interpret voltage points.', 'required'));
      }
      points.forEach((point, index) => {
        numericField(errors, `points[${index}].load`, point.load, `Point ${index + 1} load`);
        numericField(errors, `points[${index}].indication`, point.indication, `Point ${index + 1} indication`);
        const factor = Number.isFinite(Number(point.voltageFactor))
          ? Number(point.voltageFactor)
          : Number(point.voltage) / nominal;
        if (Number.isFinite(factor)) {
          const config = rules.powerSupply;
          if (factor < config.mainsLowerFactor - 1e-9 || factor > config.mainsUpperFactor + 1e-9) {
            errors.push(
              finding(
                'error',
                `points[${index}].voltage`,
                `Voltage factor ${factor.toFixed(3)} is outside the tested range ${config.mainsLowerFactor} to ${config.mainsUpperFactor} × Unom.`,
                'voltage_range',
              ),
            );
          }
        }
      });
      break;
    }

    case 'creep_test': {
      const points = observations.points || [];
      if (points.length < 2) {
        errors.push(finding('error', 'points', 'At least two timed indications are required.', 'required'));
      }
      numericField(errors, 'load', observations.load, 'Creep test load');
      checkLoadAgainstInstrument(errors, warnings, 'load', Number(observations.load), instrument);
      points.forEach((point, index) => {
        numericField(errors, `points[${index}].elapsedMinutes`, point.elapsedMinutes, `Point ${index + 1} elapsed time`);
        numericField(errors, `points[${index}].indication`, point.indication, `Point ${index + 1} indication`);
      });
      break;
    }

    default:
      errors.push(finding('error', 'moduleId', `Unknown test module "${moduleId}".`, 'unknown_module'));
  }

  // Every observation that feeds an error determination must resolve to an MPE.
  errors.forEach((entry) => {
    if (entry.code === 'load_gt_max') entry.message += ' The MPE table does not extend beyond Max.';
  });

  return { valid: errors.length === 0, errors, warnings };
}

/** Validate a complete test record before it is evaluated or submitted. */
function validateTestRecord(record = {}, rules = loadRules()) {
  const instrument = record.instrument || {};
  const instrumentResult = validateInstrument(instrument, rules);
  const environmentalResult = validateEnvironmental(record.environmental || {}, rules);

  const errors = [...instrumentResult.errors, ...environmentalResult.errors];
  const warnings = [...instrumentResult.warnings, ...environmentalResult.warnings];

  const modules = record.modules || {};
  Object.entries(modules).forEach(([moduleId, observations]) => {
    const result = validateModuleObservations(moduleId, observations, instrument, rules);
    result.errors.forEach((entry) =>
      errors.push(finding(entry.severity, `modules.${moduleId}.${entry.field}`, `[${moduleId}] ${entry.message}`, entry.code)),
    );
    result.warnings.forEach((entry) =>
      warnings.push(finding(entry.severity, `modules.${moduleId}.${entry.field}`, `[${moduleId}] ${entry.message}`, entry.code)),
    );
  });

  const testedModules = Object.keys(modules).filter((moduleId) => {
    const observations = modules[moduleId] || {};
    return Object.keys(observations).length > 0;
  });

  if (!testedModules.length) {
    errors.push(finding('error', 'modules', 'Record observations for at least one test module.', 'no_modules'));
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    testedModules,
    classification: instrumentResult.classification || null,
  };
}

module.exports = {
  validateInstrument,
  validateEnvironmental,
  validateModuleObservations,
  validateTestRecord,
  mpeForLoad,
};
