const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('Packetstore sensor continuation failure produces diagnostics and continues totals', async () => {
    const gzipError = new Error('API request failed: 500 - gzip: invalid header');
    gzipError.status = 500;
    gzipError.details = {
        response: { error_message: 'gzip: invalid header' }
    };
    const requestPaths = [];
    const window = {
        apiClient: {
            async request(endpoint) {
                requestPaths.push(endpoint);
                if (endpoint === '/metrics') return { xid: 198865 };
                if (endpoint === '/metrics/next/198865') throw gzipError;
                if (endpoint === '/metrics/totalbyobject') {
                    return {
                        node_id: '7',
                        stats: [{
                            oid: '7',
                            time: 1000,
                            duration: 60_000,
                            values: [10, 1, 0, 2, 0, 0, 0]
                        }]
                    };
                }
                throw new Error(`Unexpected endpoint ${endpoint}`);
            }
        }
    };
    const context = vm.createContext({
        window,
        console,
        AbortController,
        setTimeout,
        clearTimeout,
        SystemHealthViewModel: require('../js/modules/system-health-view-model.js')
    });
    vm.runInContext(source('js/modules/system-health-collection.js'), context);
    vm.runInContext(source('js/modules/system-health-report.js'), context);
    const controller = new AbortController();
    context.testOptions = {
        cycle: '1hr',
        fromMs: 0,
        untilMs: 60_000,
        signal: controller.signal
    };
    context.testAppliances = [{
        id: '7',
        hostname: 'sensor-7',
        status_message: 'Online',
        data_access: true
    }];
    context.testSources = context.testAppliances.map(appliance => ({
        id: String(appliance.id), appliance, role: 'all_in_one',
        eligibility_reason: 'integrated_packetstore_catalog', identity_source: 'catalog',
        online: true, accessible: true
    }));
    context.testAppliancesById = { '7': context.testAppliances[0] };

    const result = await vm.runInContext(
        'collectSystemHealthPacketstoreMetrics(testSources, testAppliancesById, testOptions)',
        context
    );

    assert.deepEqual(requestPaths, [
        '/metrics',
        '/metrics/next/198865',
        '/metrics/totalbyobject'
    ]);
    assert.match(result.errors.join('\n'), /gzip: invalid header/);
    assert.equal(result.metrics.est_lookback_sec.sensor_status['7'].status, 'failed');
    assert.equal(result.metrics.pkts.sensor_status['7'].status, 'complete');
    assert.equal(result.metrics.pkts.summary.totals['7'], 10);
});

test('Packetstore coverage evaluates each time-series metric independently', async () => {
    const window = {
        apiClient: {
            async request(endpoint) {
                if (endpoint === '/metrics') {
                    return {
                        cycle: '1hr',
                        node_id: '7',
                        stats: [{
                            oid: '700',
                            time: 1000,
                            duration: 3_600_000,
                            values: [null, 0, 0, 0]
                        }]
                    };
                }
                if (endpoint === '/metrics/totalbyobject') {
                    return {
                        node_id: '7',
                        stats: [{ oid: '700', time: 1000, duration: 3_600_000, values: [0, 0, 0, 0, 0, 0, 0] }]
                    };
                }
                throw new Error(`Unexpected endpoint ${endpoint}`);
            }
        }
    };
    const context = vm.createContext({
        window, console, AbortController, setTimeout, clearTimeout,
        SystemHealthViewModel: require('../js/modules/system-health-view-model.js')
    });
    vm.runInContext(source('js/modules/system-health-collection.js'), context);
    vm.runInContext(source('js/modules/system-health-report.js'), context);
    const controller = new AbortController();
    context.testSensor = { id: '7', hostname: 'sensor-7', status_message: 'Online', data_access: true };
    context.testSource = {
        id: '7', appliance: context.testSensor, role: 'all_in_one',
        eligibility_reason: 'integrated_packetstore_catalog', identity_source: 'catalog',
        online: true, accessible: true
    };
    context.testOptions = { cycle: '1hr', fromMs: 0, untilMs: 3_600_000, signal: controller.signal };

    const result = await vm.runInContext(
        `collectSystemHealthPacketstoreMetrics(
            [testSource],
            { '7': testSensor },
            testOptions
        )`,
        context
    );

    assert.equal(result.metrics.est_lookback_sec.sensor_status['7'].status, 'empty');
    assert.equal(result.metrics.input_load.sensor_status['7'].status, 'zero_valued');
    assert.equal(result.metrics.compress_load.sensor_status['7'].status, 'zero_valued');
    assert.equal(result.metrics.disk_write_load.sensor_status['7'].status, 'zero_valued');
    assert.equal(result.metrics.est_lookback_sec.summary.latest_values['7'], undefined);
    assert.equal(result.metrics.input_load.summary.peak_values['7'], 0);
});

