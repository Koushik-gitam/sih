// Editable Word report (OIML R 76-2 layout).
//
// The signed copy of record is the PDF; the .docx exists so that a reviewer can
// append commentary or annexures before an approval decision. Both are rendered
// from the same evaluation object, so the numbers can never diverge.

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  HeadingLevel,
  AlignmentType,
  ShadingType,
  Header,
  Footer,
  PageNumber,
  BorderStyle,
} = require('docx');

const { decimalsForStep } = require('../engine/units');

const NAVY = '0A192F';
const LIGHT = 'F8FAFC';

function text(value, { bold = false, size = 20, color = null, italics = false } = {}) {
  return new TextRun({
    text: value === null || value === undefined || value === '' ? '-' : String(value),
    bold,
    italics,
    size,
    color: color || undefined,
    font: 'Calibri',
  });
}

function paragraph(children, options = {}) {
  return new Paragraph({
    children: Array.isArray(children) ? children : [children],
    spacing: { after: options.after ?? 80, before: options.before ?? 0 },
    heading: options.heading,
    alignment: options.alignment,
  });
}

function heading(textValue, level = HeadingLevel.HEADING_1) {
  return new Paragraph({
    heading: level,
    spacing: { before: level === HeadingLevel.HEADING_1 ? 260 : 180, after: 100 },
    children: [new TextRun({ text: textValue, bold: true, size: level === HeadingLevel.HEADING_1 ? 26 : 22, color: NAVY })],
  });
}

function cell(content, { bold = false, width = null, shade = null, align = null, size = 18 } = {}) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    shading: shade ? { type: ShadingType.CLEAR, fill: shade } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [
      new Paragraph({
        alignment: align || AlignmentType.LEFT,
        children: Array.isArray(content) ? content : [text(content, { bold, size })],
      }),
    ],
  });
}

function tableFromRows(rows, widths) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
      left: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
      right: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
    },
    rows: rows.map((row, rowIndex) =>
      new TableRow({
        tableHeader: rowIndex === 0,
        children: row.map((value, columnIndex) =>
          cell(value, {
            bold: rowIndex === 0,
            shade: rowIndex === 0 ? NAVY : rowIndex % 2 === 0 ? LIGHT : null,
            width: widths ? widths[columnIndex] : null,
            size: 18,
          }),
        ),
      }),
    ),
  });
}

function kvTable(rows) {
  return tableFromRows(
    rows.map(([label, value]) => [label, formatValue(value)]),
    [34, 66],
  );
}

function fmt(value, decimals = 2) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  const places = value === 0 ? 0 : decimals;
  return value.toFixed(places);
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'number') return fmt(value, 6);
  return String(value);
}

function verdictLabel(status) {
  return (
    {
      pass: 'PASS',
      fail: 'FAIL',
      incomplete: 'INCOMPLETE',
      not_tested: 'NOT TESTED',
    }[status] || String(status || '').toUpperCase()
  );
}

