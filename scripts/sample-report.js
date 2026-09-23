#!/usr/bin/env node
// Generate one complete sample report (HTML + PDF + DOCX) without touching the
// repository - useful for demonstrating the engine and the report layout.
//
//   npm run report:sample

const fs = require('fs');
const path = require('path');

const { loadRules } = require('../server/engine/rules');
const { evaluateTest } = require('../server/engine/evaluate');
const { suggestTestLoads, eccentricityLoad } = require('../server/engine/planning');
const { generateReportArtifacts } = require('../server/reports/report');

const rules = loadRules();
const outDir = path.resolve(__dirname, '..', 'out');

const instrument = {
  manufacturer: 'Bharat Weighing Systems',
  model: 'BWS-15K',
  serialNumber: 'BWS15-2026-0142',
  accuracyClass: 'III',
  unit: 'kg',
  maxCapacity: 15,
  minCapacity: 0.1,
  e: 0.005,
  d: 0.005,
  loadReceptorSupportPoints: 4,
  instrumentType: 'single_interval',
  temperatureRange: { min: -10, max: 40 },
  nominalVoltage: 230,
  modelApprovalReference: 'DoCA/MA/2026/0331',
};

const suggestions = suggestTestLoads(instrument, rules);
const eccentric = eccentricityLoad(instrument, rules);

const record = {
  reportNumber: 'NAWI/2026/SAMPLE',
  instrument,
  laboratory: {
    name: 'Regional Reference Standard Laboratory',
    labCode: 'RRSL-AND-01',
    address: 'Ahmedabad, Gujarat',
  },
  environmental: {
    ambientTemperatureCelsius: 24.5,
    relativeHumidityPercent: 56,
    barometricPressureKpa: 101.1,
    testDate: new Date().toISOString().slice(0, 10),
    testedBy: 'technician',
    standardWeights: 'OIML F1 class test weights, 1 mg to 20 kg',
    weightsTraceability: 'Traceable to CSIR-NPL, certificate NPL/2026/1187',
  },
  modules: {
    weighing_test: {
      points: [
        ...suggestions.map((entry) => ({
          load: entry.load,
          indication: entry.load,
          additionalLoad: 0,
          direction: 'increasing',
        })),
        ...[...suggestions]
          .reverse()
          .slice(0, 3)
          .map((entry) => ({ load: entry.load, indication: entry.load, additionalLoad: 0, direction: 'decreasing' })),
      ],
    },
    eccentricity_test: {
      load: eccentric.load,
      centre: { indication: eccentric.load, additionalLoad: 0 },
      points: [
        { position: 'front-left', indication: eccentric.load, additionalLoad: 0 },
        { position: 'front-right', indication: eccentric.load + instrument.e, additionalLoad: 0 },
        { position: 'rear-left', indication: eccentric.load, additionalLoad: 0 },
        { position: 'rear-right', indication: eccentric.load - instrument.e, additionalLoad: 0 },
      ],
    },
    // e = 0.005 kg, so one scale interval is 0.005 kg and 0.5 e is 0.0025 kg.
    repeatability_test: {
      sets: [
        { load: 7.5, readings: [7.5, 7.505, 7.5] },
        { load: 15, readings: [15, 15.005, 15] },
      ],
    },
    zero_setting_test: { initialZeroLoad: 0.5, zeroError: 0.00125, trackingDeviation: 0.0025 },
    tare_test: { tareLoad: 2.5, indicationAfterTare: 0, additionalLoad: 0.002, netPoints: [{ load: 2.5, indication: 2.5 }] },
    temperature_test: {
      load: 7.5,
      points: [
        { temperatureCelsius: -10, load: 7.5, indication: 7.5, additionalLoad: 0 },
        { temperatureCelsius: 20, load: 7.5, indication: 7.5, additionalLoad: 0 },
        { temperatureCelsius: 40, load: 7.5, indication: 7.505, additionalLoad: 0.0025 },
      ],
    },
    power_supply_test: {
      nominalVoltage: 230,
      points: [
        { voltage: 195.5, load: 7.5, indication: 7.5, additionalLoad: 0 },
        { voltage: 253, load: 7.5, indication: 7.5, additionalLoad: 0 },
      ],
    },
    creep_test: {
      load: 15,
      returnToZeroIndication: 0.002,
      points: [
        { elapsedMinutes: 0, indication: 15 },
        { elapsedMinutes: 5, indication: 15 },
        { elapsedMinutes: 15, indication: 15.002 },
        { elapsedMinutes: 30, indication: 15.002 },
      ],
    },
  },
};

async function main() {
  const evaluation = evaluateTest(record, { rules });
  evaluation.reportNumber = record.reportNumber;

  const generated = await generateReportArtifacts(evaluation, {
    formats: ['pdf', 'docx'],
    attachments: [
      {
        filename: 'instrument-setup.jpg',
        mimetype: 'image/jpeg',
        size: 284_320,
        sha256: 'demo-attachment-hash-not-a-real-file',
        uploadedAt: new Date().toISOString(),
      },
    ],
    signatures: [
      { meaning: 'tested', name: 'Laboratory Technician', at: new Date().toISOString() },
      { meaning: 'approved', name: 'Laboratory Manager', at: new Date().toISOString() },
    ],
  });

  console.log('Sample record:', record.reportNumber);
  console.log('Verdict      :', evaluation.summary.verdict.toUpperCase());
  console.log(
    'Summary      :',
    `${evaluation.summary.modulesPassed}/${evaluation.summary.modulesTested} modules passed,`,
    `${evaluation.summary.pointsFailed} of ${evaluation.summary.pointsEvaluated} load points outside tolerance`,
  );
  console.log('Integrity    :', evaluation.integrityHash);
  console.log('MPE brackets :', evaluation.ruleView.mpeTable.map((row) => `±${row.mpeInE} e`).join(' / '));
  console.log('');

  generated.artifacts.forEach((artifact) => {
    console.log(`${artifact.format.toUpperCase().padEnd(5)} ${(artifact.bytes / 1024).toFixed(1)} kB  ${artifact.path}`);
  });
  generated.errors.forEach((error) => console.error(`FAILED ${error.format}: ${error.error}`));

  // Keep a copy in out/ for the submission bundle.
  fs.mkdirSync(outDir, { recursive: true });
  generated.artifacts.forEach((artifact) => {
    fs.copyFileSync(artifact.path, path.join(outDir, path.basename(artifact.path)));
  });
  console.log(`\nCopies written to ${outDir}`);
}

main().catch((error) => {
  console.error('Sample report generation failed:', error);
  process.exit(1);
});
