const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'modules', 'system-health-pptx.js'),
    'utf8'
);
const window = {};
vm.runInContext(source, vm.createContext({ window, console }));
const pptxApi = window.SystemHealthPptx;

const meta = {
    generated_at: '2026-07-25T12:00:00.000Z',
    lookback_days: 7,
    from_ms: Date.UTC(2026, 6, 18),
    until_ms: Date.UTC(2026, 6, 25),
    cycle_label: '5min',
    target_label: 'hoolicorp'
};

test('empty PowerPoint dialog fields resolve to useful report-derived defaults', () => {
    const options = pptxApi.resolveOptions(meta, {
        title: '   ',
        customer: '',
        prepared_by: '',
        window_label: ' ',
        context: ''
    });

    assert.deepEqual(JSON.parse(JSON.stringify(options)), {
        title: 'System Health Review',
        customer: 'hoolicorp',
        prepared_by: '',
        window_label: 'Last 7 days',
        context: ''
    });
});

test('provided PowerPoint dialog values override defaults without changing report metadata', () => {
    const options = pptxApi.resolveOptions(meta, {
        title: 'Quarterly Capacity Review',
        customer: 'Hooli',
        prepared_by: 'Platform Engineering',
        window_label: 'Q3 validation window',
        context: 'Focus on growth and trigger reliability.'
    });

    assert.equal(options.title, 'Quarterly Capacity Review');
    assert.equal(options.customer, 'Hooli');
    assert.equal(options.prepared_by, 'Platform Engineering');
    assert.equal(options.window_label, 'Q3 validation window');
    assert.equal(options.context, 'Focus on growth and trigger reliability.');
    assert.equal(meta.cycle_label, '5min');
});

test('deck model keeps legitimate zero values distinct from unavailable collection data', () => {
    const baseRow = {
        license_platform: 'EDA 9300',
        online: true,
        offline: false,
        data_access: true,
        packetCapacity: 10000,
        throughputCapacity: 10,
        triggerCyclesAvail: 100,
        advancedCapacity: 1000,
        standardCapacity: 4000,
        triggerDropsTotal: 0,
        health_conditions: []
    };
    const model = pptxApi.buildDeckModel({
        meta,
        options: {},
        palette: { bg: '#ffffff', text: '#16151f', low: '#00aaef', mid: '#f59e0b', high: '#ef4444' },
        charts: [],
        rows: [
            {
                ...baseRow,
                id: 'zero',
                name: 'Measured zero',
                packetPeak: 0,
                throughputGbps: 0,
                triggerUtilization: 0,
                analysis: { advanced: 0, standard: 0, discovery: 0 },
                collectionStatus: {
                    pkts: 'zero_valued', bytes: 'zero_valued', trigger_utilization: 'zero_valued',
                    trigger_drops: 'zero_valued', device_analysis: 'zero_valued'
                }
            },
            {
                ...baseRow,
                id: 'missing',
                name: 'Missing packet data',
                packetPeak: null,
                throughputGbps: 0,
                triggerUtilization: 0,
                analysis: { advanced: 0, standard: 0, discovery: 0 },
                collectionStatus: {
                    pkts: 'empty', bytes: 'zero_valued', trigger_utilization: 'zero_valued',
                    trigger_drops: 'zero_valued', device_analysis: 'zero_valued'
                }
            }
        ]
    });

    assert.equal(model.rows.length, 2);
    assert.equal(model.findings.length, 1);
    assert.equal(model.findings[0].name, 'Missing packet data');
    assert.match(model.findings[0].finding_text, /No data returned for packet rate/);
    assert.equal(model.overview.trigger_drops, 0);
    assert.equal(model.filename, 'system-health-review-hoolicorp-2026-07-25.pptx');
});

// Fixture builder for the roll-up tests below.
function sensorRow(overrides = {}) {
    return {
        license_platform: 'EDA 9300', online: true, offline: false, data_access: true,
        packetPeak: 10, packetCapacity: 10000, throughputGbps: 0, throughputCapacity: 10,
        triggerCyclesPeak: 0, triggerCyclesAvail: 100, triggerUtilization: 0,
        triggerDropsTotal: 0, advancedCapacity: 1000, standardCapacity: 4000,
        analysis: { advanced: 0, standard: 0, discovery: 0 }, health_conditions: [],
        collectionStatus: {
            pkts: 'complete', bytes: 'complete', trigger_utilization: 'complete',
            trigger_drops: 'zero_valued', device_analysis: 'complete'
        },
        ...overrides
    };
}