function moduleBlock(module, unit, e) {
  const children = [
    heading(`${module.title} (OIML R 76-1 ${module.clause}) - ${verdictLabel(module.status)}`, HeadingLevel.HEADING_2),
  ];

  if (module.criterion) children.push(paragraph(text(`Criterion: ${module.criterion}`, { size: 18, italics: true })));
  if (module.note) children.push(paragraph(text(module.note, { size: 18, italics: true })));

  if (module.checks && module.checks.length) {
    children.push(
      tableFromRows(
        [
          ['Check', 'Requirement', 'Recorded', 'Limit', 'Result'],
          ...module.checks.map((check) => [
            check.label,
            check.criterion,
            `${fmt(check.value, 4)}${check.valueInE !== undefined && check.valueInE !== null ? ` (${fmt(check.valueInE, 3)} e)` : ''}`,
            `${fmt(check.limit, 4)} ${check.unit === '× Unom' ? check.unit : unit}`,
            verdictLabel(check.pass ? 'pass' : 'fail'),
          ]),
        ],
        [22, 30, 18, 18, 12],
      ),
    );
  }

  if (module.moduleId === 'repeatability_test' && module.points.length) {
    children.push(
      tableFromRows(
        [
          ['Load', 'Readings', 'Mean', 'Range', 'Range / e', 'Std. dev.', 'MPE', 'Result'],
          ...module.points.map((point) => [
            `${fmt(point.load, decimalsForStep(e) + 2)} ${unit}`,
            (point.readings || []).map((reading) => fmt(reading, decimalsForStep(e) + 2)).join(', '),
            fmt(point.mean, decimalsForStep(e) + 2),
            fmt(point.range, decimalsForStep(e) + 2),
            fmt(point.rangeInE, 3),
            fmt(point.standardDeviation, decimalsForStep(e) + 2),
            `${fmt(point.mpe, decimalsForStep(e) + 2)} (±${fmt(point.mpeInE, 2)} e)`,
            verdictLabel(point.pass ? 'pass' : 'fail'),
          ]),
        ],
        [14, 22, 12, 12, 10, 12, 12, 8],
      ),
    );
  } else if (module.moduleId === 'eccentricity_test' && module.points.length) {
    children.push(
      tableFromRows(
        [
          ['Position', 'Indication', 'dL', 'Ec', 'Difference from centre', 'Compared / e', 'MPE', 'Result'],
          ...module.points.map((point) => [
            point.label,
            fmt(point.indication, decimalsForStep(e) + 2),
            fmt(point.additionalLoad, decimalsForStep(e) + 2),
            fmt(point.correctedError, decimalsForStep(e) + 2),
            point.differenceFromCentre === null ? '-' : fmt(point.differenceFromCentre, decimalsForStep(e) + 2),
            fmt(point.comparedValueInE, 3),
            `${fmt(point.mpe, decimalsForStep(e) + 2)} (±${fmt(point.mpeInE, 2)} e)`,
            verdictLabel(point.pass ? 'pass' : 'fail'),
          ]),
        ],
        [16, 13, 10, 12, 16, 12, 13, 8],
      ),
    );
  } else if (module.points.length) {
    children.push(
      tableFromRows(
        [
          ['Load L', 'Indication I', 'dL', 'P = I + 0.5e - dL', 'E = P - L', 'Ec = E - E0', 'Ec / e', 'MPE', 'Margin (e)', 'Result'],
          ...module.points.map((point) => [
            `${fmt(point.load, decimalsForStep(e) + 2)} ${unit}`,
            fmt(point.indication, decimalsForStep(e) + 2),
            fmt(point.additionalLoad, decimalsForStep(e) + 2),
            fmt(point.preRoundingIndication, decimalsForStep(e) + 2),
            fmt(point.error, decimalsForStep(e) + 2),
            fmt(point.correctedError, decimalsForStep(e) + 2),
            fmt(point.errorInE, 3),
            `±${fmt(point.mpeInE, 2)} e`,
            fmt(point.marginInE, 3),
            verdictLabel(point.pass ? 'pass' : 'fail'),
          ]),
        ],
        [13, 11, 8, 13, 11, 11, 9, 9, 9, 6],
      ),
    );
  }

  if (module.status === 'not_tested') {
    children.push(paragraph(text('No observations recorded; module not covered by this report.', { size: 18, italics: true })));
  }

  children.push(paragraph(text('', { size: 12 })));
  return children;
}

/**
 * Build the Word report.
 * @returns {Promise<Buffer>}
 */
