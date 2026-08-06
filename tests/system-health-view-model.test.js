const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SystemHealthViewModel = require('../js/modules/system-health-view-model.js');
const SystemHealthCollection = require('../js/modules/system-health-collection.js');

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function measuredSensor(overrides = {}) {
    return {
        id: 'sensor',
        name: 'Sensor',
        license_platform: 'EDA 9300',
        online: true,
        offline: false,
        data_access: true,
        packetPeak: 0,
        packetCapacity: 100,
        throughputGbps: 0,
        throughputCapacity: 10,
        triggerCyclesPeak: 0,
        triggerCyclesAvail: 100,
        triggerUtilization: 0,
        triggerDropsTotal: 0,
        advancedCapacity: 100,
        standardCapacity: 400,
        analysis: { advanced: 0, standard: 0, discovery: 0 },
        health_conditions: [],
        collectionStatus: {
            pkts: 'zero_valued',
            bytes: 'zero_valued',
            trigger_utilization: 'zero_valued',
            trigger_drops: 'zero_valued',
            device_analysis: 'zero_valued'
        },
        ...overrides
    };
}

function lossCounters(overrides = {}) {
    return {
        packetDropsTotal: 0,
        slowWriteDropsTotal: 0,
        interfaceDropsTotal: 0,
        blocksDroppedTotal: 0,
        secretDropsTotal: 0,
        packetDropRatio: 0,
        secretDropRatio: 0,
        ...overrides
    };
}

function projectionReport() {
    return {
        generated_at: '2026-07-26T12:00:00.000Z',
        target: { host: 'sensor.example' },
        window: { from_ms: 1000, until_ms: 61_000, lookback_days: 1 },
        requested_cycle: 'auto',
        cycle: '1min',
        errors: [],
        appliances: [
            {
                id: '7',
                name: 'sensor-7',
                online: true,
                data_access: true,
                appliance_role: 'packet_sensor',
                license_platform: 'EDA 9300',
                health_conditions: [],
                capacity: {
                    base_packetrate: 1000,
                    base_gbps: 10,
                    advanced_analysis: 100,
                    standard_analysis: 400
                }
            }
        ],
        device_analysis: {
            7: { advanced: 0, standard: 0, discovery: 0, total: 0, status: 'zero_valued' }
        },
        metrics: {
            pkts: {
                rows: [{ raw: 'raw-marker' }],
                chunks: [{ raw: 'raw-marker' }],
                sensor_status: { 7: { status: 'zero_valued' } },
                summary: { peak_values: { 7: 0 }, peak_duration_ms: { 7: 60_000 } }
            },
            trigger_drops: {
                sensor_status: { 7: { status: 'zero_valued' } },
                summary: { totals: { 7: 0 } }
            }
        },
        trigger_utilization: { peak_by_sensor: {}, invalid_by_sensor: {} },
        packetstore: { appliance_ids: [], metrics: {} }
    };
}

test('browser row wrappers are exact delegates of the shared projection', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'modules', 'system-health-report.js'), 'utf8');
    const context = vm.createContext({
        console,
        window: {},
        document: {
            getElementById() {
                return null;
            }
        },
        state: { apiConfig: {} },
        SystemHealthCollection,
        SystemHealthViewModel
    });
    vm.runInContext(source, context);
    context.report = projectionReport();

    assert.deepEqual(
        plain(vm.runInContext('systemHealthRows(report)', context)),
        plain(SystemHealthViewModel.projectSensorRows(context.report))
    );
    assert.deepEqual(
        plain(vm.runInContext('systemHealthPacketstoreRows(report)', context)),
        plain(SystemHealthViewModel.projectPacketstoreRows(context.report))
    );
});

test('missing metric families remain visible while legitimate zeros remain measured', () => {
    const report = projectionReport();
    const [row] = SystemHealthViewModel.projectSensorRows(report);
    assert.equal(row.packetPeak, 0);
    assert.equal(row.triggerDropsTotal, 0);
    assert.equal(row.collectionStatus.pkts, 'zero_valued');
    assert.equal(row.collectionStatus.bytes, 'unknown');
    assert.equal(row.collectionStatus.trigger_utilization, 'unknown');

    const model = SystemHealthViewModel.buildNarrativeModel({ rows: [row] });
    assert.equal(model.overview.trigger_drops, 0);
    assert.equal(model.overview.trigger_drops_reporting, 1);
    assert.match(model.findings[0].finding_text, /No data returned for throughput and trigger utilization/);

    const unavailable = SystemHealthViewModel.buildNarrativeModel({
        rows: [
            measuredSensor({
                triggerDropsTotal: null,
                collectionStatus: {
                    ...measuredSensor().collectionStatus,
                    trigger_drops: 'unknown'
                }
            })
        ]
    });
    assert.equal(unavailable.overview.trigger_drops, null);
    assert.equal(unavailable.overview.trigger_drops_reporting, 0);
    assert.equal(unavailable.overview.trigger_drops_unavailable, 1);
});

