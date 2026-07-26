(function attachSystemHealthCollection(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SystemHealthCollection = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildSystemHealthCollection() {
    'use strict';

    const DAY_MS = 24 * 60 * 60 * 1000;
    const CYCLE_MS = {
        '1sec': 1000,
        '30sec': 30 * 1000,
        '5min': 5 * 60 * 1000,
        '1hr': 60 * 60 * 1000,
        '24hr': DAY_MS
    };
    const ORDERED_CYCLES = ['1sec', '30sec', '5min', '1hr', '24hr'];
    const TIME_SERIES_METRICS = ['bytes', 'pkts', 'trigger_cycles', 'trigger_cycles_avail'];
    const PACKETSTORE_PROBE_METRIC = 'est_lookback_sec';
    const PACKETSTORE_PROBE_CYCLE = '30sec';
    const PACKETSTORE_PROBE_WINDOW_MS = 5 * 60 * 1000;
    const PACKETSTORE_TIME_SERIES_METRICS = ['est_lookback_sec', 'input_load', 'compress_load', 'disk_write_load'];
    const PACKETSTORE_TOTAL_METRICS = ['pkts', 'pkts_dropped', 'pkts_dropped_wrslow', 'secrets', 'secrets_dropped', 'if_drops'];
    const MAX_BUCKETS_PER_SENSOR = 10_000;
    const MAX_SCALAR_POINTS_PER_REPORT = 500_000;
    const DEFAULT_XID_DEADLINE_MS = 5 * 60 * 1000;
    const DEFAULT_PENDING_RETRIES = 120;
    const DEFAULT_RETRY_ATTEMPTS = 4;

    class SystemHealthIncompleteResultError extends Error {
        constructor(message, details = {}) {
            super(message);
            this.name = 'SystemHealthIncompleteResultError';
            this.details = details;
        }
    }

    function idKey(value) {
        if (value === null || value === undefined) return '';
        return String(value);
    }

    function finiteNumber(value) {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    function nestedNumber(value) {
        const direct = finiteNumber(value);
        if (direct !== null) return direct;
        if (Array.isArray(value)) {
            for (const item of value) {
                const nested = nestedNumber(item);
                if (nested !== null) return nested;
            }
            return null;
        }
        if (value && typeof value === 'object') {
            const measured = finiteNumber(value.value);
            if (measured !== null) return measured;
            const frequency = finiteNumber(value.freq);
            if (frequency !== null) return frequency;
        }
        return null;
    }

    function cycleToMs(cycle) {
        return CYCLE_MS[String(cycle)] || null;
    }

    function estimateBucketCount(windowMs, cycle) {
        const duration = Math.max(0, Number(windowMs) || 0);
        const durationMs = cycleToMs(cycle);
        return durationMs ? Math.ceil(duration / durationMs) : null;
    }

    function chooseCyclePolicy({
        requestedCycle,
        windowMs,
        sensorCount,
        metricCount = TIME_SERIES_METRICS.length,
        scalarSeriesCount = null,
        maxBucketsPerSensor = MAX_BUCKETS_PER_SENSOR,
        maxScalarPoints = MAX_SCALAR_POINTS_PER_REPORT
    }) {
        const requested = String(requestedCycle || '1hr');
        const sensors = Math.max(0, Number(sensorCount) || 0);
        const metrics = Math.max(1, Number(metricCount) || 1);
        const scalarSeries = scalarSeriesCount === null
            ? sensors * metrics
            : Math.max(0, Number(scalarSeriesCount) || 0);

        if (requested === 'auto') {
            const minimumSafeCycle = ORDERED_CYCLES.find(cycle => {
                const buckets = estimateBucketCount(windowMs, cycle);
                return buckets <= maxBucketsPerSensor
                    && buckets * scalarSeries <= maxScalarPoints;
            });
            if (!minimumSafeCycle) {
                throw new RangeError('The requested report exceeds the maximum time-series point budget even at the 24-hour cycle.');
            }
            return {
                requested_cycle: requested,
                query_cycle: minimumSafeCycle,
                minimum_safe_cycle: minimumSafeCycle,
                estimated_buckets_per_sensor: estimateBucketCount(windowMs, minimumSafeCycle),
                estimated_scalar_points: estimateBucketCount(windowMs, minimumSafeCycle) * scalarSeries,
                adjusted: true,
                policy: 'deterministic-auto-resolution'
            };
        }

        const requestedIndex = Math.max(0, ORDERED_CYCLES.indexOf(requested));
        const queryCycle = ORDERED_CYCLES.slice(requestedIndex).find(cycle => {
            const buckets = estimateBucketCount(windowMs, cycle);
            return buckets <= maxBucketsPerSensor
                && buckets * scalarSeries <= maxScalarPoints;
        });
        if (!queryCycle) {
            throw new RangeError('The requested report exceeds the maximum time-series point budget even at the 24-hour cycle.');
        }
        const buckets = estimateBucketCount(windowMs, queryCycle);
        return {
            requested_cycle: requested,
            query_cycle: queryCycle,
            minimum_safe_cycle: queryCycle,
            estimated_buckets_per_sensor: buckets,
            estimated_scalar_points: buckets * scalarSeries,
            adjusted: queryCycle !== requested,
            policy: 'deterministic-coarsening'
        };
    }

    function buildMetricRequest({ cycle, fromMs, untilMs, objectIds, metricNames, metricCategory = 'capture' }) {
        return {
            cycle,
            from: fromMs,
            until: untilMs,
            object_type: 'system',
            object_ids: Array.from(objectIds || []),
            metric_category: metricCategory,
            metric_specs: Array.from(metricNames || []).map(name => ({ name }))
        };
    }

    function responseXid(response) {
        if (!response || typeof response !== 'object') return null;
        const xid = response.xid;
        if (xid === null || xid === undefined || xid === '') return null;
        if (Array.isArray(xid)) return xid.length === 1 ? xid[0] : null;
        return xid;
    }

    function retryAfterMs(error) {
        const raw = error && (
            error.retryAfter
            || error.retry_after
            || (error.details && (error.details.retry_after || error.details.retryAfter))
        );
        if (raw === null || raw === undefined || raw === '') return null;
        const seconds = Number(raw);
        if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
        const dateMs = Date.parse(String(raw));
        return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
    }

    function retryableError(error) {
        const status = Number(error && error.status);
        return status === 429 || status === 502 || status === 503 || status === 504
            || (error && error.name === 'TypeError');
    }

    function errorResponseMessage(error) {
        const details = error && error.details;
        const response = details && details.response !== undefined ? details.response : details;
        if (response && typeof response === 'object') {
            return String(response.error_message || response.message || response.error || error.message || '');
        }
        return String(response || (error && error.message) || '');
    }

    function isPacketstoreProbeMiss(error) {
        return Number(error && error.status) === 400
            && /invalid stat name\s+['"]extrahop\.system\.cpc['"]/i.test(errorResponseMessage(error));
    }

    function hasMetricValue(rows, metricName, sensorId = null) {
        const expectedId = sensorId === null || sensorId === undefined ? null : idKey(sensorId);
        return (rows || []).some(row => {
            if (expectedId !== null && idKey(row && row.appliance_id) !== expectedId) return false;
            return finiteNumber(row && row.values && row.values[metricName]) !== null;
        });
    }

    function metricSensorFailure(error) {
        if (!error || Number(error.status) !== 500) return null;
        const response = error.details && error.details.response;
        const message = response && typeof response === 'object'
            ? response.error_message || response.error || ''
            : '';
        const match = String(message).match(/\(\s*ID\s+([0-9]+)\s+at\b/i);
        if (!match) return null;
        return {
            sensor_id: idKey(match[1]),
            status: 'failed',
            detail: String(message),
            http_status: 500
        };
    }

    async function requestWithRetry(request, endpoint, options, retryOptions = {}) {
        const sleep = retryOptions.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        const random = retryOptions.random || Math.random;
        const maxAttempts = retryOptions.maxAttempts || DEFAULT_RETRY_ATTEMPTS;
        let lastError = null;

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            try {
                return await request(endpoint, options);
            } catch (error) {
                lastError = error;
                if (!retryableError(error) || attempt >= maxAttempts - 1) throw error;
                const serverDelay = retryAfterMs(error);
                const exponentialDelay = Math.min(10_000, 500 * (2 ** attempt));
                const delay = serverDelay === null
                    ? Math.round(exponentialDelay * (0.8 + random() * 0.4))
                    : serverDelay;
                await sleep(delay);
            }
        }
        throw lastError;
    }

    async function collectMetricEndpoint(request, endpoint, body, options = {}) {
        const now = options.now || Date.now;
        const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        const deadlineMs = options.deadlineMs || DEFAULT_XID_DEADLINE_MS;
        const maxPendingRetries = options.maxPendingRetries || DEFAULT_PENDING_RETRIES;
        const requestOptions = {
            method: 'POST',
            body: JSON.stringify(body),
            signal: options.signal
        };
        const initial = await requestWithRetry(request, endpoint, requestOptions, {
            sleep,
            random: options.random,
            maxAttempts: options.maxRetryAttempts
        });
        const chunks = [];
        const sensorFailures = {};
        if (initial && typeof initial === 'object' && Array.isArray(initial.stats)) chunks.push(initial);

        const xid = responseXid(initial);
        if (xid === null) return { chunks, xid: null, complete: true, sensor_failures: sensorFailures };

        const deadline = now() + deadlineMs;
        let pendingRetries = 0;
        let resultChunks = 0;
        while (true) {
            if (now() >= deadline) {
                throw new SystemHealthIncompleteResultError(
                    `Metric query ${String(xid)} did not complete before the ${deadlineMs} ms deadline.`,
                    { xid: idKey(xid), result_chunks: resultChunks, pending_retries: pendingRetries }
                );
            }
            let chunk;
            try {
                chunk = await requestWithRetry(
                    request,
                    `/metrics/next/${encodeURIComponent(idKey(xid))}`,
                    { method: 'GET', signal: options.signal },
                    { sleep, random: options.random, maxAttempts: options.maxRetryAttempts }
                );
            } catch (error) {
                const sensorFailure = metricSensorFailure(error);
                if (!sensorFailure) throw error;
                sensorFailures[sensorFailure.sensor_id] = sensorFailure;
                pendingRetries = 0;
                continue;
            }
            if (chunk === null || chunk === undefined) {
                return {
                    chunks,
                    xid: idKey(xid),
                    complete: true,
                    sensor_failures: sensorFailures
                };
            }
            if (chunk === 'again') {
                pendingRetries += 1;
                if (pendingRetries > maxPendingRetries) {
                    throw new SystemHealthIncompleteResultError(
                        `Metric query ${String(xid)} remained pending after ${maxPendingRetries} retries.`,
                        { xid: idKey(xid), result_chunks: resultChunks, pending_retries: pendingRetries }
                    );
                }
                await sleep(Math.min(5000, 500 * (2 ** Math.min(4, pendingRetries - 1))));
                continue;
            }
            if (!chunk || typeof chunk !== 'object' || !Array.isArray(chunk.stats)) {
                throw new SystemHealthIncompleteResultError(
                    `Metric query ${String(xid)} returned an unexpected continuation response.`,
                    { xid: idKey(xid), response: chunk }
                );
            }
            chunks.push(chunk);
            resultChunks += 1;
            pendingRetries = 0;
        }
    }

    function resolveSensorId(stat, chunk, appliancesById) {
        const nodeId = idKey(chunk && chunk.node_id);
        if (nodeId && appliancesById[nodeId]) return nodeId;
        const objectId = idKey(stat && stat.oid);
        if (objectId && appliancesById[objectId]) return objectId;
        return nodeId || objectId || '';
    }

    function responseMetadata(chunk) {
        return {
            cycle: chunk && chunk.cycle !== undefined ? String(chunk.cycle) : '',
            from_ms: chunk && chunk.from !== undefined ? chunk.from : null,
            until_ms: chunk && chunk.until !== undefined ? chunk.until : null,
            clock_ms: chunk && chunk.clock !== undefined ? chunk.clock : null,
            node_id: chunk && chunk.node_id !== undefined ? idKey(chunk.node_id) : '',
            num_results: chunk && chunk.num_results !== undefined ? chunk.num_results : null
        };
    }

    function normalizeTimeSeriesChunks(chunks, appliancesById, metricNames) {
        const rows = [];
        const metadata = [];
        (chunks || []).forEach(chunk => {
            const chunkMetadata = responseMetadata(chunk);
            metadata.push(chunkMetadata);
            const stats = Array.isArray(chunk && chunk.stats) ? chunk.stats : [];
            stats.forEach(stat => {
                const sensorId = resolveSensorId(stat, chunk, appliancesById);
                const values = {};
                metricNames.forEach((metricName, index) => {
                    values[metricName] = nestedNumber(Array.isArray(stat.values) ? stat.values[index] : null);
                });
                rows.push({
                    appliance_id: sensorId,
                    metric_object_id: idKey(stat.oid),
                    timestamp_ms: stat.time,
                    duration_ms: stat.duration,
                    aggregation_mode: 'time_series',
                    actual_cycle: chunkMetadata.cycle,
                    values
                });
            });
        });
        rows.sort((a, b) => {
            const sensorOrder = idKey(a.appliance_id).localeCompare(idKey(b.appliance_id), undefined, { numeric: true });
            if (sensorOrder) return sensorOrder;
            const timeOrder = (Number(a.timestamp_ms) || 0) - (Number(b.timestamp_ms) || 0);
            if (timeOrder) return timeOrder;
            return idKey(a.metric_object_id).localeCompare(idKey(b.metric_object_id), undefined, { numeric: true });
        });
        return { rows, metadata };
    }

    function normalizeAggregateChunks(chunks, appliancesById, metricNames) {
        const rows = [];
        const metadata = [];
        (chunks || []).forEach(chunk => {
            const chunkMetadata = responseMetadata(chunk);
            metadata.push(chunkMetadata);
            const stats = Array.isArray(chunk && chunk.stats) ? chunk.stats : [];
            stats.forEach(stat => {
                const sensorId = resolveSensorId(stat, chunk, appliancesById);
                metricNames.forEach((metricName, index) => {
                    rows.push({
                        appliance_id: sensorId,
                        metric_object_id: idKey(stat.oid),
                        metric: metricName,
                        timestamp_ms: stat.time,
                        aggregation_duration_ms: stat.duration,
                        aggregation_mode: 'total_by_object',
                        value: nestedNumber(Array.isArray(stat.values) ? stat.values[index] : null)
                    });
                });
            });
        });
        rows.sort((a, b) => {
            const sensorOrder = idKey(a.appliance_id).localeCompare(idKey(b.appliance_id), undefined, { numeric: true });
            if (sensorOrder) return sensorOrder;
            return (Number(a.timestamp_ms) || 0) - (Number(b.timestamp_ms) || 0);
        });
        return { rows, metadata };
    }

    function summarizeTimeSeriesRows(rows, metricName) {
        const totals = {};
        const pointCounts = {};
        const latestValues = {};
        const latestTimes = {};
        const peakValues = {};
        const peakTimes = {};
        const peakDurationMs = {};
        const minValues = {};
        const minTimes = {};
        const minDurationMs = {};
        const actualCycles = {};

        (rows || []).forEach(row => {
            const id = idKey(row.appliance_id);
            const value = row.values ? finiteNumber(row.values[metricName]) : finiteNumber(row.value);
            if (!id || value === null) return;
            totals[id] = (totals[id] || 0) + value;
            pointCounts[id] = (pointCounts[id] || 0) + 1;
            const timestamp = Number(row.timestamp_ms);
            const latestTimestamp = Number(latestTimes[id]);
            if (latestValues[id] === undefined
                || (Number.isFinite(timestamp) && (!Number.isFinite(latestTimestamp) || timestamp > latestTimestamp))
                || (timestamp === latestTimestamp && value > latestValues[id])) {
                latestValues[id] = value;
                latestTimes[id] = row.timestamp_ms;
            }
            if (peakValues[id] === undefined
                || value > peakValues[id]
                || (value === peakValues[id] && Number(row.timestamp_ms) < Number(peakTimes[id]))) {
                peakValues[id] = value;
                peakTimes[id] = row.timestamp_ms;
                peakDurationMs[id] = row.duration_ms;
            }
            if (minValues[id] === undefined
                || value < minValues[id]
                || (value === minValues[id] && Number(row.timestamp_ms) < Number(minTimes[id]))) {
                minValues[id] = value;
                minTimes[id] = row.timestamp_ms;
                minDurationMs[id] = row.duration_ms;
            }
            if (row.actual_cycle) actualCycles[id] = row.actual_cycle;
        });

        const avgValues = {};
        Object.keys(totals).forEach(id => {
            avgValues[id] = pointCounts[id] ? totals[id] / pointCounts[id] : null;
        });
        return {
            aggregation_mode: 'time_series',
            totals,
            point_counts: pointCounts,
            avg_values: avgValues,
            peak_values: peakValues,
            peak_times: peakTimes,
            peak_duration_ms: peakDurationMs,
            min_values: minValues,
            min_times: minTimes,
            min_duration_ms: minDurationMs,
            latest_values: latestValues,
            latest_times: latestTimes,
            actual_cycles: actualCycles
        };
    }

    function summarizeAggregateRows(rows) {
        const totals = {};
        const pointCounts = {};
        const averageRates = {};
        const aggregationDurationMs = {};
        (rows || []).forEach(row => {
            const id = idKey(row.appliance_id);
            const value = finiteNumber(row.value);
            if (!id || value === null) return;
            totals[id] = (totals[id] || 0) + value;
            pointCounts[id] = (pointCounts[id] || 0) + 1;
            const duration = Number(row.aggregation_duration_ms);
            if (Number.isFinite(duration) && duration > 0) {
                aggregationDurationMs[id] = duration;
                averageRates[id] = totals[id] / (duration / 1000);
            }
        });
        return {
            aggregation_mode: 'total_by_object',
            totals,
            point_counts: pointCounts,
            average_rates: averageRates,
            aggregation_duration_ms: aggregationDurationMs,
            peak_values: {},
            peak_times: {},
            peak_duration_ms: {},
            latest_values: {},
            avg_values: {}
        };
    }

    function summarizeTriggerUtilization(rows) {
        const peakBySensor = {};
        const invalidBySensor = {};
        (rows || []).forEach(row => {
            const id = idKey(row.appliance_id);
            const used = row.values ? finiteNumber(row.values.trigger_cycles) : null;
            const available = row.values ? finiteNumber(row.values.trigger_cycles_avail) : null;
            if (!id || used === null || available === null || available <= 0) {
                if (id) invalidBySensor[id] = available === 0 ? 'zero_available_capacity' : 'missing_aligned_value';
                return;
            }
            const utilization = used / available;
            const candidate = {
                utilization,
                used_cycles: used,
                available_cycles: available,
                timestamp_ms: row.timestamp_ms,
                duration_ms: row.duration_ms,
                actual_cycle: row.actual_cycle || ''
            };
            const current = peakBySensor[id];
            if (!current
                || utilization > current.utilization
                || (utilization === current.utilization && Number(candidate.timestamp_ms) < Number(current.timestamp_ms))) {
                peakBySensor[id] = candidate;
            }
        });
        return {
            aggregation_mode: 'aligned_time_series_ratio',
            zero_available_policy: 'invalid_bucket_excluded',
            peak_by_sensor: peakBySensor,
            invalid_by_sensor: invalidBySensor
        };
    }

    function buildSensorCoverage(sensors, rows, options = {}) {
        const rowsBySensor = {};
        (rows || []).forEach(row => {
            const id = idKey(row.appliance_id);
            if (!id) return;
            if (!rowsBySensor[id]) rowsBySensor[id] = [];
            rowsBySensor[id].push(row);
        });
        const coverage = {};
        (sensors || []).forEach(sensor => {
            const id = idKey(sensor.id);
            const status = String(sensor.status_message || '').trim().toLowerCase();
            if (status && status !== 'online') {
                coverage[id] = { status: 'offline', detail: sensor.status_message || 'offline' };
                return;
            }
            if (sensor.data_access === false) {
                coverage[id] = { status: 'data_unavailable', detail: 'data_access is false' };
                return;
            }
            if (options.error) {
                const errorStatus = Number(options.error.status);
                coverage[id] = {
                    status: errorStatus === 401 || errorStatus === 403 ? 'unauthorized'
                        : options.error instanceof SystemHealthIncompleteResultError ? 'timed_out'
                            : errorStatus === 429 ? 'rate_limited'
                                : 'failed',
                    detail: options.error.message || String(options.error)
                };
                return;
            }
            const sensorFailure = options.sensorFailures && options.sensorFailures[id];
            if (sensorFailure) {
                coverage[id] = {
                    status: sensorFailure.status || 'failed',
                    detail: sensorFailure.detail || 'sensor metric query failed'
                };
                return;
            }
            const sensorRows = rowsBySensor[id] || [];
            const values = sensorRows.flatMap(row => {
                if (row.values) return Object.values(row.values).filter(value => finiteNumber(value) !== null);
                const value = finiteNumber(row.value);
                return value === null ? [] : [value];
            });
            coverage[id] = values.length
                ? { status: values.every(value => value === 0) ? 'zero_valued' : 'complete', row_count: sensorRows.length }
                : { status: 'empty', row_count: sensorRows.length };
        });
        return coverage;
    }

    function deriveAnalysisCapacities(appliance, catalogCapacity = {}) {
        const advancedApi = finiteNumber(appliance && appliance.advanced_analysis_capacity);
        const totalApi = finiteNumber(appliance && appliance.total_capacity);
        const canDeriveStandard = advancedApi !== null && totalApi !== null && totalApi >= advancedApi;
        return {
            advanced_analysis: advancedApi !== null ? advancedApi : Number(catalogCapacity.advanced_analysis || 0),
            standard_analysis: canDeriveStandard
                ? totalApi - advancedApi
                : Number(catalogCapacity.standard_analysis || 0),
            total_analysis: totalApi,
            advanced_source: advancedApi !== null ? 'appliance_license' : 'model_catalog',
            standard_source: canDeriveStandard ? 'derived_total_minus_advanced' : 'model_catalog',
            derivation_valid: canDeriveStandard
        };
    }

    return {
        DAY_MS,
        CYCLE_MS,
        TIME_SERIES_METRICS,
        PACKETSTORE_PROBE_METRIC,
        PACKETSTORE_PROBE_CYCLE,
        PACKETSTORE_PROBE_WINDOW_MS,
        PACKETSTORE_TIME_SERIES_METRICS,
        PACKETSTORE_TOTAL_METRICS,
        MAX_BUCKETS_PER_SENSOR,
        MAX_SCALAR_POINTS_PER_REPORT,
        SystemHealthIncompleteResultError,
        idKey,
        nestedNumber,
        cycleToMs,
        estimateBucketCount,
        chooseCyclePolicy,
        buildMetricRequest,
        metricSensorFailure,
        requestWithRetry,
        isPacketstoreProbeMiss,
        hasMetricValue,
        collectMetricEndpoint,
        normalizeTimeSeriesChunks,
        normalizeAggregateChunks,
        summarizeTimeSeriesRows,
        summarizeAggregateRows,
        summarizeTriggerUtilization,
        buildSensorCoverage,
        deriveAnalysisCapacities
    };
}));
