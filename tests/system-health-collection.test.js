const test = require('node:test');
const assert = require('node:assert/strict');

const health = require('../js/modules/system-health-collection.js');

const appliances = {
    '7': { id: 7, hostname: 'sensor-7' },
    '90071992547409931234': { id: '90071992547409931234', hostname: 'large-id' }
};

test('normalizes inline and batched time-series values in metric-spec order', () => {
    const response = {
        cycle: '5min',
        node_id: 7,
        stats: [{ oid: 7, time: 1000, duration: 300000, values: [800, 20, 50, 100] }]
    };
    const normalized = health.normalizeTimeSeriesChunks(
        [response],
        appliances,
        health.TIME_SERIES_METRICS
    );
    assert.deepEqual(normalized.rows[0].values, {
        bytes: 800,
        pkts: 20,
        trigger_cycles: 50,
        trigger_cycles_avail: 100
    });
    assert.equal(normalized.rows[0].actual_cycle, '5min');
});

test('builds one absolute-window request with batched sensors and metric specs', () => {
    const body = health.buildMetricRequest({
        cycle: '1hr',
        fromMs: 1_700_000_000_000,
        untilMs: 1_700_086_400_000,
        objectIds: [7, 8],
        metricNames: health.TIME_SERIES_METRICS
    });
    assert.deepEqual(body.object_ids, [7, 8]);
    assert.deepEqual(body.metric_specs, health.TIME_SERIES_METRICS.map(name => ({ name })));
    assert.equal(body.from, 1_700_000_000_000);
    assert.equal(body.until, 1_700_086_400_000);
    assert.equal(body.metric_category, 'capture');
});

test('builds the exact batched Packetstore cpc metric request', () => {
    const request = health.buildMetricRequest({
        cycle: '1hr', fromMs: 100, untilMs: 200, objectIds: ['7', '8'],
        metricNames: health.PACKETSTORE_TIME_SERIES_METRICS, metricCategory: 'cpc'
    });
    assert.equal(request.metric_category, 'cpc');
    assert.equal(request.object_type, 'system');
    assert.deepEqual(request.metric_specs, [
        { name: 'est_lookback_sec' }, { name: 'input_load' },
        { name: 'compress_load' }, { name: 'disk_write_load' }
    ]);
    assert.deepEqual(health.PACKETSTORE_TOTAL_METRICS, [
        'pkts', 'pkts_dropped', 'pkts_dropped_wrslow', 'secrets', 'secrets_dropped', 'if_drops'
    ]);
});

test('recognizes only the expected cpc invalid-stat response as a negative Packetstore probe', () => {
    const miss = new Error("invalid stat name 'extrahop.system.cpc' (-32602)");
    miss.status = 400;
    miss.details = { error_message: "invalid stat name 'extrahop.system.cpc' (-32602)" };
    assert.equal(health.isPacketstoreProbeMiss(miss), true);

    const unauthorized = new Error('forbidden');
    unauthorized.status = 403;
    assert.equal(health.isPacketstoreProbeMiss(unauthorized), false);
});

test('treats a zero-valued Packetstore probe as a metric hit', () => {
    assert.equal(health.hasMetricValue([{
        appliance_id: '7', values: { est_lookback_sec: 0 }
    }], health.PACKETSTORE_PROBE_METRIC, '7'), true);
    assert.equal(health.hasMetricValue([], health.PACKETSTORE_PROBE_METRIC, '7'), false);
});

test('drains XID chunks through again, data, and null', async () => {
    const responses = [
        { xid: '90071992547409931234' },
        'again',
        { node_id: 7, stats: [{ oid: 7, time: 1, duration: 1000, values: [1] }] },
        null
    ];
    const paths = [];
    const result = await health.collectMetricEndpoint(async path => {
        paths.push(path);
        return responses.shift();
    }, '/metrics', {}, { sleep: async () => {}, now: () => 0 });
    assert.equal(result.complete, true);
    assert.equal(result.chunks.length, 1);
    assert.equal(paths[1], '/metrics/next/90071992547409931234');
});