test('Packetstore loss requires conclusive counters and never turns partial data into clean', () => {
    const clean = lossCounters({ id: 'clean' });
    const partial = lossCounters({
        id: 'partial',
        slowWriteDropsTotal: null,
        interfaceDropsTotal: null,
        blocksDroppedTotal: null,
        secretDropsTotal: null
    });
    const loss = lossCounters({
        id: 'loss',
        packetDropsTotal: 1,
        slowWriteDropsTotal: null,
        interfaceDropsTotal: null,
        blocksDroppedTotal: null,
        secretDropsTotal: null
    });
    assert.equal(SystemHealthViewModel.packetstoreLossStatus(clean), 'clean');
    assert.equal(SystemHealthViewModel.packetstoreLossStatus(partial), 'unavailable');
    assert.equal(SystemHealthViewModel.packetstoreLossStatus(loss), 'loss');

    const model = SystemHealthViewModel.buildNarrativeModel({
        rows: [measuredSensor()],
        packetstore_rows: [clean, partial, loss]
    });
    assert.equal(model.overview.packetstores_with_loss, 1);
    assert.equal(model.overview.packetstores_clean, 1);
    assert.equal(model.overview.packetstores_loss_reporting, 2);
    assert.equal(model.overview.packetstores_loss_unavailable, 1);
    assert.match(model.verdict, /1 of 3 Packetstore sources reported capture loss/);
    assert.match(model.verdict, /unavailable for 1 additional source/);

    const none = SystemHealthViewModel.buildNarrativeModel({
        rows: [measuredSensor()],
        packetstore_rows: [partial]
    });
    assert.match(none.verdict, /Capture-loss status was unavailable for all 1 Packetstore sources/);
    assert.doesNotMatch(none.verdict, /reported no capture loss/);
    assert.match(none.recommendations.join(' '), /before concluding that capture was lossless/);
});

test('shared capacity and loss thresholds preserve exact boundary semantics', () => {
    const model = SystemHealthViewModel.buildNarrativeModel({
        rows: [
            measuredSensor({ id: 'below', name: 'Below', packetPeak: 79.9 }),
            measuredSensor({ id: 'watch', name: 'Watch', packetPeak: 80 }),
            measuredSensor({ id: 'full', name: 'Full', packetPeak: 100 })
        ]
    });
    assert.deepEqual(
        model.findings.map((item) => [item.name, item.severity]),
        [
            ['Full', 'CRITICAL'],
            ['Watch', 'WARNING']
        ]
    );
    assert.equal(
        SystemHealthViewModel.packetstoreLossSeverity(lossCounters({ packetDropsTotal: 1, packetDropRatio: 0.0001 })),
        'clean'
    );
    assert.equal(
        SystemHealthViewModel.packetstoreLossSeverity(lossCounters({ packetDropsTotal: 1, packetDropRatio: 0.001 })),
        'warning'
    );
    assert.equal(
        SystemHealthViewModel.packetstoreLossSeverity(lossCounters({ packetDropsTotal: 1, packetDropRatio: 0.01 })),
        'warning'
    );
    assert.equal(
        SystemHealthViewModel.packetstoreLossSeverity(lossCounters({ packetDropsTotal: 2, packetDropRatio: 0.010001 })),
        'critical'
    );
});

test('Packetstore row highlighting ignores measured drop rates below one tenth of a percent', () => {
    assert.equal(
        SystemHealthViewModel.isPacketstoreRowHighlighted(
            lossCounters({ packetDropsTotal: 1, packetDropRatio: 0.000999 })
        ),
        false
    );
    assert.equal(
        SystemHealthViewModel.isPacketstoreRowHighlighted(
            lossCounters({ packetDropsTotal: 1, packetDropRatio: 0.001 })
        ),
        true
    );
    assert.equal(
        SystemHealthViewModel.isPacketstoreRowHighlighted(lossCounters({ packetDropsTotal: 1, packetDropRatio: null })),
        true
    );
    assert.equal(SystemHealthViewModel.isPacketstoreRowHighlighted(lossCounters({ diskWriteLoadPeak: 80 })), true);
});

test('PowerPoint model narrative is identical to the shared renderer-independent model', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'modules', 'system-health-pptx.js'), 'utf8');
    const window = { SystemHealthViewModel };
    vm.runInContext(source, vm.createContext({ window, console }));
    const input = {
        meta: { generated_at: '2026-07-26T12:00:00Z', target_label: 'example' },
        rows: [measuredSensor({ packetPeak: 80 })],
        packetstore_rows: [lossCounters()]
    };
    const shared = SystemHealthViewModel.buildNarrativeModel(input);
    const pptx = window.SystemHealthPptx.buildDeckModel(input);
    for (const key of ['rows', 'packetstore_rows', 'findings', 'absent', 'overview', 'verdict', 'recommendations']) {
        assert.deepEqual(plain(pptx[key]), plain(shared[key]), key);
    }
});

test('compact renderer projection contains no raw metric series or nested finding rows', () => {
    const projection = SystemHealthViewModel.buildRendererProjection(projectionReport());
    const fixture = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'fixtures', 'system-health-renderer-v1.json'), 'utf8')
    );
    const serialized = JSON.stringify(projection);
    assert.deepEqual(plain(projection), fixture);
    assert.equal(projection.schema_version, '1');
    assert.equal(projection.sensor_summaries.length, 1);
    assert.equal(Object.hasOwn(projection, 'metrics'), false);
    assert.equal(Object.hasOwn(projection, 'appliances'), false);
    assert.equal(
        projection.findings.every((finding) => !Object.hasOwn(finding, 'row')),
        true
    );
    assert.doesNotMatch(serialized, /raw-marker/);
    assert.doesNotMatch(serialized, /"chunks"|"peak_by_sensor"/);
    assert.equal((serialized.match(/"overview"/g) || []).length, 1);
});

test('browser PDF projection delegates exactly to the canonical renderer projection', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'modules', 'system-health-report.js'), 'utf8');
    const context = vm.createContext({
        console,
        window: {},
        document: {
            getElementById() {
                return null;
            }
        },
        state: { apiConfig: {} },
        SystemHealthCollection,
        SystemHealthViewModel
    });
    vm.runInContext(source, context);
    context.report = projectionReport();
    assert.deepEqual(
        plain(vm.runInContext('systemHealthPdfProjection(report)', context)),
        plain(SystemHealthViewModel.buildRendererProjection(context.report))
    );
});
