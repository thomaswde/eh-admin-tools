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
                            values: [10, 1, 0, 2, 0, 0]
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
    context.testAppliancesById = { '7': context.testAppliances[0] };
    context.testProbe = {
        detected_sensors: context.testAppliances,
        probe_status: { '7': { status: 'detected' } },
        errors: []
    };

    const result = await vm.runInContext(
        'collectSystemHealthPacketstoreMetrics(testAppliances, testProbe, [], testAppliancesById, testOptions)',
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

test('probes every eligible sensor separately and keeps clean misses out of the full metric set', async () => {
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
                        stats: [{ oid: '4294967296', time: 1000, duration: 30000, values: [0] }]
                    };
                }
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
        { id: 4, hostname: 'unauthorized', status_message: 'Online', data_access: true }
    ];
    context.testById = Object.fromEntries(context.testSensors.map(sensor => [String(sensor.id), sensor]));
    context.testOptions = { untilMs: 300000, signal: controller.signal };

    const result = await vm.runInContext(
        'probeSystemHealthPacketstoreSensors(testSensors, testById, testOptions)',
        context
    );

    assert.deepEqual(Array.from(result.sensor_ids), ['1']);
    assert.equal(result.probe_status['1'].status, 'detected');
    assert.equal(result.probe_status['2'].status, 'not_detected');
    assert.equal(result.probe_status['3'].status, 'offline');
    assert.equal(result.probe_status['4'].status, 'failed');
    assert.equal(result.errors.length, 1);
    assert.equal(requestBodies.length, 3);
    assert.deepEqual(requestBodies.map(body => body.object_ids), [[1], [2], [4]]);
    assert.ok(requestBodies.every(body => body.metric_specs.length === 1));
    assert.ok(requestBodies.every(body => body.metric_category === 'cpc'
        && body.cycle === '30sec' && body.from === 0 && body.until === 300000));
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
});