test('Packetstore collector marks malformed positional tuples partial', async () => {
    const window = {
        apiClient: {
            async request(endpoint) {
                if (endpoint === '/metrics') {
                    return {
                        cycle: '1hr', node_id: '7',
                        stats: [{ oid: '700', time: 1000, duration: 3_600_000, values: [1, 2, 3] }]
                    };
                }
                if (endpoint === '/metrics/totalbyobject') {
                    return {
                        node_id: '7',
                        stats: [{ oid: '700', time: 1000, duration: 3_600_000, values: [0, 0, 0, 0, 0, 0, 0] }]
                    };
                }
                throw new Error(`Unexpected endpoint ${endpoint}`);
            }
        }
    };
    const context = vm.createContext({
        window, console, AbortController, setTimeout, clearTimeout,
        SystemHealthViewModel: require('../js/modules/system-health-view-model.js')
    });
    vm.runInContext(source('js/modules/system-health-collection.js'), context);
    vm.runInContext(source('js/modules/system-health-report.js'), context);
    const controller = new AbortController();
    context.testSensor = { id: '7', hostname: 'sensor-7', status_message: 'Online', data_access: true };
    context.testSource = {
        id: '7', appliance: context.testSensor, role: 'all_in_one',
        eligibility_reason: 'integrated_packetstore_catalog', identity_source: 'catalog',
        online: true, accessible: true
    };
    context.testOptions = { cycle: '1hr', fromMs: 0, untilMs: 3_600_000, signal: controller.signal };

    const result = await vm.runInContext(
        `collectSystemHealthPacketstoreMetrics(
            [testSource],
            { '7': testSensor },
            testOptions
        )`,
        context
    );

    assert.equal(result.metrics.est_lookback_sec.rows.length, 0);
    assert.equal(result.metrics.est_lookback_sec.sensor_status['7'].status, 'partial');
    assert.match(result.metrics.est_lookback_sec.sensor_status['7'].detail, /expected 4 values but received 3/);
    assert.match(result.errors.join('\n'), /expected 4 values but received 3/);
});

test('Packetstore identity uses catalog, license, platform, and normalized model evidence without API probes', () => {
    const window = {
        apiClient: {
            async request() {
                throw new Error('Packetstore identity must not call the Metrics API');
            }
        }
    };
    const context = vm.createContext({
        window, console, AbortController, setTimeout, clearTimeout,
        SystemHealthViewModel: require('../js/modules/system-health-view-model.js')
    });
    vm.runInContext(source('js/modules/system-health-collection.js'), context);
    vm.runInContext(source('js/modules/system-health-report.js'), context);
    vm.runInContext("systemHealthState.catalog = { EDA6370: { platform: 'all_in_one' } }", context);
    context.testSensors = [
        { id: 1, license_platform: 'EDA6370', status_message: 'Online', data_access: true },
        {
            id: 2, license_platform: 'EDA9999', status_message: 'Online', data_access: true,
            licensed_features: { eda_onboard_trace: true }
        },
        { id: 3, license_platform: 'EDA 8370V_TRACE', status_message: 'Online', data_access: true },
        { id: 4, license_platform: 'EDA10300', status_message: 'Online', data_access: true },
        { id: 5, license_platform: 'EDA8320', status_message: 'Online', data_access: true },
        { id: 6, license_platform: 'EDA63700', status_message: 'Online', data_access: true },
        { id: 7, model: 'eda-1370', status_message: 'Unable to connect', data_access: true }
    ];
    context.testInventory = [
        { id: '19', platform: 'trace', license_platform: 'unknown', status_message: 'Online', data_access: true },
        { id: '20', platform: 'unknown', license_platform: 'ETA11450', status_message: 'Online', data_access: true },
        { id: '21', platform: 'unknown', model: '1150v', status_message: 'Online', data_access: true },
        { id: '22', platform: 'explore', license_platform: 'EXA5300', status_message: 'Online', data_access: true }
    ];
    context.testPacketstores = vm.runInContext(
        'testInventory.filter(isSystemHealthStandalonePacketstore)',
        context
    );

    const result = vm.runInContext(
        'identifySystemHealthPacketstoreSources(testSensors, testPacketstores)',
        context
    );

    assert.deepEqual(Array.from(result.source_ids), ['1', '2', '3', '7', '19', '20', '21']);
    const sources = Object.fromEntries(result.sources.map(item => [item.id, item]));
    assert.equal(sources['1'].identity_source, 'catalog');
    assert.equal(sources['2'].identity_source, 'licensed_feature');
    assert.equal(sources['3'].identity_source, 'model_name');
    assert.equal(sources['3'].matched_model, 'EDA8370V');
    assert.equal(sources['7'].accessible, false);
    assert.equal(sources['19'].identity_source, 'inventory_platform');
    assert.equal(sources['20'].matched_model, 'ETA11450');
    assert.equal(sources['21'].matched_model, '1150V');
    assert.equal(sources['22'], undefined);
});