class FakePptx {
    constructor() {
        this._slides = [];
        this.ShapeType = { line: 'line', rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse' };
    }

    addSlide() {
        const slide = {
            texts: [], shapes: [], tables: [], images: [], notes: [],
            addText(text, options = {}) { this.texts.push({ text: String(text), options }); },
            addShape(type, options = {}) { this.shapes.push({ type, options }); },
            addTable(rows, options = {}) { this.tables.push({ rows, options }); },
            addImage(options = {}) { this.images.push(options); },
            addNotes(notes) { this.notes.push(notes); }
        };
        this._slides.push(slide);
        return slide;
    }
}

function presentationFor(rows) {
    const model = pptxApi.buildDeckModel({
        meta,
        palette: { bg: '#ffffff', text: '#16151f', low: '#00aaef', mid: '#f59e0b', high: '#ef4444' },
        rows
    });
    return { model, pptx: pptxApi.createPresentation(model, FakePptx) };
}

function presentationText(pptx) {
    return pptx._slides.flatMap(slide => slide.texts.map(item => item.text)).join('\n');
}

test('sensors that returned no data roll up instead of filling the findings table', () => {
    const rows = [
        sensorRow({ id: 'up', name: 'Reporting sensor' }),
        sensorRow({ id: 'hot', name: 'Busy sensor', packetPeak: 10000 }),
        ...Array.from({ length: 12 }, (_, index) => sensorRow({
            id: `down-${index}`, name: `Offline sensor ${index}`, online: false, offline: true
        })),
        sensorRow({ id: 'blocked', name: 'No access sensor', data_access: false })
    ];
    const model = pptxApi.buildDeckModel({ meta, rows });

    // Every sensor survives into the appendix rows; only the narrative shrinks.
    assert.equal(model.rows.length, 15);
    assert.equal(model.overview.sensors, 15);
    assert.equal(model.overview.absent, 13);
    assert.equal(model.overview.offline, 12);
    assert.equal(model.overview.no_access, 1);
    assert.equal(model.overview.reporting, 2);

    // The 13 absent sensors contribute no findings rows at all.
    assert.equal(model.findings.length, 1);
    assert.equal(model.findings[0].name, 'Busy sensor');
    assert.ok(model.findings.every(item => !item.absent));
    assert.equal(model.absent.length, 13);
});

test('IDS and EFC device-analysis gaps are expected and do not create findings', () => {
    const roleRows = [
        sensorRow({
            id: 'ids', name: 'IDS sensor', license_platform: '', platform: 'ids_standalone',
            advancedCapacity: null, standardCapacity: null,
            analysis: { advanced: null, standard: null, discovery: null },
            collectionStatus: { ...sensorRow().collectionStatus, device_analysis: 'empty' }
        }),
        sensorRow({
            id: 'efc', name: 'Flow collector', license_platform: '', platform: 'flow_collector',
            advancedCapacity: null, standardCapacity: null,
            analysis: { advanced: null, standard: null, discovery: null },
            collectionStatus: { ...sensorRow().collectionStatus, device_analysis: 'empty' }
        })
    ];
    const { model, pptx } = presentationFor(roleRows);

    assert.equal(model.findings.length, 0);
    assert.equal(model.overview.reporting, 2);
    assert.equal(model.overview.healthy, 2);
    assert.doesNotMatch(presentationText(pptx), /incomplete collection/i);
});

test('offline hero, chart caption, recommendation colors, and Source Sans 3 are preserved', () => {
    const rows = [
        sensorRow({ id: 'busy', name: 'Busy sensor', packetPeak: 9000 }),
        sensorRow({ id: 'offline', name: 'Offline sensor', online: false, offline: true })
    ];
    const { pptx } = presentationFor(rows);
    const allText = presentationText(pptx);

    assert.equal(pptx.theme.headFontFace, 'Source Sans 3');
    assert.equal(pptx.theme.bodyFontFace, 'Source Sans 3');
    assert.match(allText, /Offline appliance/);
    assert.match(allText, /1 offline sensor not shown/);
    assert.doesNotMatch(allText, /supplied a usable value|excluded rather than shown as zero/);

    const overviewSlide = pptx._slides.find(slide => slide.texts.some(item => item.text === 'Fleet health at a glance'));
    const offlineHero = overviewSlide.texts.find(item => item.text === 'Offline appliance');
    assert.equal(offlineHero.options.color, 'EF4444');

    const recommendationSlide = pptx._slides.find(slide => slide.texts.some(item => item.text === 'Recommended next steps'));
    const bulletColors = recommendationSlide.shapes
        .filter(shape => shape.type === 'ellipse')
        .map(shape => shape.options.fill.color);
    assert.deepEqual(bulletColors, ['EF4444', 'F59E0B']);
});

test('offline hero is omitted when the fleet has no offline appliances', () => {
    const { pptx } = presentationFor([sensorRow({ id: 'healthy', name: 'Healthy sensor' })]);
    assert.doesNotMatch(presentationText(pptx), /Offline appliance/);
});

test('verdict names the dominant condition rather than the first one found', () => {
    const mostlyDown = pptxApi.buildDeckModel({
        meta,
        rows: [
            sensorRow({ id: 'up', name: 'Reporting sensor' }),
            ...Array.from({ length: 9 }, (_, index) => sensorRow({
                id: `down-${index}`, name: `Offline ${index}`, online: false, offline: true
            }))
        ]
    });
    assert.match(mostlyDown.verdict, /9 of 10 sensors returned no data/);
    assert.match(mostlyDown.recommendations[0], /Restore connectivity for the 9 sensors/);

    const allHealthy = pptxApi.buildDeckModel({
        meta,
        rows: [sensorRow({ id: 'a', name: 'A' }), sensorRow({ id: 'b', name: 'B' })]
    });
    assert.match(allHealthy.verdict, /All 2 sensors are reporting and within capacity/);
});

test('findings separate the headline condition from its supporting evidence', () => {
    const model = pptxApi.buildDeckModel({
        meta,
        rows: [sensorRow({
            id: 'drops', name: 'Dropping sensor',
            triggerDropsTotal: 800133, triggerUtilization: 0.45,
            triggerCyclesPeak: 45, triggerCyclesAvail: 100
        })]
    });
    const finding = model.findings[0];

    assert.equal(finding.condition, 'Trigger drops');
    assert.match(finding.evidence, /800,133 drops/);
    assert.match(finding.evidence, /45% of available cycles/);
    // The headline must not be restated inside its own evidence.
    assert.ok(!finding.evidence.startsWith('Trigger drops'));
    assert.equal(model.overview.at_capacity, 0);
    assert.match(model.verdict, /none are at a hard capacity limit/);
});

test('evidence names additional conditions instead of restating each in full', () => {
    // A sensor tripping every threshold at once: the row this deck exists to
    // present without turning into the seven-clause dump it replaced.
    const model = pptxApi.buildDeckModel({
        meta,
        rows: [sensorRow({
            id: 'everything', name: 'Overloaded sensor',
            packetPeak: 9800, packetCapacity: 10000,
            throughputGbps: 9.5, throughputCapacity: 10,
            triggerCyclesPeak: 99, triggerCyclesAvail: 100, triggerUtilization: 0.99,
            triggerDropsTotal: 361605,
            analysis: { advanced: 250, standard: 500, discovery: 6 },
            advancedCapacity: 250, standardCapacity: 500,
            health_conditions: [{ type: 'license_status', status: 'warning', message: 'license status is unknown' }]
        })]
    });
    const finding = model.findings[0];

    assert.equal(finding.severity, 'CRITICAL');
    // Many conditions were detected...
    assert.ok(finding.findings.length >= 6, `expected several conditions, got ${finding.findings.length}`);
    // ...but the row stays legible: one quantified headline plus named extras.
    assert.ok(finding.evidence.length <= 130, `evidence too long: ${finding.evidence}`);
    assert.match(finding.evidence, /also /);
    assert.match(finding.evidence, /\+\d+ more/);
    // Every condition remains available for the appendix and speaker notes.
    assert.ok(finding.finding_text.length > finding.evidence.length);
});

test('deck findings use the System Health 80 and 100 percent thresholds', () => {
    const model = pptxApi.buildDeckModel({
        meta,
        rows: [
            {
                id: 'warn', name: 'Warning sensor', license_platform: 'EDA', online: true, offline: false,
                data_access: true, packetPeak: 80, packetCapacity: 100, throughputGbps: 0, throughputCapacity: 10,
                triggerUtilization: 0, triggerDropsTotal: 0, advancedCapacity: 100, standardCapacity: 100,
                analysis: { advanced: 0, standard: 0, discovery: 0 }, health_conditions: [],
                collectionStatus: { pkts: 'complete', bytes: 'complete', trigger_utilization: 'complete', trigger_drops: 'zero_valued', device_analysis: 'complete' }
            },
            {
                id: 'critical', name: 'Critical sensor', license_platform: 'EDA', online: true, offline: false,
                data_access: true, packetPeak: 100, packetCapacity: 100, throughputGbps: 0, throughputCapacity: 10,
                triggerUtilization: 0, triggerDropsTotal: 0, advancedCapacity: 100, standardCapacity: 100,
                analysis: { advanced: 0, standard: 0, discovery: 0 }, health_conditions: [],
                collectionStatus: { pkts: 'complete', bytes: 'complete', trigger_utilization: 'complete', trigger_drops: 'zero_valued', device_analysis: 'complete' }
            }
        ]
    });

    assert.equal(model.findings[0].severity, 'CRITICAL');
    assert.equal(model.findings[1].severity, 'WARNING');
    assert.match(model.findings[0].finding_text, /100% of capacity/);
    assert.match(model.findings[1].finding_text, /80% of capacity/);
});

test('PowerPoint adds one consolidated Packetstore health slide instead of per-metric slides', () => {
    const model = pptxApi.buildDeckModel({
        meta,
        rows: [sensorRow({ id: 'sensor', name: 'Sensor' })],
        packetstore_rows: [{
            id: 'sensor', name: 'Sensor', appliance_role: 'packet_sensor',
            lookbackLatestSec: 172800, lookbackMinSec: 86400,
            packetsTotal: 1000, packetDropsTotal: 10, packetDropRatio: 0.01,
            slowWriteDropsTotal: 4, interfaceDropsTotal: 3,
            secretsTotal: 100, secretDropsTotal: 2, secretDropRatio: 0.02,
            inputLoadPeak: 55, compressionLoadPeak: 12, diskWriteLoadPeak: 81
        }]
    });
    const pptx = pptxApi.createPresentation(model, FakePptx);
    const packetstoreSlides = pptx._slides.filter(slide => slide.texts.some(item => item.text === 'Packetstore health'));
    assert.equal(model.overview.packetstores, 1);
    assert.equal(model.overview.packetstores_with_loss, 1);
    assert.equal(packetstoreSlides.length, 1);
    assert.equal(packetstoreSlides[0].tables.length, 1);
    assert.equal(packetstoreSlides[0].tables[0].rows.length, 2);
    assert.equal(packetstoreSlides[0].tables[0].options.valign, 'middle');
});

/* --------------------------------------------------------- packetstores */

function packetstoreRow(overrides = {}) {
    return {
        id: 'sensor', name: 'Packetstore sensor', appliance_role: 'packet_sensor',
        lookbackLatestSec: 172800, lookbackMinSec: 86400,
        packetsTotal: 1000, packetDropsTotal: 0, packetDropRatio: 0,
        slowWriteDropsTotal: 0, interfaceDropsTotal: 0,
        secretsTotal: 100, secretDropsTotal: 0, secretDropRatio: 0,
        inputLoadPeak: 20, compressionLoadPeak: 12, diskWriteLoadPeak: 15,
        ...overrides
    };
}

test('capture loss reaches the verdict and the actions slide even when every sensor is healthy', () => {
    const model = pptxApi.buildDeckModel({
        meta,
        rows: [sensorRow({ id: 'sensor', name: 'Healthy sensor' })],
        packetstore_rows: [
            packetstoreRow({ id: 'lossy', name: 'Lossy store', packetDropsTotal: 10, packetDropRatio: 0.01 }),
            packetstoreRow({ id: 'clean', name: 'Clean store' })
        ]
    });

    assert.equal(model.overview.packetstores_with_loss, 1);
    // The sensor half of the verdict is unchanged; the packetstore clause is
    // appended so the deck never reads as an all-clear while evidence is lost.
    assert.match(model.verdict, /All 1 sensors are reporting and within capacity thresholds/);
    assert.match(model.verdict, /1 packetstore of 2 dropped capture data/);
    assert.match(model.recommendations.join(' '), /Investigate capture loss on 1 of 2 packetstores/);
});

test('packetstore processing pressure is reported only when no capture was lost', () => {
    const loaded = pptxApi.buildDeckModel({
        meta,
        rows: [sensorRow({ id: 'sensor', name: 'Healthy sensor' })],
        packetstore_rows: [packetstoreRow({ id: 'hot', name: 'Hot store', diskWriteLoadPeak: 88 })]
    });
    assert.equal(loaded.overview.packetstores_loaded, 1);
    assert.match(loaded.verdict, /peaked at or above 80% processing load without losing capture data/);
    assert.match(loaded.recommendations.join(' '), /Confirm headroom on 1 packetstore peaking at or above 80%/);

    const loadedPptx = pptxApi.createPresentation(loaded, FakePptx);
    const loadedActions = loadedPptx._slides.find(slide => slide.texts.some(item => item.text === 'Recommended next steps'));
    assert.equal(loadedActions.shapes.find(shape => shape.type === 'ellipse').options.fill.color, 'F59E0B');

    // Loss outranks load: a store doing both gets the loss language only, so the
    // reader is never given two competing calls to action for one appliance.
    const both = pptxApi.buildDeckModel({
        meta,
        rows: [sensorRow({ id: 'sensor', name: 'Healthy sensor' })],
        packetstore_rows: [packetstoreRow({
            id: 'hot', name: 'Hot store', diskWriteLoadPeak: 88, packetDropsTotal: 5, packetDropRatio: 0.005
        })]
    });
    assert.doesNotMatch(both.recommendations.join(' '), /Confirm headroom/);
    assert.match(both.recommendations.join(' '), /Investigate capture loss/);
});

test('a clean packetstore fleet is stated rather than left silent', () => {
    const model = pptxApi.buildDeckModel({
        meta,
        rows: [sensorRow({ id: 'sensor', name: 'Healthy sensor' })],
        packetstore_rows: [packetstoreRow()]
    });
    assert.match(model.verdict, /All 1 packetstore captured without loss/);
});

test('Packetstore metric sources remain a sensor subset without double-counting models', () => {
    const model = pptxApi.buildDeckModel({
        meta,
        rows: [
            sensorRow({ id: 'aio', name: 'All in one', license_platform: 'EDA 6320' }),
            sensorRow({ id: 'paired', name: 'Paired sensor', license_platform: 'EDA 8320' }),
            sensorRow({ id: 'plain', name: 'Packet sensor', license_platform: 'EDA 9320' })
        ],
        packetstore_rows: [
            packetstoreRow({ id: 'aio', name: 'All in one', appliance_role: 'all_in_one', license_platform: 'EDA 6320' }),
            packetstoreRow({ id: 'paired', name: 'Paired sensor', appliance_role: 'packet_sensor', license_platform: 'EDA 8320' })
        ]
    });

    assert.equal(model.overview.sensors, 3);
    assert.equal(model.overview.packetstores, 2);
    assert.equal(model.overview.packetstores_all_in_one, 1);
    assert.equal(model.overview.packetstores_paired, 1);
    // Both Packetstore rows are already present in the sensor inventory.
    const counts = Object.fromEntries(model.overview.model_counts);
    assert.deepEqual(counts, { 'EDA 6320': 1, 'EDA 8320': 1, 'EDA 9320': 1 });

    const pptx = pptxApi.createPresentation(model, FakePptx);
    const overviewSlide = pptx._slides.find(slide => slide.texts.some(item => item.text === 'Fleet health at a glance'));
    const overviewText = overviewSlide.texts.map(item => item.text).join(' | ');
    assert.match(overviewText, /Packetstores losing data/);
    assert.match(overviewText, /1 paired · 1 all-in-one/);
    assert.match(overviewText, /3 sensors · 2 packetstores/);
});

test('the three packetstore charts are drawn as native shapes and label their own scale', () => {
    const model = pptxApi.buildDeckModel({
        meta,
        rows: [sensorRow({ id: 'sensor', name: 'Sensor' })],
        packetstore_rows: [
            packetstoreRow({ id: 'a', name: 'Store A', packetDropsTotal: 10, packetDropRatio: 0.01 }),
            packetstoreRow({ id: 'b', name: 'Store B', appliance_role: 'all_in_one' })
        ]
    });
    const pptx = pptxApi.createPresentation(model, FakePptx);
    const titleOf = title => pptx._slides.find(slide => slide.texts.some(item => item.text === title));

    ['Packetstore retention', 'Capture and secret fidelity', 'Packetstore processing load']
        .forEach(title => assert.ok(titleOf(title), `missing chart slide: ${title}`));

    // Charts stay vector: bars are shapes, never images.
    const retention = titleOf('Packetstore retention');
    assert.ok(retention.shapes.filter(shape => shape.type === 'rect').length >= 2);
    assert.equal((retention.images || []).length, 0);
    // Retention is reported, not scored, so the slide says so out loud.
    assert.match(retention.texts.map(item => item.text).join(' '), /no customer retention target is collected/);

    // Load is the only packetstore chart with a capacity, so it is the only one
    // that draws the 80% guide.
    const load = titleOf('Packetstore processing load');
    assert.ok(load.texts.some(item => item.text === '80%'));
    assert.ok(!retention.texts.some(item => item.text === '80%'));

    // Both roles are labeled on the chart itself, matching the health table.
    const loadText = load.texts.map(item => item.text).join(' | ');
    assert.match(loadText, /All in One/);
    assert.match(loadText, /Packetstore/);

    const fidelity = titleOf('Capture and secret fidelity');
    const fidelityText = fidelity.texts.map(item => item.text).join(' | ');
    assert.match(fidelityText, /100% OF OFFERED TOTAL/);
    assert.match(fidelityText, /fixed 0–100% scale/);
    assert.match(fidelityText, /secrets 0% \(0 \/ 100\)/);
    const packetDropBar = fidelity.shapes.find(shape => shape.type === 'rect'
        && shape.options.fill && shape.options.fill.color === 'EF4444');
    assert.ok(packetDropBar.options.w < 0.1, 'a 1% drop rate should occupy about 1% of the chart width');
});

test('retention charts rank shortest positive lookback first and omit zero lookback rows', () => {
    const model = pptxApi.buildDeckModel({
        meta,
        rows: [sensorRow({ id: 'sensor', name: 'Sensor' })],
        packetstore_rows: [
            packetstoreRow({ id: 'long', name: 'Long retention', lookbackLatestSec: 259200 }),
            packetstoreRow({ id: 'missing', name: 'Missing retention', lookbackLatestSec: 0 }),
            packetstoreRow({ id: 'short', name: 'Short retention', lookbackLatestSec: 86400 })
        ]
    });
    const pptx = pptxApi.createPresentation(model, FakePptx);
    const slide = pptx._slides.find(s => s.texts.some(item => item.text === 'Packetstore retention'));
    const labels = slide.texts.map(item => item.text);
    assert.ok(labels.indexOf('Short retention') < labels.indexOf('Long retention'));
    assert.equal(labels.includes('Missing retention'), false);
});

test('small drop rates never round to zero, and the highlight follows the actual loss', () => {
    const model = pptxApi.buildDeckModel({
        meta,
        rows: [sensorRow({ id: 'sensor', name: 'Sensor' })],
        packetstore_rows: [
            // Loses 0.017% of packets: rounding this to 0% beside a loss warning
            // would read as a contradiction.
            packetstoreRow({ id: 'tiny', name: 'Tiny loss', packetDropsTotal: 1400000, packetDropRatio: 0.00017 }),
            // Loses only interface frames, so the ratio line is honestly 0%.
            packetstoreRow({ id: 'frames', name: 'Frame loss', interfaceDropsTotal: 3100 })
        ]
    });
    const pptx = pptxApi.createPresentation(model, FakePptx);
    const slide = pptx._slides.find(s => s.texts.some(item => item.text === 'Capture and secret fidelity'));
    const find = pattern => slide.texts.find(item => pattern.test(item.text));

    assert.match(find(/^packets/).text, /packets 0\.02%/);
    assert.equal(find(/packets 0\.02%/).options.color, 'EF4444');

    // The frame-loss store keeps a plain 0% ratio line and moves the highlight
    // to the counter line that carries the loss.
    const ratioLine = slide.texts.filter(item => /^packets 0% /.test(item.text))[0];
    assert.ok(!ratioLine.options.bold);
    const noteLine = slide.texts.find(item => /interface 3,100/.test(item.text));
    assert.equal(noteLine.options.color, 'EF4444');

    const healthTable = pptx._slides.find(s => s.texts.some(item => item.text === 'Packetstore health'));
    const fidelityCells = healthTable.tables[0].rows.slice(1).map(row => row[2].text);
    assert.ok(fidelityCells.some(text => /Packets 0\.02%/.test(text)));

    const actions = pptx._slides.find(s => s.texts.some(item => item.text === 'Recommended next steps'));
    assert.equal(actions.shapes.find(shape => shape.type === 'ellipse').options.fill.color, 'EF4444');
});

test('counter-only loss remains visible when fidelity denominators are unavailable', () => {
    const model = pptxApi.buildDeckModel({
        meta,
        rows: [sensorRow({ id: 'sensor', name: 'Sensor' })],
        packetstore_rows: [packetstoreRow({
            id: 'counter-only', name: 'Counter only loss',
            packetDropRatio: null, secretDropRatio: null,
            packetsTotal: null, secretsTotal: null,
            interfaceDropsTotal: 42
        })]
    });
    const pptx = pptxApi.createPresentation(model, FakePptx);
    const slide = pptx._slides.find(s => s.texts.some(item => item.text === 'Capture and secret fidelity'));

    assert.ok(slide, 'counter-only loss should create a fidelity chart');
    assert.match(slide.texts.map(item => item.text).join(' | '), /interface 42/);
    assert.match(slide.texts.map(item => item.text).join(' | '), /packets — · secrets —/);
});

test('measured zero packetstore values do not draw non-zero colored bars', () => {
    const model = pptxApi.buildDeckModel({
        meta,
        rows: [sensorRow({ id: 'sensor', name: 'Sensor' })],
        packetstore_rows: [packetstoreRow({
            lookbackLatestSec: 0, lookbackMinSec: 0,
            inputLoadPeak: 0, compressionLoadPeak: 0, diskWriteLoadPeak: 0
        })]
    });
    const pptx = pptxApi.createPresentation(model, FakePptx);
    assert.equal(pptx._slides.some(slide => slide.texts.some(item => item.text === 'Packetstore retention')), false);
    const chartTitles = ['Capture and secret fidelity', 'Packetstore processing load'];

    chartTitles.forEach(title => {
        const slide = pptx._slides.find(s => s.texts.some(item => item.text === title));
        const coloredBars = slide.shapes.filter(shape => shape.type === 'rect'
            && ['00AAEF', 'F59E0B', 'EF4444'].includes(shape.options.fill && shape.options.fill.color));
        assert.equal(coloredBars.length, 0, `${title} drew a colored bar for a measured zero`);
    });
});

test('sensor-only fleets keep the original four-up overview and gain no packetstore slides', () => {
    const model = pptxApi.buildDeckModel({ meta, rows: [sensorRow({ id: 'sensor', name: 'Sensor' })] });
    const pptx = pptxApi.createPresentation(model, FakePptx);
    const allText = presentationText(pptx);

    assert.equal(model.overview.packetstores, 0);
    assert.doesNotMatch(allText, /Packetstore|packetstore/);
    assert.match(model.verdict, /^All 1 sensors are reporting and within capacity thresholds\.$/);
});

test('the cover carries the gradient alone, with no ring texture drawn over it', () => {
    let ellipseCalls = 0;
    const gradientContext = {
        fillStyle: '',
        createLinearGradient() { return { addColorStop() {} }; },
        fillRect() {},
        beginPath() {},
        ellipse() { ellipseCalls += 1; },
        stroke() {}
    };
    const gradientWindow = {};
    vm.runInContext(source, vm.createContext({
        window: gradientWindow,
        console,
        document: {
            createElement: () => ({
                getContext: () => gradientContext,
                toDataURL: () => 'data:image/png;base64,gradient'
            })
        }
    }));
    const gradientApi = gradientWindow.SystemHealthPptx;
    const model = gradientApi.buildDeckModel({ meta, rows: [sensorRow({ id: 'sensor', name: 'Sensor' })] });
    const pptx = gradientApi.createPresentation(model, FakePptx);
    const cover = pptx._slides[0];
    assert.equal(ellipseCalls, 0);
    assert.equal(cover.shapes.filter(shape => shape.type === 'ellipse').length, 0);
    assert.equal(cover.shapes.filter(shape => shape.type === 'roundRect').length, 1);
});
