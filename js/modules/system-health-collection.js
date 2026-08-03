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
    const PACKETSTORE_TOTAL_METRICS = [
        'pkts', 'pkts_dropped', 'pkts_dropped_wrslow', 'secrets', 'secrets_dropped',
        'if_drops', 'blocks_dropped'
    ];
    const MAX_BUCKETS_PER_SENSOR = 10_000;
    const MAX_SCALAR_POINTS_PER_REPORT = 500_000;
    const MAX_METRIC_BATCH_SIZE = 40;
    const DEFAULT_XID_DEADLINE_MS = 5 * 60 * 1000;
    const DEFAULT_PENDING_RETRIES = 120;
    const DEFAULT_MAX_CONTINUATION_REQUESTS = 1000;
    const DEFAULT_MAX_RECOVERY_QUERIES = 64;

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

    function balancedMetricBatches(objectIds, maxBatchSize = MAX_METRIC_BATCH_SIZE) {
        const ids = Array.from(objectIds || []);
        const cap = Math.floor(Number(maxBatchSize));
        if (!Number.isFinite(cap) || cap < 1 || cap > MAX_METRIC_BATCH_SIZE) {
            throw new RangeError(`Metric batch size must be between 1 and ${MAX_METRIC_BATCH_SIZE}.`);
        }
        if (!ids.length) return [];
        const batchCount = Math.ceil(ids.length / cap);
        const smallerSize = Math.floor(ids.length / batchCount);
        const largerBatchCount = ids.length % batchCount;
        const batches = [];
        let offset = 0;
        for (let index = 0; index < batchCount; index += 1) {
            const size = smallerSize + (index < largerBatchCount ? 1 : 0);
            batches.push(ids.slice(offset, offset + size));
            offset += size;
        }
        return batches;
    }

    function responseXid(response) {
        if (!response || typeof response !== 'object') return null;
        const xid = response.xid;
        if (xid === null || xid === undefined || xid === '') return null;
        if (Array.isArray(xid)) return xid.length === 1 ? xid[0] : null;
        return xid;
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
        if (!error) return null;
        const response = error.details && error.details.response;
        const message = response && typeof response === 'object'
            ? response.error_message || response.error || ''
            : '';
        const match = String(message).match(/\(\s*ID\s+([0-9]+)\s+at\b/i);
        if (!match) return null;
        const httpStatus = Number(error.status) || null;
        return {
            sensor_id: idKey(match[1]),
            status: httpStatus === 401 || httpStatus === 403 ? 'unauthorized'
                : httpStatus === 429 ? 'rate_limited'
                    : 'failed',
            detail: String(message),
            http_status: httpStatus
        };
    }

    async function collectMetricEndpoint(request, endpoint, body, options = {}) {
        const now = options.now || Date.now;
        const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        const deadlineMs = options.deadlineMs ?? DEFAULT_XID_DEADLINE_MS;
        const maxPendingRetries = options.maxPendingRetries ?? DEFAULT_PENDING_RETRIES;
        const maxContinuationRequests = options.maxContinuationRequests ?? DEFAULT_MAX_CONTINUATION_REQUESTS;
        // HTTP retry/backoff belongs to the backend client. The browser owns only
        // continuation polling and one absolute collection deadline, beginning
        // before the initial POST rather than after it returns.
        const deadline = options.absoluteDeadline ?? (now() + deadlineMs);
        const requestOptions = {
            method: 'POST',
            body: JSON.stringify(body),
            signal: options.signal,
            timeoutMs: Math.max(1, deadline - now())
        };
        const chunks = [];
        const sensorFailures = {};
        let initial;
        try {
            initial = await request(endpoint, requestOptions);
        } catch (error) {
            error.metric_result = { chunks, sensor_failures: sensorFailures };
            throw error;
        }
        if (initial && typeof initial === 'object' && Array.isArray(initial.stats)) chunks.push(initial);

        const xid = responseXid(initial);
        if (xid === null) return { chunks, xid: null, complete: true, sensor_failures: sensorFailures };

        let pendingRetries = 0;
        let resultChunks = 0;
        let continuationRequests = 0;
        while (true) {
            if (now() >= deadline) {
                const error = new SystemHealthIncompleteResultError(
                    `Metric query ${String(xid)} did not complete before the ${deadlineMs} ms deadline.`,
                    { xid: idKey(xid), result_chunks: resultChunks, pending_retries: pendingRetries, reason: 'deadline' }
                );
                error.metric_result = { chunks, sensor_failures: sensorFailures };
                throw error;
            }
            if (continuationRequests >= maxContinuationRequests) {
                const error = new SystemHealthIncompleteResultError(
                    `Metric query ${String(xid)} exceeded the ${maxContinuationRequests} continuation-request limit.`,
                    {
                        xid: idKey(xid),
                        result_chunks: resultChunks,
                        continuation_requests: continuationRequests,
                        reason: 'continuation_limit'
                    }
                );
                error.metric_result = { chunks, sensor_failures: sensorFailures };
                throw error;
            }
            let chunk;
            try {
                continuationRequests += 1;
                chunk = await request(
                    `/metrics/next/${encodeURIComponent(idKey(xid))}`,
                    {
                        method: 'GET',
                        signal: options.signal,
                        timeoutMs: Math.max(1, deadline - now())
                    }
                );
            } catch (error) {
                const sensorFailure = metricSensorFailure(error);
                if (!sensorFailure) {
                    error.metric_result = { chunks, sensor_failures: sensorFailures };
                    throw error;
                }
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
                    const error = new SystemHealthIncompleteResultError(
                        `Metric query ${String(xid)} remained pending after ${maxPendingRetries} retries.`,
                        { xid: idKey(xid), result_chunks: resultChunks, pending_retries: pendingRetries, reason: 'pending_limit' }
                    );
                    error.metric_result = { chunks, sensor_failures: sensorFailures };
                    throw error;
                }
                const pendingDelay = Math.min(5000, 500 * (2 ** Math.min(4, pendingRetries - 1)));
                await sleep(Math.min(pendingDelay, Math.max(0, deadline - now())));
                continue;
            }
            if (!chunk || typeof chunk !== 'object' || !Array.isArray(chunk.stats)) {
                const error = new SystemHealthIncompleteResultError(
                    `Metric query ${String(xid)} returned an unexpected continuation response.`,
                    { xid: idKey(xid), response: chunk, reason: 'unexpected_response' }
                );
                error.metric_result = { chunks, sensor_failures: sensorFailures };
                throw error;
            }
            chunks.push(chunk);
            resultChunks += 1;
            pendingRetries = 0;
        }
    }

    function conclusiveSensorIds(chunks, requestedIds) {
        const requested = new Set(Array.from(requestedIds || [], idKey));
        const found = new Set();
        (chunks || []).forEach(chunk => {
            const nodeId = idKey(chunk && chunk.node_id);
            if (requested.has(nodeId)) found.add(nodeId);
            (Array.isArray(chunk && chunk.stats) ? chunk.stats : []).forEach(stat => {
                const objectId = idKey(stat && stat.oid);
                if (requested.has(objectId)) found.add(objectId);
            });
        });
        return found;
    }

    function terminalMetricStatus(error, fallback = 'batch_incomplete') {
        const status = Number(error && error.status);
        if (status === 401 || status === 403) return 'unauthorized';
        if (status === 429) return 'rate_limited';
        if (error instanceof SystemHealthIncompleteResultError) {
            if (error.details && error.details.reason === 'deadline') return 'timed_out';
            if (['continuation_limit', 'pending_limit'].includes(error.details && error.details.reason)) {
                return 'batch_incomplete';
            }
        }
        return fallback;
    }

    async function collectMetricBatches(request, endpoint, body, options = {}) {
        const now = options.now || Date.now;
        const deadlineMs = options.deadlineMs ?? DEFAULT_XID_DEADLINE_MS;
        const absoluteDeadline = now() + deadlineMs;
        const maxRecoveryQueries = options.maxRecoveryQueries ?? DEFAULT_MAX_RECOVERY_QUERIES;
        const requestedIds = Array.from(body && body.object_ids || [], idKey);
        const initialBatches = balancedMetricBatches(
            requestedIds,
            options.maxBatchSize ?? MAX_METRIC_BATCH_SIZE
        );
        const chunks = [];
        const sensorFailures = {};
        const sensorStatuses = {};
        const conclusive = new Set();
        const empty = new Set();
        const recovered = new Set();
        const recoveryQueue = [];
        let queryCount = 0;
        let recoveryQueryCount = 0;
        let deadlineExhausted = false;
        let recoveryLimitExhausted = false;

        const unresolvedIn = ids => ids.filter(id => !conclusive.has(id));
        const recordResult = (ids, result, phase) => {
            const returned = conclusiveSensorIds(result.chunks, ids);
            result.chunks.forEach(chunk => chunks.push(chunk));
            Object.entries(result.sensor_failures || {}).forEach(([id, failure]) => {
                const key = idKey(id);
                if (!ids.includes(key)) return;
                sensorFailures[key] = failure;
                conclusive.add(key);
            });
            returned.forEach(id => {
                conclusive.add(id);
                if (phase === 'recovery') recovered.add(id);
            });
            if (result.complete) {
                ids.forEach(id => {
                    if (conclusive.has(id)) return;
                    conclusive.add(id);
                    empty.add(id);
                    if (phase === 'recovery') recovered.add(id);
                });
            }
        };

        const runBatch = async (ids, phase) => {
            const unresolved = unresolvedIn(ids);
            if (!unresolved.length) return { complete: true, unresolved: [], error: null };
            if (now() >= absoluteDeadline) {
                deadlineExhausted = true;
                return {
                    complete: false,
                    unresolved,
                    error: new SystemHealthIncompleteResultError(
                        'Metric batch recovery reached its absolute deadline.',
                        { reason: 'deadline' }
                    )
                };
            }
            queryCount += 1;
            if (phase === 'recovery') recoveryQueryCount += 1;
            const batchBody = { ...body, object_ids: unresolved };
            try {
                const result = await collectMetricEndpoint(request, endpoint, batchBody, {
                    ...options,
                    absoluteDeadline,
                    deadlineMs
                });
                recordResult(unresolved, result, phase);
                return { complete: true, unresolved: [], error: null };
            } catch (error) {
                if (options.signal && options.signal.aborted) throw error;
                const partial = error.metric_result || { chunks: [], sensor_failures: {} };
                recordResult(unresolved, { ...partial, complete: false }, phase);
                if (now() >= absoluteDeadline) {
                    deadlineExhausted = true;
                }
                return { complete: false, unresolved: unresolvedIn(unresolved), error };
            }
        };

        const recordSingleSensorError = (id, error) => {
            const status = terminalMetricStatus(error, 'failed');
            const terminal = {
                sensor_id: id,
                status,
                detail: error.message || String(error),
                http_status: Number(error.status) || null
            };
            if (status === 'failed') {
                sensorFailures[id] = terminal;
                conclusive.add(id);
            } else {
                sensorStatuses[id] = terminal;
            }
        };
        const recordBatchWideTerminalError = (ids, error) => {
            const status = terminalMetricStatus(error, null);
            if (!['unauthorized', 'rate_limited', 'timed_out'].includes(status)) return false;
            ids.forEach(id => {
                sensorStatuses[id] = {
                    sensor_id: id,
                    status,
                    detail: error.message || String(error),
                    http_status: Number(error.status) || null
                };
            });
            return true;
        };

        for (let index = 0; index < initialBatches.length; index += 1) {
            const batch = initialBatches[index];
            if (deadlineExhausted) {
                initialBatches.slice(index).flat().forEach(id => {
                    if (!conclusive.has(id)) sensorStatuses[id] = { status: 'timed_out', detail: 'metric collection deadline exhausted' };
                });
                break;
            }
            const outcome = await runBatch(batch, 'initial');
            if (!outcome.complete && outcome.unresolved.length) {
                if (recordBatchWideTerminalError(outcome.unresolved, outcome.error)) {
                    continue;
                }
                if (outcome.unresolved.length === 1 && batch.length === 1 && !deadlineExhausted) {
                    const id = outcome.unresolved[0];
                    recordSingleSensorError(id, outcome.error);
                } else if (!deadlineExhausted) {
                    recoveryQueue.push({ ids: outcome.unresolved, error: outcome.error });
                }
            }
        }

        while (recoveryQueue.length && !deadlineExhausted) {
            const pending = recoveryQueue.shift();
            const unresolved = unresolvedIn(pending.ids);
            if (!unresolved.length) continue;
            if (recoveryQueryCount >= maxRecoveryQueries) {
                recoveryLimitExhausted = true;
                recoveryQueue.unshift({ ...pending, ids: unresolved });
                break;
            }
            const smallerBatches = balancedMetricBatches(unresolved, Math.max(1, Math.ceil(unresolved.length / 2)));
            for (let index = 0; index < smallerBatches.length; index += 1) {
                const batch = smallerBatches[index];
                if (recoveryQueryCount >= maxRecoveryQueries) {
                    recoveryLimitExhausted = true;
                    recoveryQueue.push({ ids: smallerBatches.slice(index).flat(), error: pending.error });
                    break;
                }
                const outcome = await runBatch(batch, 'recovery');
                if (outcome.complete || !outcome.unresolved.length) continue;
                if (outcome.unresolved.length === 1 && batch.length === 1 && !deadlineExhausted) {
                    const id = outcome.unresolved[0];
                    recordSingleSensorError(id, outcome.error);
                } else if (!deadlineExhausted) {
                    recoveryQueue.push({ ids: outcome.unresolved, error: outcome.error });
                }
            }
        }

        const queuedErrors = new Map();
        recoveryQueue.forEach(item => item.ids.forEach(id => queuedErrors.set(id, item.error)));
        requestedIds.forEach(id => {
            if (conclusive.has(id) || sensorStatuses[id]) return;
            const error = queuedErrors.get(id);
            const status = deadlineExhausted ? 'timed_out'
                : recoveryLimitExhausted ? terminalMetricStatus(error, 'batch_incomplete')
                    : terminalMetricStatus(error, 'batch_incomplete');
            sensorStatuses[id] = {
                status,
                detail: deadlineExhausted
                    ? 'metric collection deadline exhausted before this sensor became conclusive'
                    : recoveryLimitExhausted
                        ? `metric batch recovery exhausted its ${maxRecoveryQueries}-query follow-up limit`
                        : (error && error.message) || 'metric batch did not produce a conclusive sensor result'
            };
        });

        const failedCount = Object.values(sensorFailures).filter(item => item.status === 'failed').length;
        return {
            chunks,
            complete: Object.keys(sensorStatuses).length === 0,
            sensor_failures: sensorFailures,
            sensor_statuses: sensorStatuses,
            collection_metadata: {
                batch_cap: MAX_METRIC_BATCH_SIZE,
                initial_batch_count: initialBatches.length,
                initial_batch_sizes: initialBatches.map(batch => batch.length),
                query_count: queryCount,
                recovery_query_count: recoveryQueryCount,
                conclusive_sensor_count: conclusive.size,
                recovered_sensor_count: recovered.size,
                empty_sensor_count: empty.size,
                failed_sensor_count: failedCount,
                unresolved_sensor_count: Object.keys(sensorStatuses).length,
                deadline_exhausted: deadlineExhausted,
                recovery_limit_exhausted: recoveryLimitExhausted
            }
        };
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
            const sensorOrder = idKey(a.appliance_id).localeCompare(idKey(b.appliance_id));
            if (sensorOrder) return sensorOrder;
            const timeOrder = (Number(a.timestamp_ms) || 0) - (Number(b.timestamp_ms) || 0);
            if (timeOrder) return timeOrder;
            return idKey(a.metric_object_id).localeCompare(idKey(b.metric_object_id));
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
            const sensorOrder = idKey(a.appliance_id).localeCompare(idKey(b.appliance_id));
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
                coverage[id] = {
                    status: terminalMetricStatus(options.error, 'failed'),
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
            const collectionStatus = options.sensorStatuses && options.sensorStatuses[id];
            if (collectionStatus) {
                coverage[id] = {
                    status: collectionStatus.status || 'batch_incomplete',
                    detail: collectionStatus.detail || 'metric batch did not complete for this sensor'
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
        MAX_METRIC_BATCH_SIZE,
        DEFAULT_MAX_RECOVERY_QUERIES,
        SystemHealthIncompleteResultError,
        idKey,
        nestedNumber,
        cycleToMs,
        estimateBucketCount,
        chooseCyclePolicy,
        buildMetricRequest,
        balancedMetricBatches,
        metricSensorFailure,
        isPacketstoreProbeMiss,
        hasMetricValue,
        collectMetricEndpoint,
        collectMetricBatches,
        normalizeTimeSeriesChunks,
        normalizeAggregateChunks,
        summarizeTimeSeriesRows,
        summarizeAggregateRows,
        summarizeTriggerUtilization,
        buildSensorCoverage,
        deriveAnalysisCapacities
    };
}));