test('standalone Packetstore metrics use and remain attributed to the Trace appliance ID', async () => {
    const requests = [];
    const window = {
        apiClient: {
            async request(endpoint, options) {
                const body = JSON.parse(options.body);
                requests.push({ endpoint, body });
                assert.deepEqual(body.object_ids, ['19']);
                if (endpoint === '/metrics') {
                    return {
                        cycle: '1hr', node_id: 19,
                        stats: [{ oid: 19, time: 1000, duration: 3_600_000, values: [172800, 10, 20, 30] }]
                    };
                }
                if (endpoint === '/metrics/totalbyobject') {
                    return {
                        node_id: 19,
                        stats: [{ oid: 19, time: 1000, duration: 3_600_000, values: [1000, 0, 0, 50, 0, 0, 0] }]
                    };
                }
                throw new Error(`Unexpected endpoint ${endpoint}`);
            }
        }
    };
    const context = vm.createContext({
        window, console, AbortController, setTimeout, clearTimeout,
        SystemHealthViewModel: require('../js/modules/system-health-view-model.js')
    });
    vm.runInContext(source('js/modules/system-health-collection.js'), context);
    vm.runInContext(source('js/modules/system-health-report.js'), context);
    const controller = new AbortController();
    context.testSensor = {
        id: '7', hostname: 'sensor-7', platform: 'discover', status_message: 'Online', data_access: true
    };
    context.testPacketstore = {
        id: '19', hostname: 'packetstore-19', platform: 'trace', license_platform: 'ETA 9350',
        status_message: 'Online', data_access: true
    };
    context.testById = { '7': context.testSensor, '19': context.testPacketstore };
    context.testCollectOptions = { cycle: '1hr', fromMs: 0, untilMs: 3_600_000, signal: controller.signal };

    context.testSources = vm.runInContext(
        'identifySystemHealthPacketstoreSources([testSensor], [testPacketstore])',
        context
    );
    const result = await vm.runInContext(
        'collectSystemHealthPacketstoreMetrics(testSources.sources, testById, testCollectOptions)',
        context
    );

    assert.deepEqual(Array.from(result.appliance_ids), ['19']);
    assert.deepEqual(Array.from(result.queried_appliance_ids), ['19']);
    assert.deepEqual(JSON.parse(JSON.stringify(result.sources)), [{
        id: '19', role: 'packetstore', eligibility_reason: 'standalone_packetstore_inventory',
        identity_source: 'inventory_platform', online: true, accessible: true
    }]);
    assert.deepEqual(requests.map(item => item.body.object_ids), [['19'], ['19']]);
    assert.equal(result.metrics.est_lookback_sec.summary.latest_values['19'], 172800);
    assert.equal(result.metrics.pkts.summary.totals['19'], 1000);
    assert.equal(result.metrics.est_lookback_sec.rows[0].appliance_name, 'packetstore-19');
    assert.equal(result.metrics.est_lookback_sec.rows[0].platform, 'trace');
});

