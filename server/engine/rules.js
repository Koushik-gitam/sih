// Rule-schema access layer.
//
// Everything metrological that can change when OIML R 76 or the Legal
// Metrology (General) Rules are revised lives in rules/oiml-r76.json. This
// module loads, validates and interprets that schema - it contains no
// standard-specific constants of its own.

const fs = require('fs');
const path = require('path');

const { toGrams, normaliseUnit } = require('./units');

const DEFAULT_RULES_PATH = path.join(__dirname, '..', '..', 'rules', 'oiml-r76.json');

let cache = null;
let cachePath = null;

function rulesPath() {
  return process.env.NAWI_RULES_PATH
    ? path.resolve(process.env.NAWI_RULES_PATH)
    : DEFAULT_RULES_PATH;
}

/** Load (and cache) the active rule schema. */
function loadRules({ force = false } = {}) {
  const target = rulesPath();
  if (!force && cache && cachePath === target) return cache;

  const raw = fs.readFileSync(target, 'utf8');
  const rules = JSON.parse(raw);
  const problems = validateRules(rules);
  if (problems.length) {
    throw new Error(`Rule schema at ${target} is invalid:\n - ${problems.join('\n - ')}`);
  }

  cache = rules;
  cachePath = target;
  return rules;
}

/**
 * Structural self-check. A malformed rule file must fail loudly rather than
 * silently produce wrong compliance verdicts.
 */
function validateRules(rules) {
  const problems = [];

  if (!rules || typeof rules !== 'object') return ['schema is not an object'];
  if (!rules.standard) problems.push('missing "standard"');
  if (!rules.classes || typeof rules.classes !== 'object') problems.push('missing "classes"');

  for (const [className, definition] of Object.entries(rules.classes || {})) {
    if (!Array.isArray(definition.bands) || definition.bands.length === 0) {
      problems.push(`class ${className} has no bands`);
      continue;
    }
    definition.bands.forEach((band, index) => {
      if (!Array.isArray(band.mpeBrackets) || band.mpeBrackets.length === 0) {
        problems.push(`class ${className} band ${index} has no mpeBrackets`);
        return;
      }
      let previous = -1;
      band.mpeBrackets.forEach((bracket, bracketIndex) => {
        if (typeof bracket.mpeInE !== 'number' || bracket.mpeInE <= 0) {
          problems.push(`class ${className} band ${index} bracket ${bracketIndex} has invalid mpeInE`);
        }
        if (bracket.upToInE !== null) {
          if (typeof bracket.upToInE !== 'number' || bracket.upToInE <= 0) {
            problems.push(`class ${className} band ${index} bracket ${bracketIndex} has invalid upToInE`);
          } else if (bracket.upToInE <= previous) {
            problems.push(`class ${className} band ${index} brackets are not in ascending order`);
          } else {
            previous = bracket.upToInE;
          }
        }
      });
      const last = band.mpeBrackets[band.mpeBrackets.length - 1];
      if (last && last.upToInE !== null) {
        const hasOpenTop = band.mpeBrackets.some((b) => b.upToInE === null);
        if (!hasOpenTop && band.intervalsMax === null) {
          problems.push(
            `class ${className} band ${index} is unbounded above in capacity but the last MPE bracket ends at ${last.upToInE}`,
          );
        }
      }
    });
  }

  if (!Array.isArray(rules.testModules) || rules.testModules.length === 0) {
    problems.push('missing "testModules"');
  }

  return problems;
}

function getClassDefinition(rules, accuracyClass) {
  const key = String(accuracyClass || '').trim().toUpperCase().replace(/^CLASS\s*/, '');
  const definition = rules.classes[key];
  if (!definition) {
    throw new Error(
      `Unknown accuracy class "${accuracyClass}". Valid classes: ${Object.keys(rules.classes).join(', ')}`,
    );
  }
  return { key, definition };
}

/**
 * Select the classification band (OIML R 76-1 Table 3 has more than one row for
 * classes II and III depending on e).
 */