test('preserves a sensor-specific XID failure while completing other sensor chunks', async () => {
    const sensorError = new Error('API request failed');
    sensorError.status = 500;
    sensorError.details = {
        response: {
            error_message: '"sensor-8" (ID 8 at 10.0.0.8): failed to get sessionid (-32099)'
        }
    };
    const responses = [
        { xid: 77 },
        { node_id: 7, stats: [{ oid: 7, time: 1, duration: 1000, values: [1] }] },
        sensorError,
        null
    ];
    const result = await health.collectMetricEndpoint(async () => {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response;
    }, '/metrics', {}, { sleep: async () => {}, now: () => 0 });

    assert.equal(result.complete, true);
    assert.equal(result.chunks.length, 1);
    assert.equal(result.sensor_failures['8'].status, 'failed');
    assert.match(result.sensor_failures['8'].detail, /failed to get sessionid/);

    const coverage = health.buildSensorCoverage(
        [{ id: 7, status_message: 'Online' }, { id: 8, status_message: 'Online' }],
        [{ appliance_id: '7', value: 1 }],
        { sensorFailures: result.sensor_failures }
    );
    assert.equal(coverage['7'].status, 'complete');
    assert.equal(coverage['8'].status, 'failed');
});

test('surfaces an upstream continuation gzip failure for partial-report diagnostics', async () => {
    const gzipError = new Error('API request failed: 500 - gzip: invalid header');
    gzipError.status = 500;
    gzipError.details = {
        response: { error_message: 'gzip: invalid header' }
    };
    let continuationCalls = 0;

    await assert.rejects(
        health.collectMetricEndpoint(async path => {
            if (path === '/metrics') return { xid: 198865 };
            continuationCalls += 1;
            throw gzipError;
        }, '/metrics', {}, { sleep: async () => {}, now: () => 0 }),
        error => error === gzipError
    );
    assert.equal(continuationCalls, 1);

    const coverage = health.buildSensorCoverage(
        [{ id: 7, status_message: 'Online' }],
        [],
        { error: gzipError }
    );
    assert.equal(coverage['7'].status, 'failed');
    assert.match(coverage['7'].detail, /gzip: invalid header/);
});

test('raises an explicit incomplete-result error after repeated again responses', async () => {
    await assert.rejects(
        health.collectMetricEndpoint(
            async path => path === '/metrics' ? { xid: 9 } : 'again',
            '/metrics',
            {},
            { sleep: async () => {}, now: () => 0, maxPendingRetries: 2 }
        ),
        error => error instanceof health.SystemHealthIncompleteResultError
            && /remained pending/.test(error.message)
    );
});

test('retries a 429 using Retry-After before succeeding', async () => {
    let attempts = 0;
    const delays = [];
    const result = await health.requestWithRetry(async () => {
        attempts += 1;
        if (attempts === 1) {
            const error = new Error('rate limited');
            error.status = 429;
            error.details = { retry_after: '2' };
            throw error;
        }
        return { ok: true };
    }, '/metrics', {}, { sleep: async delay => delays.push(delay) });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(delays, [2000]);
});

test('supports an XID returned by total-by-object and keeps totals out of peaks', async () => {
    const responses = [
        { xid: 44 },
        { node_id: 7, stats: [{ oid: 7, time: 1000, duration: 60000, values: [5] }] },
        null
    ];
    const collected = await health.collectMetricEndpoint(
        async () => responses.shift(),
        '/metrics/totalbyobject',
        {},
        { sleep: async () => {}, now: () => 0 }
    );
    const normalized = health.normalizeAggregateChunks(collected.chunks, appliances, ['trigger_drops']);
    const summary = health.summarizeAggregateRows(normalized.rows);
    assert.equal(summary.totals['7'], 5);
    assert.equal(summary.average_rates['7'], 5 / 60);
    assert.deepEqual(summary.peak_values, {});
    assert.equal(summary.aggregation_mode, 'total_by_object');
});

test('distinguishes valid zeros from empty sensor coverage', () => {
    const sensors = [{ id: 7, status_message: 'online' }, { id: 8, status_message: 'online' }];
    const coverage = health.buildSensorCoverage(sensors, [{
        appliance_id: '7',
        values: { bytes: 0, pkts: 0, trigger_cycles: 0, trigger_cycles_avail: 0 }
    }]);
    assert.equal(coverage['7'].status, 'zero_valued');
    assert.equal(coverage['8'].status, 'empty');
});

test('preserves opaque large node IDs without arithmetic decoding', () => {
    const normalized = health.normalizeTimeSeriesChunks([{
        node_id: '90071992547409931234',
        stats: [{ oid: '18446744073709551615', time: 1, duration: 1000, values: [1, 2, 3, 4] }]
    }], appliances, health.TIME_SERIES_METRICS);
    assert.equal(normalized.rows[0].appliance_id, '90071992547409931234');
    assert.equal(normalized.rows[0].metric_object_id, '18446744073709551615');
});

