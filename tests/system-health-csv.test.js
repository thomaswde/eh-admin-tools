const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'modules', 'system-health-report.js'),
    'utf8'
);
const context = vm.createContext({
    console,
    window: {},
    document: { getElementById: () => null },
    state: { apiConfig: {} },
    SystemHealthCollection: require('../js/modules/system-health-collection.js')
});
vm.runInContext(source, context);

const csvApi = vm.runInContext(`({
    parseSystemHealthCsv,
    buildSystemHealthReportFromUnifiedCsv,
    systemHealthUnifiedSummaryCsv,
    systemHealthRows
})`, context);

function fixtureReport() {
    const largeId = '90071992547409931234';
    const capacities = {
        model: 'EDA 9300',
        base_packetrate: 10000,
        base_gbps: 10,
        advanced_analysis: 1200,
        standard_analysis: 3800,
        total_analysis: 5000,
        advanced_source: 'api_advanced_analysis_capacity',
        standard_source: 'derived_total_minus_advanced',
        capacity_source: {
            packet_rate: 'model_catalog',
            throughput: 'model_catalog',
            advanced_analysis: 'api_advanced_analysis_capacity',
            standard_analysis: 'derived_total_minus_advanced'
        }
    };
    return {
        source_type: 'api',
        generated_at: '2026-07-25T12:00:00.000Z',
        window: {
            lookback_days: 7,
            from_ms: 1000,
            until_ms: 2000
        },
        requested_cycle: 'auto',
        cycle: '5min',
        capacity_catalog_loaded: true,
        errors: ['sensor warning'],
        appliances: [
            {
                id: largeId,
                name: 'sensor, one',
                hostname: 'sensor-1',
                platform: 'Discover',
                license_platform: 'EDA 9300',
                uuid: 'sensor-uuid',
                status_message: 'Online',
                online: true,
                metric_eligible: true,
                data_access: true,
                license_status: 'nominal',
                sync_time: 100,
                firmware_version: '9.9.9',
                advanced_analysis_capacity: 1200,
                total_capacity: 5000,
                health_conditions: [{ type: 'license', status: 'warning', message: 'quoted "condition"' }],
                capacity: capacities
            },
            {
                id: '8',
                name: 'zero sensor',
                hostname: 'sensor-8',
                platform: 'Discover',
                license_platform: 'EDA 9300',
                status_message: 'Online',
                online: true,
                metric_eligible: true,
                data_access: true,
                license_status: 'nominal',
                health_conditions: [],
                capacity: capacities
            }
        ],
        device_analysis: {
            [largeId]: { advanced: 100, standard: 200, discovery: 3, unrecognized: 1, total: 304, status: 'complete' },
            '8': { advanced: 0, standard: 0, discovery: 0, unrecognized: 0, total: 0, status: 'zero_valued' }
        },
        metrics: {
            pkts: {
                aggregation_mode: 'time_series',
                rows: [],
                sensor_status: {
                    [largeId]: { status: 'complete' },
                    '8': { status: 'zero_valued' }
                },
                summary: {
                    peak_values: { [largeId]: 6000, '8': 0 },
                    peak_duration_ms: { [largeId]: 3000, '8': 300000 },
                    peak_times: { [largeId]: 1500, '8': 1500 },
                    actual_cycles: { [largeId]: '5min', '8': '5min' }
                }
            },
            bytes: {
                aggregation_mode: 'time_series',
                rows: [],
                sensor_status: {
                    [largeId]: { status: 'complete' },
                    '8': { status: 'zero_valued' }
                },
                summary: {
                    peak_values: { [largeId]: 375000000, '8': 0 },
                    peak_duration_ms: { [largeId]: 3000, '8': 300000 },
                    peak_times: { [largeId]: 1500, '8': 1500 },
                    actual_cycles: { [largeId]: '5min', '8': '5min' }
                }
            },
            trigger_cycles: {
                aggregation_mode: 'time_series',
                rows: [],
                sensor_status: {
                    [largeId]: { status: 'complete' },
                    '8': { status: 'zero_valued' }
                },
                summary: { actual_cycles: { [largeId]: '5min', '8': '5min' } }
            },
            trigger_cycles_avail: {
                aggregation_mode: 'time_series',
                rows: [],
                sensor_status: {
                    [largeId]: { status: 'complete' },
                    '8': { status: 'zero_valued' }
                },
                summary: { actual_cycles: { [largeId]: '5min', '8': '5min' } }
            },
            trigger_drops: {
                aggregation_mode: 'total_by_object',
                rows: [],
                sensor_status: {
                    [largeId]: { status: 'zero_valued' },
                    '8': { status: 'zero_valued' }
                },
                summary: {
                    aggregation_mode: 'total_by_object',
                    totals: { [largeId]: 0, '8': 0 },
                    aggregation_duration_ms: { [largeId]: 604800000, '8': 604800000 },
                    peak_values: {}
                }
            }
        },
        trigger_utilization: {
            aggregation_mode: 'aligned_time_series_ratio',
            zero_available_policy: 'invalid_bucket_excluded',
            peak_by_sensor: {
                [largeId]: {
                    used_cycles: 90,
                    available_cycles: 100,
                    utilization: 0.9,
                    timestamp_ms: 1500,
                    duration_ms: 300000,
                    actual_cycle: '5min'
                },
                '8': {
                    used_cycles: 0,
                    available_cycles: 100,
                    utilization: 0,
                    timestamp_ms: 1500,
                    duration_ms: 300000,
                    actual_cycle: '5min'
                }
            },
            invalid_by_sensor: {}
        }
    };
}

