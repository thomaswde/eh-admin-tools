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
        id: String(appliance.id), appliance, role: 'compatibility_detected',
        eligibility_reason: 'positive_lookback_probe', identity_source: 'compatibility_probe',
        online: true, accessible: true
    }));
    context.testAppliancesById = { '7': context.testAppliances[0] };
    context.testProbe = {
        sources: context.testSources,
        probe_status: { '7': { status: 'detected' } },
        errors: []
    };

    const result = await vm.runInContext(
        'collectSystemHealthPacketstoreMetrics(testSources, testProbe, testAppliancesById, testOptions)',
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
        id: '7', appliance: context.testSensor, role: 'compatibility_detected',
        eligibility_reason: 'positive_lookback_probe', identity_source: 'compatibility_probe',
        online: true, accessible: true
    };
    context.testOptions = { cycle: '1hr', fromMs: 0, untilMs: 3_600_000, signal: controller.signal };

    const result = await vm.runInContext(
        `collectSystemHealthPacketstoreMetrics(
            [testSource],
            { sources: [testSource], probe_status: { '7': { status: 'detected' } }, errors: [] },
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
        id: '7', appliance: context.testSensor, role: 'compatibility_detected',
        eligibility_reason: 'positive_lookback_probe', identity_source: 'compatibility_probe',
        online: true, accessible: true
    };
    context.testOptions = { cycle: '1hr', fromMs: 0, untilMs: 3_600_000, signal: controller.signal };

    const result = await vm.runInContext(
        `collectSystemHealthPacketstoreMetrics(
            [testSource],
            { sources: [testSource], probe_status: { '7': { status: 'detected' } }, errors: [] },
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

test('inventory sources bypass compatibility probes while ordinary sensors require positive evidence', async () => {
    const requestBodies = [];
    const window = {
        apiClient: {
            async request(endpoint, options) {
                assert.equal(endpoint, '/metrics');
                const body = JSON.parse(options.body);
                requestBodies.push(body);
                const id = String(body.object_ids[0]);
                if (id === '1') {
                    return {
                        cycle: '30sec', node_id: 1,
                        stats: [{ oid: '4294967296', time: 1000, duration: 30000, values: [120] }]
                    };
                }
                if (id === '5' || id === '6') return {
                    cycle: '30sec', node_id: id,
                    stats: [{ oid: `${id}00`, time: 1000, duration: 30000, values: [0] }]
                };
                if (id === '2') {
                    const error = new Error("invalid stat name 'extrahop.system.cpc' (-32602)");
                    error.status = 400;
                    error.details = { error_message: "invalid stat name 'extrahop.system.cpc' (-32602)" };
                    throw error;
                }
                const error = new Error('forbidden');
                error.status = 403;
                throw error;
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
    context.testSensors = [
        { id: 1, hostname: 'aio', status_message: 'Online', data_access: true },
        { id: 2, hostname: 'sensor', status_message: 'Online', data_access: true },
        { id: 3, hostname: 'offline', status_message: 'Unable to connect', data_access: true },
        { id: 4, hostname: 'unauthorized', status_message: 'Online', data_access: true },
        { id: 5, hostname: 'zero-only', status_message: 'Online', data_access: true },
        {
            id: 6, hostname: 'integrated', status_message: 'Online', data_access: true,
            licensed_features: { eda_onboard_trace: true }
        }
    ];
    context.testPacketstores = [{
        id: '90071992547409931234', hostname: 'packetstore', platform: 'trace',
        status_message: 'Online', data_access: true
    }];
    context.testById = Object.fromEntries(
        [...context.testSensors, ...context.testPacketstores].map(appliance => [String(appliance.id), appliance])
    );
    context.testOptions = { untilMs: 300000, cycle: '5min', signal: controller.signal };

    const result = await vm.runInContext(
        'identifySystemHealthPacketstoreSources(testSensors, testPacketstores, testById, testOptions)',
        context
    );

    assert.deepEqual(Array.from(result.source_ids), ['6', '90071992547409931234', '1']);
    assert.deepEqual(Array.from(result.indeterminate_sensor_ids), ['5']);
    assert.equal(result.probe_status['1'].status, 'detected');
    assert.equal(result.probe_status['1'].evidence, 'positive_lookback');
    assert.equal(result.probe_status['2'].status, 'not_detected');
    assert.equal(result.probe_status['3'].status, 'offline');
    assert.equal(result.probe_status['4'].status, 'failed');
    assert.equal(result.probe_status['5'].status, 'indeterminate');
    assert.equal(result.probe_status['5'].evidence, 'zero_only');
    assert.equal(result.probe_status['6'].status, 'detected');
    assert.equal(result.probe_status['6'].evidence, 'inventory_confirmed');
    assert.equal(result.errors.length, 2);
    assert.equal(result.probe_status['90071992547409931234'].evidence, 'inventory_confirmed');
    assert.equal(requestBodies.length, 4);
    assert.deepEqual(requestBodies.map(body => body.object_ids), [[1], [2], [4], [5]]);
    assert.ok(requestBodies.every(body => body.metric_specs.length === 1));
    assert.ok(requestBodies.every(body => body.metric_category === 'cpc'
        && body.cycle === '5min' && body.from === 0 && body.until === 300000));
});

test('standalone Packetstore metrics use and remain attributed to the Trace appliance ID', async () => {
    const requests = [];
    const window = {
        apiClient: {
            async request(endpoint, options) {
                const body = JSON.parse(options.body);
                requests.push({ endpoint, body });
                if (body.object_ids.length === 1 && String(body.object_ids[0]) === '7') {
                    const error = new Error("invalid stat name 'extrahop.system.cpc' (-32602)");
                    error.status = 400;
                    error.details = { error_message: error.message };
                    throw error;
                }
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
    context.testProbeOptions = { untilMs: 300000, cycle: 'auto', signal: controller.signal };
    context.testCollectOptions = { cycle: '1hr', fromMs: 0, untilMs: 3_600_000, signal: controller.signal };

    context.testSources = await vm.runInContext(
        'identifySystemHealthPacketstoreSources([testSensor], [testPacketstore], testById, testProbeOptions)',
        context
    );
    const result = await vm.runInContext(
        'collectSystemHealthPacketstoreMetrics(testSources.sources, testSources, testById, testCollectOptions)',
        context
    );

    assert.deepEqual(Array.from(result.appliance_ids), ['19']);
    assert.deepEqual(Array.from(result.queried_appliance_ids), ['19']);
    assert.deepEqual(JSON.parse(JSON.stringify(result.sources)), [{
        id: '19', role: 'packetstore', eligibility_reason: 'standalone_packetstore_inventory',
        identity_source: 'inventory', online: true, accessible: true
    }]);
    assert.deepEqual(requests.slice(1).map(item => item.body.object_ids), [['19'], ['19']]);
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
    context.testOptions = { untilMs: 300000, cycle: 'auto', signal: controller.signal };
    context.testCollectOptions = { cycle: '1hr', fromMs: 0, untilMs: 3_600_000, signal: controller.signal };

    context.testSources = await vm.runInContext(
        'identifySystemHealthPacketstoreSources([], [testPacketstore], testById, testOptions)',
        context
    );
    const result = await vm.runInContext(
        'collectSystemHealthPacketstoreMetrics(testSources.sources, testSources, testById, testCollectOptions)',
        context
    );

    assert.deepEqual(Array.from(result.appliance_ids), ['19']);
    assert.deepEqual(Array.from(result.queried_appliance_ids), []);
    assert.equal(result.metrics.est_lookback_sec.sensor_status['19'].status, 'offline');
    assert.equal(result.metrics.est_lookback_sec.rows.length, 0);
});

test('zero-only probes cannot promote unrelated interface drops into Packetstore rows', async () => {
    const requestPaths = [];
    const window = {
        apiClient: {
            async request(endpoint) {
                requestPaths.push(endpoint);
                if (endpoint === '/metrics') return {
                    cycle: '30sec', node_id: '7',
                    stats: [{ oid: '700', time: 1000, duration: 30000, values: [0] }]
                };
                if (endpoint === '/metrics/totalbyobject') return {
                    node_id: '7',
                    stats: [{ oid: '700', time: 1000, duration: 30000, values: [0, 0, 0, 0, 0, 173127753054, 0] }]
                };
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
    context.testById = { '7': context.testSensor };
    context.testProbeOptions = { untilMs: 300000, signal: controller.signal };
    context.testCollectOptions = { cycle: '1hr', fromMs: 0, untilMs: 300000, signal: controller.signal };

    const probe = await vm.runInContext(
        'identifySystemHealthPacketstoreSources([testSensor], [], testById, testProbeOptions)',
        context
    );
    context.testProbe = probe;
    const collected = await vm.runInContext(
        'collectSystemHealthPacketstoreMetrics(testProbe.sources, testProbe, testById, testCollectOptions)',
        context
    );

    assert.deepEqual(Array.from(probe.source_ids), []);
    assert.deepEqual(Array.from(probe.indeterminate_sensor_ids), ['7']);
    assert.equal(probe.probe_status['7'].status, 'indeterminate');
    assert.deepEqual(Array.from(collected.appliance_ids), []);
    assert.deepEqual(requestPaths, ['/metrics']);
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
    assert.equal(vm.runInContext("systemHealthApplianceRole({ platform: 'trace' })", context), 'packetstore');
    assert.equal(vm.runInContext('formatSystemHealthLookbackDays(null)', context), '-');
    assert.equal(vm.runInContext("formatSystemHealthLookbackDays('')", context), '-');
    assert.equal(vm.runInContext('formatSystemHealthLookbackDays(0)', context), '0d');
});
