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
    assert.match(model.findings[0].finding_text, /Packet rate data empty/);
    assert.equal(model.overview.trigger_drops, 0);
    assert.equal(model.filename, 'system-health-review-hoolicorp-2026-07-25.pptx');
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
