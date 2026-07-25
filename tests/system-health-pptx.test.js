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
        palette: { bg: '#ffffff', text: '#261f63', low: '#00aaef', mid: '#f05918', high: '#ec0089' },
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