async function buildReportDocx(evaluation, options = {}) {
  const instrument = evaluation.instrument || {};
  const unit = instrument.unit || 'g';
  const e = Number(instrument.e) || 1;
  const laboratory = evaluation.laboratory || {};
  const environmental = evaluation.environmental || {};
  const generatedAt = options.generatedAt || new Date().toISOString();
  const attachments = options.attachments || [];
  const signatures = options.signatures || [];
  const reportNumber = evaluation.reportNumber || options.reportNumber || 'DRAFT';

  const children = [
    new Paragraph({
      spacing: { after: 40 },
      children: [
        new TextRun({
          text: (laboratory.name || 'Designated testing laboratory').toUpperCase(),
          size: 16,
          color: '64748B',
          font: 'Calibri',
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 40 },
      children: [new TextRun({ text: 'Test Report - Non-Automatic Weighing Instrument', bold: true, size: 32, color: NAVY, font: 'Calibri' })],
    }),
    paragraph(
      text('Pattern evaluation as per OIML R 76-1:2006, reported in the format of OIML R 76-2', { size: 20, color: '475569' }),
    ),

    kvTable([
      ['Report number', reportNumber],
      ['Test date', environmental.testDate || '-'],
      ['Laboratory code', laboratory.labCode || '-'],
      ['Tested by', environmental.testedBy || '-'],
      ['Standard applied', evaluation.standard || 'OIML R 76-1:2006'],
      ['Rule schema revision', evaluation.rulesRevision || '-'],
    ]),

    heading('1. General information'),
    kvTable([
      ['Laboratory', laboratory.name || '-'],
      ['Laboratory address', laboratory.address || '-'],
      ['Applicant / manufacturer', instrument.manufacturer || '-'],
      ['Model approval reference', instrument.modelApprovalReference || '-'],
    ]),

    heading('2. Instrument data and technical characteristics'),
    kvTable([
      ['Manufacturer', instrument.manufacturer || '-'],
      ['Model / type designation', instrument.model || '-'],
      ['Serial number', instrument.serialNumber || '-'],
      ['Accuracy class', `Class ${instrument.accuracyClass || ''} (${instrument.classTitle || ''})`],
      ['Maximum capacity (Max)', `${instrument.maxCapacity} ${unit}`],
      ['Minimum capacity (Min)', `${instrument.minCapacity} ${unit}`],
      ['Verification scale interval (e)', `${instrument.e} ${unit}`],
      ['Actual scale interval (d)', `${instrument.d} ${unit}`],
      ['Number of intervals (n = Max / e)', evaluation.classification?.intervals ?? '-'],
      ['Working temperature range', instrument.temperatureRange ? `${instrument.temperatureRange.min} to ${instrument.temperatureRange.max} °C` : '-'],
      ['Nominal voltage', instrument.nominalVoltage ? `${instrument.nominalVoltage} V` : '-'],
    ]),

    heading('3. Test conditions'),
    kvTable([
      ['Ambient temperature', `${fmt(environmental.ambientTemperatureCelsius, 1)} °C`],
      ['Relative humidity', `${fmt(environmental.relativeHumidityPercent, 1)} %`],
      ['Barometric pressure', `${fmt(environmental.barometricPressureKpa, 1)} kPa`],
      ['Test standard weights', environmental.standardWeights || '-'],
      ['In-service testing', evaluation.summary?.inService ? 'Yes (MPE doubled per 3.5.2)' : 'No (initial verification MPE)'],
    ]),

    heading('4. Maximum permissible errors applied'),
    tableFromRows(
      [
        ['Load range (in e)', 'MPE', `MPE in ${unit}`],
        ...(evaluation.ruleView?.mpeTable || []).map((row) => [
          row.upToInE === null ? `m > ${evaluation.ruleView.mpeTable[evaluation.ruleView.mpeTable.length - 2]?.upToInE ?? ''}` : `m <= ${row.upToInE}`,
          `± ${fmt(row.mpeInE, 2)} e`,
          `± ${fmt(row.mpe, 6)}`,
        ]),
      ],
      [50, 25, 25],
    ),

    heading('5. Summary of test results'),
    tableFromRows(
      [
        ['Test module', 'Clause', 'Observations', 'Failed', 'Result'],
        ...evaluation.modules.map((module) => [
          module.title,
          module.clause,
          String(module.points.length + (module.checks || []).length),
          String(module.failedPoints + (module.failedChecks || 0)),
          verdictLabel(module.status),
        ]),
      ],
      [34, 22, 16, 12, 16],
    ),

    heading('6. Detailed test results'),
  ];

  evaluation.modules
    .filter((module) => module.status !== 'not_tested')
    .forEach((module) => children.push(...moduleBlock(module, unit, e)));

  children.push(heading('7. Compliance statement'));
  children.push(
    paragraph([
      text(`${String(evaluation.summary.verdict).toUpperCase()} - `, { bold: true, size: 24, color: evaluation.summary.verdict === 'pass' ? '059669' : evaluation.summary.verdict === 'fail' ? 'DC2626' : 'D97706' }),
      text(
        evaluation.summary.verdict === 'pass'
          ? 'the instrument complies with the metrological requirements tested.'
          : evaluation.summary.verdict === 'fail'
            ? 'at least one requirement was exceeded.'
            : 'the record is not complete enough to make a compliance claim.',
        { size: 20 },
      ),
    ]),
  );
  children.push(
    paragraph(
      text(
        `Modules tested: ${evaluation.summary.modulesTested}; passed: ${evaluation.summary.modulesPassed}; failed: ${evaluation.summary.modulesFailed}; not tested: ${evaluation.summary.modulesNotTested}. ` +
          `Load points evaluated: ${evaluation.summary.pointsEvaluated}; outside tolerance: ${evaluation.summary.pointsFailed}.`,
        { size: 18 },
      ),
    ),
  );

  if (evaluation.validation.errors.length) {
    children.push(heading('Input validation findings (blocking)', HeadingLevel.HEADING_2));
    evaluation.validation.errors.slice(0, 40).forEach((error) => {
      children.push(paragraph(text(`${error.field}: ${error.message}`, { size: 18, color: 'B91C1C' }), { after: 30 }));
    });
  }

  children.push(heading('8. Attachments, signatures and integrity'));
  if (attachments.length) {
    children.push(
      tableFromRows(
        [
          ['File', 'Type', 'Size', 'SHA-256'],
          ...attachments.map((file) => [
            file.filename,
            file.mimetype || '-',
            `${fmt((file.size || 0) / 1024, 1)} kB`,
            String(file.sha256 || '').slice(0, 32),
          ]),
        ],
        [40, 20, 14, 26],
      ),
    );
  } else {
    children.push(paragraph(text('No photographs or supporting documents are attached to this report.', { size: 18, italics: true })));
  }

  children.push(
    paragraph(text('', { size: 12 })),
    tableFromRows(
      [
        ['Tested by - Laboratory Technician', 'Approved by - Laboratory Manager / Evaluator'],
        [
          signatures.find((signature) => signature.meaning === 'tested')?.name || 'Signature: ______________',
          signatures.find((signature) => signature.meaning === 'approved')?.name || 'Signature: ______________',
        ],
      ],
      [50, 50],
    ),
    paragraph(text('', { size: 12 })),
    kvTable([
      ['Record integrity hash (SHA-256)', evaluation.integrityHash || '-'],
      ['Report generated', generatedAt],
    ]),
    paragraph(
      text(
        'The integrity hash is computed over the instrument data, the environmental conditions and every observation in this report. Any later change to the record changes the hash.',
        { size: 16, italics: true, color: '64748B' },
      ),
    ),
  );

  const document = new Document({
    creator: 'NAWI Test Report System (SIH 26035)',
    title: `Test report ${reportNumber}`,
    description: `OIML R 76 test report for ${instrument.manufacturer || ''} ${instrument.model || ''}`.trim(),
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 20 } },
      },
    },
    sections: [
      {
        properties: { page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  text(`${reportNumber} | OIML R 76 test report | revision `, { size: 16, color: '64748B' }),
                  text(String(evaluation.rulesRevision || ''), { size: 16, color: '64748B' }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  text('Page ', { size: 16, color: '64748B' }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '64748B' }),
                  text(' of ', { size: 16, color: '64748B' }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '64748B' }),
                  text(` | hash ${String(evaluation.integrityHash || '').slice(0, 16)}`, { size: 16, color: '64748B' }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(document);
}

module.exports = { buildReportDocx };
