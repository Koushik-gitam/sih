// Test-load planning.
//
// A weighing test is only meaningful if the loads applied actually exercise the
// MPE brackets of the instrument's class. Given an instrument, this module
// proposes a load set: Min, Max, mid-range loads, and the values immediately
// either side of each bracket boundary in Table 6.

const { resolveBand, loadRules } = require('./rules');

function roundToInterval(value, e) {
  if (!(e > 0)) return value;
  return Math.round(value / e) * e;
}

/**
 * @param {object} instrument  { accuracyClass, e, unit, maxCapacity, minCapacity }
 * @returns {Array<{ load:number, loadInE:number, mpeInE:number, mpe:number, note:string }>}
 */
function suggestTestLoads(instrument, rules = loadRules()) {
  const e = Number(instrument.e);
  const max = Number(instrument.maxCapacity);
  const min = Number(instrument.minCapacity);

  if (!(e > 0) || !(max > 0)) return [];

  const { band } = resolveBand(rules, instrument.accuracyClass, e, instrument.unit);

  const candidates = [
    { load: min, note: 'Min - minimum capacity' },
    { load: max / 4, note: 'Quarter of Max' },
    { load: max / 2, note: 'Half of Max' },
    { load: max, note: 'Max - maximum capacity' },
  ];

  band.mpeBrackets.forEach((bracket) => {
    if (bracket.upToInE === null) return;
    const boundary = bracket.upToInE * e;
    candidates.push({ load: boundary, note: `Bracket boundary ${bracket.upToInE} e (MPE ${bracket.mpeInE} e)` });
    candidates.push({ load: boundary + e, note: `First interval above ${bracket.upToInE} e` });
  });

  const seen = new Set();
  const loads = [];

  candidates.forEach((candidate) => {
    const rounded = roundToInterval(candidate.load, e);
    if (!(rounded > 0) || rounded > max + 1e-9) return;
    if (rounded < min - 1e-9) return;
    const key = Number(rounded.toFixed(6));
    if (seen.has(key)) return;
    seen.add(key);
    loads.push({ load: key, note: candidate.note });
  });

  loads.sort((a, b) => a.load - b.load);

  return loads.map((entry) => {
    const loadInE = entry.load / e;
    const bracket = band.mpeBrackets.find(
      (candidate) => candidate.upToInE === null || loadInE <= candidate.upToInE + 1e-9,
    );
    return {
      load: entry.load,
      loadInE: Number(loadInE.toFixed(4)),
      mpeInE: bracket ? bracket.mpeInE : null,
      mpe: bracket ? bracket.mpeInE * e : null,
      note: entry.note,
    };
  });
}

/** Conventional eccentricity test load: 1/3 of Max (or 1/(n-1) for n > 4 supports). */
function eccentricityLoad(instrument, rules = loadRules()) {
  const max = Number(instrument.maxCapacity);
  const supportPoints = Number(instrument.loadReceptorSupportPoints);
  if (supportPoints > 4) {
    return {
      load: roundToInterval(max / (supportPoints - 1), instrument.e),
      basis: `1 / (n - 1) with n = ${supportPoints} support points`,
    };
  }
  return {
    load: roundToInterval(rules.eccentricity.testLoadFraction.default * max, instrument.e),
    basis: '1/3 of Max (OIML R 76-1 3.6.2.1)',
  };
}

module.exports = { suggestTestLoads, eccentricityLoad };
