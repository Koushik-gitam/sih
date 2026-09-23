// Mass unit helpers.
//
// The rule schema states the verification scale interval limits in grams
// (OIML R 76-1 Table 3 uses e >= 0.001 g, e <= 0.05 g, ...). Instruments are
// recorded in their own working unit, which may be mg, g, kg or t, so every
// comparison against the schema passes through `toGrams`.

const UNIT_TO_GRAMS = {
  mg: 0.001,
  g: 1,
  kg: 1000,
  t: 1000000,
  lb: 453.59237,
  oz: 28.349523125,
};

const SUPPORTED_UNITS = Object.keys(UNIT_TO_GRAMS);

function normaliseUnit(unit) {
  if (typeof unit !== 'string') return null;
  const key = unit.trim().toLowerCase();
  if (key === 'tonne' || key === 'tonnes' || key === 'ton') return 't';
  if (key === 'gram' || key === 'grams') return 'g';
  if (key === 'kilogram' || key === 'kilograms' || key === 'kgs') return 'kg';
  if (key === 'milligram' || key === 'milligrams') return 'mg';
  return UNIT_TO_GRAMS[key] ? key : null;
}

function isSupportedUnit(unit) {
  return normaliseUnit(unit) !== null;
}

function toGrams(value, unit) {
  const key = normaliseUnit(unit);
  if (key === null) {
    throw new Error(`Unsupported mass unit: ${unit}. Supported: ${SUPPORTED_UNITS.join(', ')}`);
  }
  return Number(value) * UNIT_TO_GRAMS[key];
}

function fromGrams(valueInGrams, unit) {
  const key = normaliseUnit(unit);
  if (key === null) {
    throw new Error(`Unsupported mass unit: ${unit}. Supported: ${SUPPORTED_UNITS.join(', ')}`);
  }
  return Number(valueInGrams) / UNIT_TO_GRAMS[key];
}

function convert(value, fromUnit, toUnit) {
  return fromGrams(toGrams(value, fromUnit), toUnit);
}

/** Decimal places needed to display a value whose smallest step is `step`. */
function decimalsForStep(step) {
  if (!Number.isFinite(step) || step <= 0) return 3;
  const text = Number(step).toString();
  if (text.includes('e-')) return Math.min(12, Number(text.split('e-')[1]) + 1);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : Math.min(12, text.length - dot - 1);
}

module.exports = {
  UNIT_TO_GRAMS,
  SUPPORTED_UNITS,
  isSupportedUnit,
  normaliseUnit,
  toGrams,
  fromGrams,
  convert,
  decimalsForStep,
};