function resolveBand(rules, accuracyClass, e, eUnit) {
  const { key, definition } = getClassDefinition(rules, accuracyClass);
  const eInGrams = toGrams(e, eUnit);

  const band = definition.bands.find((candidate) => {
    const aboveMin = eInGrams >= candidate.eMinGrams - 1e-12;
    const belowMax = candidate.eMaxGrams === null || eInGrams <= candidate.eMaxGrams + 1e-12;
    return aboveMin && belowMax;
  });

  if (!band) {
    const ranges = definition.bands
      .map((b) => `${b.eMinGrams} g <= e <= ${b.eMaxGrams === null ? 'unbounded' : `${b.eMaxGrams} g`}`)
      .join(' | ');
    throw new Error(
      `Verification scale interval ${e} ${eUnit} (${eInGrams} g) does not fall in a valid range for class ${key}: ${ranges}`,
    );
  }

  return { className: key, classTitle: definition.title, band };
}

/** Number of verification scale intervals, n = Max / e. */
function intervalCount(maxCapacity, e) {
  if (!Number.isFinite(maxCapacity) || !Number.isFinite(e) || e <= 0) return null;
  return Number((maxCapacity / e).toFixed(6));
}

/**
 * MPE bracket lookup for a load, m, expressed in verification scale intervals.
 * Bracket boundaries are inclusive of the upper bound, matching Table 6
 * ("0 <= m <= 500", "500 < m <= 2000", ...).
 */
function mpeForLoad(options) {
  const {
    accuracyClass,
    e,
    eUnit,
    load,
    loadUnit,
    inService = false,
    rules = loadRules(),
  } = options;

  if (!(e > 0)) throw new Error('Verification scale interval e must be greater than zero');
  if (!(load >= 0)) throw new Error('Load must be zero or greater');
  if (normaliseUnit(eUnit) !== normaliseUnit(loadUnit)) {
    throw new Error(
      `e and load must be stated in the same unit (received ${eUnit} and ${loadUnit})`,
    );
  }

  const { className, classTitle, band } = resolveBand(rules, accuracyClass, e, eUnit);
  const loadInE = load / e;

  const tolerance = Math.max(1e-9, loadInE * 1e-12);
  let bracketIndex = -1;
  for (let index = 0; index < band.mpeBrackets.length; index += 1) {
    const bracket = band.mpeBrackets[index];
    if (bracket.upToInE === null || loadInE <= bracket.upToInE + tolerance) {
      bracketIndex = index;
      break;
    }
  }

  if (bracketIndex === -1) {
    throw new Error(
      `Load of ${load} ${loadUnit} (${loadInE} e) exceeds the maximum measurable range for class ${className}`,
    );
  }

  const bracket = band.mpeBrackets[bracketIndex];
  const multiplier = inService ? rules.mpeInServiceMultiplier || 1 : 1;
  const mpeInE = bracket.mpeInE * multiplier;

  return {
    className,
    classTitle,
    band,
    bracketIndex,
    bracket,
    loadInE,
    mpeInE,
    mpe: mpeInE * e,
    inService,
    rulesStandard: rules.standard,
  };
}

/** Convenience: absolute MPE value for a load, in the load's own unit. */
function mpeValue(options) {
  return mpeForLoad(options).mpe;
}

function listTestModules(rules = loadRules()) {
  return rules.testModules.map((module) => ({ ...module }));
}

function getTestModule(rules, moduleId) {
  const module = rules.testModules.find((candidate) => candidate.id === moduleId);
  if (!module) throw new Error(`Unknown test module "${moduleId}"`);
  return module;
}

/** Class definition plus the intervals/min-capacity rules for an instrument. */
function classify({ accuracyClass, e, eUnit, maxCapacity, minCapacity, minCapacityMode, rules = loadRules() }) {
  const { className, classTitle, band } = resolveBand(rules, accuracyClass, e, eUnit);
  const n = maxCapacity ? intervalCount(maxCapacity, e) : null;

  const minCapacityInE =
    minCapacityMode === 'grading' && rules.minCapacityOverride
      ? rules.minCapacityOverride.gradingInstrumentsInE
      : band.minCapacityInE;

  return {
    className,
    classTitle,
    band,
    intervals: n,
    intervalsWithinLimits:
      n === null
        ? null
        : n >= band.intervalsMin && (band.intervalsMax === null || n <= band.intervalsMax),
    requiredMinCapacity: minCapacityInE * e,
    requiredMinCapacityInE: minCapacityInE,
    declaredMinCapacity: minCapacity ?? null,
  };
}

module.exports = {
  DEFAULT_RULES_PATH,
  rulesPath,
  loadRules,
  validateRules,
  getClassDefinition,
  resolveBand,
  intervalCount,
  mpeForLoad,
  mpeValue,
  listTestModules,
  getTestModule,
  classify,
};