test('offline standalone Packetstores remain eligible rows without issuing metric requests', async () => {
    const window = {
        apiClient: {
            async request() {
                throw new Error('offline Packetstore must not be queried');
            }
        }
    };
    const context = vm.createContext({
        window, console, AbortController, setTimeout, clearTimeout,
        SystemHealthViewModel: require('../js/modules/system-health-view-model.js')
    });
    vm.runInContext(source('js/modules/system-health-collection.js'), context);
    vm.runInContext(source('js/modules/system-health-report.js'), context);
    const controller = new AbortController();
    context.testPacketstore = {
        id: '19', hostname: 'packetstore-19', platform: 'trace',
        status_message: 'Unable to connect', data_access: true
    };
    context.testById = { '19': context.testPacketstore };
    context.testCollectOptions = { cycle: '1hr', fromMs: 0, untilMs: 3_600_000, signal: controller.signal };

    context.testSources = vm.runInContext(
        'identifySystemHealthPacketstoreSources([], [testPacketstore])',
        context
    );
    const result = await vm.runInContext(
        'collectSystemHealthPacketstoreMetrics(testSources.sources, testById, testCollectOptions)',
        context
    );

    assert.deepEqual(Array.from(result.appliance_ids), ['19']);
    assert.deepEqual(Array.from(result.queried_appliance_ids), []);
    assert.equal(result.metrics.est_lookback_sec.sensor_status['19'].status, 'offline');
    assert.equal(result.metrics.est_lookback_sec.rows.length, 0);
});

test('ordinary Packet Sensors never trigger cpc requests or Packetstore rows', async () => {
    const requestPaths = [];
    const window = {
        apiClient: {
            async request(endpoint) {
                requestPaths.push(endpoint);
                throw new Error(`Unexpected endpoint ${endpoint}`);
            }
        }
    };
    const context = vm.createContext({
        window, console, AbortController, setTimeout, clearTimeout,
        SystemHealthViewModel: require('../js/modules/system-health-view-model.js')
    });
    vm.runInContext(source('js/modules/system-health-collection.js'), context);
    vm.runInContext(source('js/modules/system-health-report.js'), context);
    const controller = new AbortController();
    context.testSensor = {
        id: '7', hostname: 'sensor-7', license_platform: 'EDA9300',
        status_message: 'Online', data_access: true
    };
    context.testById = { '7': context.testSensor };
    context.testCollectOptions = { cycle: '1hr', fromMs: 0, untilMs: 300000, signal: controller.signal };

    const identified = vm.runInContext(
        'identifySystemHealthPacketstoreSources([testSensor], [])',
        context
    );
    context.testIdentified = identified;
    const collected = await vm.runInContext(
        'collectSystemHealthPacketstoreMetrics(testIdentified.sources, testById, testCollectOptions)',
        context
    );

    assert.deepEqual(Array.from(identified.source_ids), []);
    assert.deepEqual(Array.from(collected.appliance_ids), []);
    assert.deepEqual(requestPaths, []);
    assert.equal(collected.metrics.if_drops.rows.length, 0);
});

test('classifies only integrated sensors as all-in-one appliances', () => {
    const window = { apiClient: {} };
    const context = vm.createContext({
        window, console, AbortController, setTimeout, clearTimeout,
        SystemHealthViewModel: require('../js/modules/system-health-view-model.js')
    });
    vm.runInContext(source('js/modules/system-health-collection.js'), context);
    vm.runInContext(source('js/modules/system-health-report.js'), context);

    assert.equal(vm.runInContext(
        "systemHealthApplianceRole({ platform: 'discover', licensed_features: { eda_onboard_trace: true } })",
        context
    ), 'all_in_one');
    assert.equal(vm.runInContext(
        "systemHealthApplianceRole({ platform: 'discover', product_modules: ['network_forensics'] })",
        context
    ), 'packet_sensor');
    assert.equal(vm.runInContext(
        "systemHealthApplianceRole({ platform: 'discover', license_platform: 'EDA 6370V_TRACE' })",
        context
    ), 'all_in_one');
    assert.equal(vm.runInContext(
        "systemHealthApplianceRole({ platform: 'discover', license_platform: 'EDA10300' })",
        context
    ), 'packet_sensor');
    assert.equal(vm.runInContext("systemHealthApplianceRole({ platform: 'trace' })", context), 'packetstore');
    assert.equal(vm.runInContext(
        "systemHealthApplianceRole({ platform: 'unknown', license_platform: 'ETA11450' })",
        context
    ), 'packetstore');
    assert.equal(vm.runInContext('formatSystemHealthLookbackDays(null)', context), '-');
    assert.equal(vm.runInContext("formatSystemHealthLookbackDays('')", context), '-');
    assert.equal(vm.runInContext('formatSystemHealthLookbackDays(0)', context), '0d');
});