test('selects latest and peak values deterministically from out-of-order rows', () => {
    const rows = [
        { appliance_id: '7', timestamp_ms: 30, duration_ms: 1000, values: { pkts: 3 } },
        { appliance_id: '7', timestamp_ms: 10, duration_ms: 1000, values: { pkts: 9 } },
        { appliance_id: '7', timestamp_ms: 20, duration_ms: 1000, values: { pkts: 9 } }
    ];
    const summary = health.summarizeTimeSeriesRows(rows, 'pkts');
    assert.equal(summary.latest_values['7'], 3);
    assert.equal(summary.peak_values['7'], 9);
    assert.equal(summary.peak_times['7'], 10);
    assert.equal(summary.min_values['7'], 3);
    assert.equal(summary.min_times['7'], 30);
});

test('cardinality policy counts the exact number of scalar time-series', () => {
    const policy = health.chooseCyclePolicy({
        requestedCycle: '1hr', windowMs: health.DAY_MS, sensorCount: 999,
        scalarSeriesCount: 12, maxScalarPoints: 1000
    });
    assert.equal(policy.estimated_scalar_points, 288);
});

test('calculates maximum trigger utilization from aligned buckets', () => {
    const utilization = health.summarizeTriggerUtilization([
        {
            appliance_id: '7',
            timestamp_ms: 10,
            duration_ms: 1000,
            values: { trigger_cycles: 90, trigger_cycles_avail: 100 }
        },
        {
            appliance_id: '7',
            timestamp_ms: 20,
            duration_ms: 1000,
            values: { trigger_cycles: 100, trigger_cycles_avail: 200 }
        },
        {
            appliance_id: '7',
            timestamp_ms: 30,
            duration_ms: 1000,
            values: { trigger_cycles: 99, trigger_cycles_avail: 0 }
        }
    ]);
    assert.equal(utilization.peak_by_sensor['7'].utilization, 0.9);
    assert.equal(utilization.peak_by_sensor['7'].used_cycles, 90);
    assert.equal(utilization.peak_by_sensor['7'].available_cycles, 100);
    assert.equal(utilization.invalid_by_sensor['7'], 'zero_available_capacity');
});

test('coarsens every fixed UI cycle to the configured bucket budgets', () => {
    for (const cycle of ['1sec', '30sec', '5min', '1hr', '24hr']) {
        const policy = health.chooseCyclePolicy({
            requestedCycle: cycle,
            windowMs: 30 * health.DAY_MS,
            sensorCount: 10
        });
        assert.ok(policy.estimated_buckets_per_sensor <= health.MAX_BUCKETS_PER_SENSOR);
        assert.ok(policy.estimated_scalar_points <= health.MAX_SCALAR_POINTS_PER_REPORT);
    }
});

test('resolves auto within the budget and preserves actual response cycles', () => {
    const policy = health.chooseCyclePolicy({
        requestedCycle: 'auto',
        windowMs: 7 * health.DAY_MS,
        sensorCount: 4
    });
    assert.equal(policy.query_cycle, '5min');
    const normalized = health.normalizeTimeSeriesChunks([{
        cycle: '30sec',
        node_id: 7,
        stats: [{ oid: 7, time: 1, duration: 30000, values: [1, 2, 3, 4] }]
    }], appliances, health.TIME_SERIES_METRICS);
    const summary = health.summarizeTimeSeriesRows(normalized.rows, 'pkts');
    assert.equal(summary.actual_cycles['7'], '30sec');
});

test('rejects a report that exceeds the whole-report budget even at 24 hours', () => {
    assert.throws(() => health.chooseCyclePolicy({
        requestedCycle: '1sec',
        windowMs: 30 * health.DAY_MS,
        sensorCount: 10_000
    }), /maximum time-series point budget/);
});

test('prefers licensed analysis capacities and explicitly derives Standard capacity', () => {
    const capacities = health.deriveAnalysisCapacities(
        { advanced_analysis_capacity: 1200, total_capacity: 5000 },
        { advanced_analysis: 100, standard_analysis: 900 }
    );
    assert.equal(capacities.advanced_analysis, 1200);
    assert.equal(capacities.standard_analysis, 3800);
    assert.equal(capacities.standard_source, 'derived_total_minus_advanced');
});