test('one unified summary CSV round-trips every chart input and report metadata', () => {
    const original = fixtureReport();
    const csv = csvApi.systemHealthUnifiedSummaryCsv(original);
    const parsed = csvApi.parseSystemHealthCsv(csv);
    const loaded = csvApi.buildSystemHealthReportFromUnifiedCsv(parsed);
    const rows = csvApi.systemHealthRows(loaded);
    const first = rows.find(row => row.id === '90071992547409931234');

    assert.equal(parsed.length, 2);
    assert.equal(loaded.source_type, 'summary_csv');
    assert.equal(loaded.generated_at, original.generated_at);
    assert.equal(loaded.window.lookback_days, 7);
    assert.equal(loaded.window.from_ms, 1000);
    assert.equal(loaded.window.until_ms, 2000);
    assert.deepEqual(Array.from(loaded.errors), ['sensor warning']);

    assert.equal(first.name, 'sensor, one');
    assert.equal(first.packetPeak, 2000);
    assert.equal(first.packetCapacity, 10000);
    assert.equal(first.throughputGbps, 1);
    assert.equal(first.throughputCapacity, 10);
    assert.equal(first.triggerCyclesPeak, 90);
    assert.equal(first.triggerCyclesAvail, 100);
    assert.equal(first.triggerUtilization, 0.9);
    assert.equal(first.triggerDropsTotal, 0);
    assert.equal(first.analysis.advanced, 100);
    assert.equal(first.analysis.standard, 200);
    assert.equal(first.analysis.discovery, 3);
    assert.equal(first.advancedCapacity, 1200);
    assert.equal(first.standardCapacity, 3800);
    assert.equal(first.collectionStatus.pkts, 'complete');
    assert.equal(first.collectionStatus.trigger_drops, 'zero_valued');
    assert.equal(first.health_conditions[0].message, 'quoted "condition"');
});

test('unified CSV preserves opaque IDs and legitimate zero values', () => {
    const csv = csvApi.systemHealthUnifiedSummaryCsv(fixtureReport());
    const loaded = csvApi.buildSystemHealthReportFromUnifiedCsv(csvApi.parseSystemHealthCsv(csv));
    const rows = csvApi.systemHealthRows(loaded);
    const zero = rows.find(row => row.id === '8');

    assert.ok(rows.some(row => row.id === '90071992547409931234'));
    assert.equal(zero.packetPeak, 0);
    assert.equal(zero.throughputGbps, 0);
    assert.equal(zero.triggerUtilization, 0);
    assert.equal(zero.triggerDropsTotal, 0);
    assert.equal(zero.collectionStatus.pkts, 'zero_valued');
    assert.equal(zero.collectionStatus.device_analysis, 'zero_valued');
});

test('load rejects legacy or incomplete CSVs instead of drawing misleading charts', () => {
    const rows = csvApi.parseSystemHealthCsv('appliance_id,packet_peak_pps\n7,100\n');
    assert.throws(
        () => csvApi.buildSystemHealthReportFromUnifiedCsv(rows),
        /not a unified system health summary CSV/
    );
});

test('load rejects sensor rows mixed from different report windows', () => {
    const rows = csvApi.parseSystemHealthCsv(csvApi.systemHealthUnifiedSummaryCsv(fixtureReport()));
    rows[1].report_until_ms = '9999';
    assert.throws(
        () => csvApi.buildSystemHealthReportFromUnifiedCsv(rows),
        /inconsistent report_until_ms/
    );
});
