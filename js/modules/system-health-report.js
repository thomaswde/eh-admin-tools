// System Health Report Module

const SYSTEM_HEALTH_ROWS_PER_PAGE = 22;
const SYSTEM_HEALTH_DAY_MS = 24 * 60 * 60 * 1000;
const SYSTEM_HEALTH_DEVICE_LIMIT = 5000;
const systemHealthState = {
    initialized: false,
    catalog: {},
    catalogLoaded: false,
    catalogPath: '',
    catalogError: '',
    charts: {},
    currentReport: null,
    abortController: null,
    pages: {
        packetModel: 0,
        packetRow: 0,
        throughputModel: 0,
        throughputRow: 0,
        triggersModel: 0,
        triggersRow: 0,
        analysisModel: 0,
        analysisRow: 0
    }
};

function initSystemHealthModule() {
    if (systemHealthState.initialized) return;
    systemHealthState.initialized = true;

    const runButton = document.getElementById('runSystemHealthReport');
    if (runButton) runButton.addEventListener('click', generateSystemHealthReport);
    setupSystemHealthStylePanel();
    setupSystemHealthExportButtons();
    setupSystemHealthCsvControls();
    setupSystemHealthPagers();
    window.addEventListener('resize', () => {
        if (systemHealthState.currentReport) renderSystemHealthReport(systemHealthState.currentReport);
    });
    loadSystemHealthCatalog();
}

function activateSystemHealthModule() {
    loadSystemHealthCatalog();
}

async function loadSystemHealthCatalog() {
    try {
        const response = await fetch('/backend/system-health/catalog', {
            headers: { 'Accept': 'application/json' },
            cache: 'no-store'
        });
        const payload = await response.json();
        if (!response.ok) {
            const message = (payload && payload.detail && payload.detail.message) || (payload && payload.message) || `Catalog request failed with HTTP ${response.status}`;
            throw new Error(message);
        }
        systemHealthState.catalogLoaded = !!payload.loaded;
        systemHealthState.catalogPath = payload.path || '';
        systemHealthState.catalog = payload.lookup || buildSystemHealthCatalog(payload.models || []);
        systemHealthState.catalogError = '';
    } catch (error) {
        console.warn('Could not load system health catalog:', error);
        systemHealthState.catalogLoaded = false;
        systemHealthState.catalog = {};
        systemHealthState.catalogError = error.message || 'Catalog could not be loaded.';
    }
    updateSystemHealthCatalogStatus();
}

function buildSystemHealthCatalog(models) {
    const catalog = {};
    models.forEach(model => {
        if (!model || !model.name) return;
        const performance = model.performance || {};
        catalog[String(model.name).toUpperCase()] = {
            model: model.name,
            platform: model.platform || '',
            generation: model.generation,
            sale_status: model.sale_status || '',
            base_gbps: Number(performance.base_gbps || 0),
            base_packetrate: Number(performance.base_packetrate || 0),
            advanced_analysis: Number(performance.advanced_analysis || 0),
            standard_analysis: Number(performance.standard_analysis || 0)
        };
    });
    return catalog;
}

function updateSystemHealthCatalogStatus() {
    const el = document.getElementById('systemHealthCatalogStatus');
    if (!el) return;
    if (systemHealthState.catalogLoaded) {
        el.className = 'system-health-catalog-status hidden';
        el.replaceChildren();
    } else {
        const detail = systemHealthState.catalogError
            ? ` ${systemHealthState.catalogError}`
            : systemHealthState.catalogPath
                ? ` Checked ${systemHealthState.catalogPath}.`
                : '';
        el.className = 'system-health-catalog-status is-missing';
        el.innerHTML = `
            <span class="system-health-catalog-badge">Catalog not loaded</span>
            <span>Capacity comparisons will show observed values only.${escapeSystemHealthHtml(detail)}</span>
        `;
    }
}

async function generateSystemHealthReport() {
    if (!window.SystemHealthCollection) {
        throw new Error('System Health collection module did not load.');
    }
    if (systemHealthState.abortController) systemHealthState.abortController.abort();
    const abortController = new AbortController();
    systemHealthState.abortController = abortController;
    const loading = document.getElementById('systemHealthLoading');
    const results = document.getElementById('systemHealthResults');
    const loadingText = document.getElementById('systemHealthLoadingText');
    const button = document.getElementById('runSystemHealthReport');

    loading.style.display = 'block';
    results.style.display = 'none';
    button.disabled = true;

    try {
        const lookbackDays = Number(document.getElementById('systemHealthLookback').value || 7);
        const requestedCycle = document.getElementById('systemHealthCycle').value || '1hr';
        const untilMs = Date.now();
        const fromMs = untilMs - (lookbackDays * SYSTEM_HEALTH_DAY_MS);

        loadingText.textContent = 'Loading product catalog...';
        await loadSystemHealthCatalog();

        loadingText.textContent = 'Loading appliance inventory...';
        const appliances = normalizeSystemHealthAppliances(await window.apiClient.getAppliances({ signal: abortController.signal }));
        const discoverSensors = appliances.filter(item => String(item.platform || '').toLowerCase() === 'discover');
        const metricSensors = discoverSensors.filter(isSystemHealthMetricSensor);
        const appliancesById = Object.fromEntries(discoverSensors.map(item => [String(item.id), item]));
        const cyclePolicy = SystemHealthCollection.chooseCyclePolicy({
            requestedCycle,
            windowMs: untilMs - fromMs,
            sensorCount: metricSensors.length
        });

        loadingText.textContent = 'Collecting device tiers and batched system metrics...';
        const [deviceResult, timeSeriesResult, triggerDropResult] = await Promise.all([
            collectSystemHealthDeviceAnalysis(fromMs, untilMs, abortController.signal).catch(error => {
                if (abortController.signal.aborted) throw error;
                return {
                    by_sensor: {},
                    warnings: [`Device analysis collection failed without substituting zero values: ${error.message}`],
                    error
                };
            }),
            collectSystemHealthTimeSeries(metricSensors, discoverSensors, appliancesById, {
                fromMs,
                untilMs,
                cycle: cyclePolicy.query_cycle,
                signal: abortController.signal
            }),
            collectSystemHealthTriggerDrops(metricSensors, discoverSensors, appliancesById, {
                fromMs,
                untilMs,
                cycle: cyclePolicy.query_cycle,
                signal: abortController.signal
            })
        ]);
        const metricResults = {
            ...timeSeriesResult.metrics,
            trigger_drops: triggerDropResult
        };

        const report = buildSystemHealthReport({
            appliances: discoverSensors,
            deviceAnalysis: deviceResult.by_sensor,
            metricResults,
            lookbackDays,
            cycle: cyclePolicy.query_cycle,
            requestedCycle,
            cyclePolicy,
            fromMs,
            untilMs,
            triggerUtilization: timeSeriesResult.trigger_utilization,
            deviceAnalysisError: deviceResult.error,
            collectionErrors: [
                ...deviceResult.warnings,
                ...timeSeriesResult.errors,
                ...(triggerDropResult.errors || []),
                ...(cyclePolicy.adjusted
                    ? [`Metric cycle was automatically changed from ${requestedCycle} to ${cyclePolicy.query_cycle} to stay within the ${SystemHealthCollection.MAX_BUCKETS_PER_SENSOR.toLocaleString()}-bucket per-sensor and ${SystemHealthCollection.MAX_SCALAR_POINTS_PER_REPORT.toLocaleString()}-point report budgets.`]
                    : [])
            ]
        });

        systemHealthState.currentReport = report;
        resetSystemHealthPages();
        results.style.display = 'block';
        renderSystemHealthReport(report);
        updateSystemHealthCsvButtons();
    } catch (error) {
        if (abortController.signal.aborted) return;
        showErrorModal(error.message || 'System Health report failed', {
            url: '/backend/extrahop',
            headers: { 'Content-Type': 'application/json' },
            body: 'System Health report collection',
            status: error.status ? String(error.status) : 'Collection Error',
            response: error.details || error.message || 'No additional details'
        });
    } finally {
        if (systemHealthState.abortController === abortController) {
            systemHealthState.abortController = null;
            loading.style.display = 'none';
            button.disabled = false;
        }
    }
}

function normalizeSystemHealthAppliances(response) {
    if (Array.isArray(response)) return response.filter(item => item && typeof item === 'object');
    if (response && response.appliances && Array.isArray(response.appliances)) return response.appliances;
    if (response && response.results && Array.isArray(response.results)) return response.results;
    return [];
}

function isSystemHealthMetricSensor(appliance) {
    const status = String(appliance.status_message || '').toLowerCase();
    return status === 'online' && appliance.data_access !== false;
}

async function collectSystemHealthTimeSeries(metricSensors, allSensors, appliancesById, options) {
    const metricNames = SystemHealthCollection.TIME_SERIES_METRICS;
    const emptyMetrics = Object.fromEntries(metricNames.map(metricName => [metricName, {
        metric_category_used: 'capture',
        aggregation_mode: 'time_series',
        rows: [],
        summary: SystemHealthCollection.summarizeTimeSeriesRows([], metricName),
        sensor_status: SystemHealthCollection.buildSensorCoverage(allSensors, [])
    }]));
    if (!metricSensors.length) {
        return { metrics: emptyMetrics, trigger_utilization: SystemHealthCollection.summarizeTriggerUtilization([]), errors: [] };
    }

    const body = SystemHealthCollection.buildMetricRequest({
        cycle: options.cycle,
        fromMs: options.fromMs,
        untilMs: options.untilMs,
        objectIds: metricSensors.map(sensor => sensor.id),
        metricNames
    });
    try {
        const result = await SystemHealthCollection.collectMetricEndpoint(
            window.apiClient.request.bind(window.apiClient),
            '/metrics',
            body,
            { signal: options.signal }
        );
        const normalized = SystemHealthCollection.normalizeTimeSeriesChunks(result.chunks, appliancesById, metricNames);
        const errors = [];
        const metrics = {};
        metricNames.forEach(metricName => {
            const rows = normalized.rows.map(row => {
                const appliance = appliancesById[String(row.appliance_id)] || {};
                return {
                    ...row,
                    appliance_name: systemHealthApplianceName(appliance, row.appliance_id),
                    hostname: appliance.hostname || '',
                    platform: appliance.platform || '',
                    license_platform: appliance.license_platform || '',
                    metric: metricName,
                    value: row.values[metricName],
                    time_iso: systemHealthMsToIso(row.timestamp_ms)
                };
            });
            const coverage = SystemHealthCollection.buildSensorCoverage(
                allSensors,
                rows.map(row => ({ appliance_id: row.appliance_id, value: row.value }))
            );
            errors.push(...systemHealthCoverageErrors(coverage, metricName));
            metrics[metricName] = {
                metric_category_used: 'capture',
                aggregation_mode: 'time_series',
                rows,
                collection_metadata: normalized.metadata,
                summary: SystemHealthCollection.summarizeTimeSeriesRows(normalized.rows, metricName),
                sensor_status: coverage,
                errors: []
            };
        });
        return {
            metrics,
            trigger_utilization: SystemHealthCollection.summarizeTriggerUtilization(normalized.rows),
            errors
        };
    } catch (error) {
        if (options.signal.aborted) throw error;
        const coverage = SystemHealthCollection.buildSensorCoverage(allSensors, [], { error });
        Object.values(emptyMetrics).forEach(metric => {
            metric.sensor_status = coverage;
            metric.errors = [error.message];
        });
        return {
            metrics: emptyMetrics,
            trigger_utilization: SystemHealthCollection.summarizeTriggerUtilization([]),
            errors: [`Time-series metric collection failed without substituting zero values: ${error.message}`]
        };
    }
}

async function collectSystemHealthTriggerDrops(metricSensors, allSensors, appliancesById, options) {
    const emptySummary = SystemHealthCollection.summarizeAggregateRows([]);
    if (!metricSensors.length) {
        return {
            metric_category_used: 'capture',
            aggregation_mode: 'total_by_object',
            rows: [],
            summary: emptySummary,
            sensor_status: SystemHealthCollection.buildSensorCoverage(allSensors, []),
            errors: []
        };
    }
    const body = SystemHealthCollection.buildMetricRequest({
        cycle: options.cycle,
        fromMs: options.fromMs,
        untilMs: options.untilMs,
        objectIds: metricSensors.map(sensor => sensor.id),
        metricNames: ['trigger_drops']
    });
    try {
        const result = await SystemHealthCollection.collectMetricEndpoint(
            window.apiClient.request.bind(window.apiClient),
            '/metrics/totalbyobject',
            body,
            { signal: options.signal }
        );
        const normalized = SystemHealthCollection.normalizeAggregateChunks(result.chunks, appliancesById, ['trigger_drops']);
        normalized.rows.forEach(row => {
            const appliance = appliancesById[String(row.appliance_id)] || {};
            row.appliance_name = systemHealthApplianceName(appliance, row.appliance_id);
            row.hostname = appliance.hostname || '';
            row.platform = appliance.platform || '';
            row.license_platform = appliance.license_platform || '';
            row.time_iso = systemHealthMsToIso(row.timestamp_ms);
        });
        const coverage = SystemHealthCollection.buildSensorCoverage(allSensors, normalized.rows);
        return {
            metric_category_used: 'capture',
            aggregation_mode: 'total_by_object',
            rows: normalized.rows,
            collection_metadata: normalized.metadata,
            summary: SystemHealthCollection.summarizeAggregateRows(normalized.rows),
            sensor_status: coverage,
            errors: systemHealthCoverageErrors(coverage, 'trigger-drop totals')
        };
    } catch (error) {
        if (options.signal.aborted) throw error;
        const coverage = SystemHealthCollection.buildSensorCoverage(allSensors, [], { error });
        return {
            metric_category_used: 'capture',
            aggregation_mode: 'total_by_object',
            rows: [],
            summary: emptySummary,
            sensor_status: coverage,
            errors: [`Trigger-drop total collection failed without substituting zero values: ${error.message}`]
        };
    }
}

function systemHealthCoverageErrors(coverage, label) {
    return Object.entries(coverage || {})
        .filter(([, value]) => !['complete', 'zero_valued'].includes(value.status))
        .map(([id, value]) => `${label} (${id}): ${value.status}${value.detail ? ` - ${value.detail}` : ''}`);
}

function systemHealthMsToIso(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return new Date(number).toISOString().replace('.000Z', '+00:00');
}

function summarizeSystemHealthRows(rows) {
    return SystemHealthCollection.summarizeTimeSeriesRows(rows, rows[0] ? rows[0].metric : '');
}

async function collectSystemHealthDeviceAnalysis(fromMs, untilMs, signal) {
    const aggregate = {};
    const warnings = [];
    const seenDeviceIds = new Set();
    let offset = 0;
    let pages = 0;

    while (true) {
        if (pages >= 1000) throw new Error('Device analysis pagination exceeded 1,000 pages.');
        const payload = {
            active_from: fromMs,
            active_until: untilMs,
            limit: SYSTEM_HEALTH_DEVICE_LIMIT,
            offset,
            result_fields: ['node_id', 'analysis'],
            filter: {
                operator: 'and',
                rules: [{ field: 'analysis', operand: 'l2_exempt', operator: '!=' }]
            }
        };

        const response = await window.apiClient.request('/devices/search', {
            method: 'POST',
            body: JSON.stringify(payload),
            signal
        });
        const devices = Array.isArray(response) ? response : ((response && response.devices) || []);
        if (!devices.length) break;

        devices.forEach(device => {
            const deviceId = String(device.id === undefined ? `${offset}:${seenDeviceIds.size}` : device.id);
            if (seenDeviceIds.has(deviceId)) {
                warnings.push(`Device search returned duplicate device ID ${deviceId}; it was counted once.`);
                return;
            }
            seenDeviceIds.add(deviceId);
            if (device.node_id === undefined || device.node_id === null) {
                warnings.push(`Device ${deviceId} did not include node_id and was not attributed to a sensor.`);
                return;
            }
            const id = String(device.node_id);
            if (!aggregate[id]) aggregate[id] = { advanced: 0, standard: 0, discovery: 0, unrecognized: 0, total: 0, status: 'complete' };
            if (['advanced', 'standard', 'discovery'].includes(device.analysis)) {
                aggregate[id][device.analysis] += 1;
            } else {
                aggregate[id].unrecognized += 1;
            }
            aggregate[id].total += 1;
        });

        if (devices.length < SYSTEM_HEALTH_DEVICE_LIMIT) break;
        offset += SYSTEM_HEALTH_DEVICE_LIMIT;
        pages += 1;
    }

    Object.entries(aggregate).forEach(([id, counts]) => {
        if (counts.unrecognized) warnings.push(`Device analysis (${id}): ${counts.unrecognized} devices had unrecognized analysis values.`);
    });
    return { by_sensor: aggregate, warnings: Array.from(new Set(warnings)) };
}

function buildSystemHealthReport({
    appliances,
    deviceAnalysis,
    metricResults,
    lookbackDays,
    cycle,
    requestedCycle = cycle,
    cyclePolicy = null,
    fromMs = null,
    untilMs = null,
    triggerUtilization = null,
    deviceAnalysisError = null,
    collectionErrors = []
}) {
    const compactAppliances = appliances.map(item => {
        const capacity = capacityForSystemHealthAppliance(item);
        const conditions = systemHealthApplianceHealthConditions(item, untilMs);
        return {
            id: String(item.id),
            name: systemHealthApplianceName(item, item.id),
            hostname: item.hostname || '',
            platform: item.platform || '',
            license_platform: item.license_platform || '',
            status_message: item.status_message || '',
            online: String(item.status_message || '').toLowerCase() === 'online',
            metric_eligible: isSystemHealthMetricSensor(item),
            data_access: item.data_access,
            license_status: item.license_status || '',
            sync_time: item.sync_time,
            advanced_analysis_capacity: item.advanced_analysis_capacity,
            total_capacity: item.total_capacity,
            health_conditions: conditions,
            capacity,
            uuid: item.uuid || '',
            firmware_version: item.firmware_version || ''
        };
    });

    const normalizedDeviceAnalysis = {};
    compactAppliances.forEach(appliance => {
        const returned = deviceAnalysis && deviceAnalysis[String(appliance.id)];
        normalizedDeviceAnalysis[String(appliance.id)] = returned
            ? { ...returned, status: returned.status || 'complete' }
            : {
                advanced: null,
                standard: null,
                discovery: null,
                unrecognized: null,
                total: null,
                status: deviceAnalysisError ? 'failed' : 'empty',
                detail: deviceAnalysisError ? deviceAnalysisError.message : 'no device rows returned'
            };
    });

    return {
        generated_at: new Date().toISOString(),
        target: state.apiConfig || {},
        window: {
            lookback_days: lookbackDays,
            from_ms: fromMs,
            until_ms: untilMs,
            from_iso: systemHealthMsToIso(fromMs),
            until_iso: systemHealthMsToIso(untilMs)
        },
        requested_cycle: requestedCycle,
        cycle,
        cycle_policy: cyclePolicy,
        capacity_catalog_loaded: systemHealthState.catalogLoaded,
        appliances: compactAppliances,
        device_analysis: normalizedDeviceAnalysis,
        metrics: metricResults,
        trigger_utilization: triggerUtilization || SystemHealthCollection.summarizeTriggerUtilization([]),
        errors: Array.from(new Set([
            ...collectionErrors,
            ...Object.values(metricResults).flatMap(result => result.errors || []),
            ...compactAppliances.flatMap(appliance => appliance.health_conditions.map(condition => `${appliance.name}: ${condition.message}`))
        ]))
    };
}

function capacityForSystemHealthAppliance(appliance) {
    const candidates = [
        appliance.license_platform,
        normalizeSystemHealthModelName(appliance.license_platform),
        appliance.model,
        normalizeSystemHealthModelName(appliance.model),
        appliance.product,
        normalizeSystemHealthModelName(appliance.product),
        appliance.platform_model,
        normalizeSystemHealthModelName(appliance.platform_model)
    ];
    let catalogCapacity = null;
    for (const candidate of candidates) {
        const match = systemHealthState.catalog[String(candidate || '').toUpperCase()];
        if (match) {
            catalogCapacity = match;
            break;
        }
    }
    const analysis = SystemHealthCollection.deriveAnalysisCapacities(appliance, catalogCapacity || {});
    return {
        ...(catalogCapacity || {}),
        ...analysis,
        capacity_source: {
            packet_rate: catalogCapacity ? 'model_catalog' : 'unavailable',
            throughput: catalogCapacity ? 'model_catalog' : 'unavailable',
            advanced_analysis: analysis.advanced_source,
            standard_analysis: analysis.standard_source
        },
        api_advanced_analysis_capacity: appliance.advanced_analysis_capacity,
        api_total_capacity: appliance.total_capacity
    };
}

function systemHealthApplianceHealthConditions(appliance, reportUntilMs) {
    const conditions = [];
    const status = String(appliance.status_message || '').trim();
    if (status && status.toLowerCase() !== 'online') {
        conditions.push({ type: 'offline', status: 'failed', message: `appliance status is ${status}` });
    }
    if (appliance.data_access === false) {
        conditions.push({ type: 'data_access', status: 'failed', message: 'data access is unavailable' });
    }
    if (appliance.license_status && String(appliance.license_status).toLowerCase() !== 'nominal') {
        conditions.push({ type: 'license', status: 'warning', message: `license status is ${appliance.license_status}` });
    }
    const syncMs = Number(appliance.sync_time) * 1000;
    if (Number.isFinite(syncMs) && syncMs > 0 && Number(reportUntilMs) - syncMs > 15 * 60 * 1000) {
        conditions.push({ type: 'synchronization', status: 'warning', message: `last synchronization was ${systemHealthMsToIso(syncMs)}` });
    }
    return conditions;
}

function normalizeSystemHealthModelName(value) {
    return String(value || '').replace(/_TRACE$/i, '');
}

function systemHealthRows(report) {
    return (report.appliances || []).map(sensor => {
        const capacity = sensor.capacity || {};
        const offline = !sensor.online;
        const analysis = (report.device_analysis && report.device_analysis[String(sensor.id)])
            || { advanced: null, standard: null, discovery: null, total: null, status: 'empty' };
        const packetPeak = metricSystemHealthPeakRate(report, 'pkts', sensor.id);
        const throughputGbps = systemHealthBytesToGbps(report, sensor.id);
        const alignedTrigger = report.trigger_utilization
            && report.trigger_utilization.peak_by_sensor
            && report.trigger_utilization.peak_by_sensor[String(sensor.id)];
        const triggerCyclesPeak = alignedTrigger ? alignedTrigger.used_cycles : null;
        const triggerCyclesAvail = alignedTrigger ? alignedTrigger.available_cycles : null;
        const triggerDropsTotal = metricSystemHealthTotal(report, 'trigger_drops', sensor.id);
        const collectionStatus = systemHealthMetricStatus(report, sensor.id);
        collectionStatus.trigger_utilization = alignedTrigger
            ? 'complete'
            : (report.trigger_utilization
                && report.trigger_utilization.invalid_by_sensor
                && report.trigger_utilization.invalid_by_sensor[String(sensor.id)])
                || collectionStatus.trigger_cycles
                || 'empty';
        return {
            ...sensor,
            offline,
            collectionStatus: { ...collectionStatus, device_analysis: analysis.status || 'unknown' },
            analysis,
            packetPeak,
            packetCapacity: Number(capacity.base_packetrate || 0),
            throughputGbps,
            throughputCapacity: Number(capacity.base_gbps || 0),
            triggerCyclesPeak,
            triggerCyclesAvail,
            triggerUtilization: alignedTrigger ? alignedTrigger.utilization : null,
            triggerPeakTimestampMs: alignedTrigger ? alignedTrigger.timestamp_ms : null,
            triggerPeakDurationMs: alignedTrigger ? alignedTrigger.duration_ms : null,
            triggerDropsPeak: null,
            triggerDropsTotal,
            advancedCapacity: Number(capacity.advanced_analysis || 0),
            standardCapacity: Number(capacity.standard_analysis || 0)
        };
    });
}

function metricSystemHealthPeak(report, metricName, id) {
    const metric = report.metrics ? report.metrics[metricName] : null;
    const value = metric && metric.summary && metric.summary.peak_values && metric.summary.peak_values[String(id)];
    return value === undefined ? null : value;
}

function metricSystemHealthTotal(report, metricName, id) {
    const metric = report.metrics ? report.metrics[metricName] : null;
    const value = metric && metric.summary && metric.summary.totals && metric.summary.totals[String(id)];
    return value === undefined ? null : value;
}

function metricSystemHealthDuration(report, metricName, id) {
    const metric = report.metrics ? report.metrics[metricName] : null;
    const duration = metric && metric.summary && metric.summary.peak_duration_ms && metric.summary.peak_duration_ms[String(id)];
    return duration === undefined || duration === null ? null : duration;
}

function metricSystemHealthPeakRate(report, metricName, id) {
    const duration = metricSystemHealthDuration(report, metricName, id);
    const peak = metricSystemHealthPeak(report, metricName, id);
    return duration && peak !== null ? Number(peak) / (duration / 1000) : null;
}

function systemHealthBytesToGbps(report, id) {
    const duration = metricSystemHealthDuration(report, 'bytes', id);
    const peak = metricSystemHealthPeak(report, 'bytes', id);
    return duration && peak !== null ? (Number(peak) * 8) / (duration / 1000) / 1_000_000_000 : null;
}

function systemHealthCycleToMs(cycle) {
    return SystemHealthCollection.cycleToMs(cycle) || 3600000;
}

function systemHealthMetricStatus(report, id) {
    const statusByMetric = {};
    Object.entries(report.metrics || {}).forEach(([metricName, metric]) => {
        statusByMetric[metricName] = metric.sensor_status
            && metric.sensor_status[String(id)]
            && metric.sensor_status[String(id)].status || 'unknown';
    });
    return statusByMetric;
}

function systemHealthReportCycleLabel(report) {
    const actualCycles = new Set();
    Object.values(report.metrics || {}).forEach(metric => {
        Object.values((metric.summary && metric.summary.actual_cycles) || {}).forEach(cycle => {
            if (cycle) actualCycles.add(String(cycle));
        });
        (metric.collection_metadata || []).forEach(metadata => {
            if (metadata && metadata.cycle) actualCycles.add(String(metadata.cycle));
        });
    });
    if (actualCycles.size === 1) return Array.from(actualCycles)[0];
    if (actualCycles.size > 1) return Array.from(actualCycles).sort().join('/');
    return report.cycle || report.requested_cycle || 'unknown-cycle';
}

function systemHealthRowStatusText(row) {
    const conditions = (row.health_conditions || []).map(condition => condition.type.replace(/_/g, ' '));
    const metricStates = Object.values(row.collectionStatus || {});
    const collectionState = metricStates.find(status => !['complete', 'zero_valued'].includes(status));
    if (collectionState) conditions.push(`metrics ${collectionState.replace(/_/g, ' ')}`);
    return Array.from(new Set(conditions)).join(' · ');
}

function renderSystemHealthReport(report) {
    const rows = systemHealthRows(report);
    renderSystemHealthSummary(report, rows);
    renderSystemHealthCharts(rows);
    renderSystemHealthTable(rows);
    renderSystemHealthErrors(report.errors || []);
    updateSystemHealthCsvButtons();
}

function renderSystemHealthSummary(report, rows) {
    const offlineSensors = rows.filter(row => row.offline).length;
    const dataUnavailableSensors = rows.filter(row => row.data_access === false).length;
    const packetRisk = rows.filter(row => row.packetCapacity && row.packetPeak >= row.packetCapacity).length;
    const throughputWatch = rows.filter(row => row.throughputCapacity && row.throughputGbps / row.throughputCapacity >= 0.8).length;
    const triggerWatch = rows.filter(row => row.triggerUtilization !== null && row.triggerUtilization >= 0.8).length;
    const triggerDropSensors = rows.filter(row => row.triggerDropsTotal > 0).length;
    const discoverySensors = rows.filter(row => (row.analysis.discovery || 0) > 0).length;
    const cards = [
        ['Sensors', formatSystemHealthNumber(rows.length), 'Discover sensors returned'],
        ['Offline', formatSystemHealthNumber(offlineSensors), dataUnavailableSensors ? `${dataUnavailableSensors} also lack data access` : 'Appliance status is not online'],
        ['Lookback', `${report.window.lookback_days} days`, `Peak ${systemHealthReportCycleLabel(report)} averages`],
        ['Packet Risk', formatSystemHealthNumber(packetRisk), `At model rating on peak ${systemHealthReportCycleLabel(report)} average`],
        ['Throughput Watch', formatSystemHealthNumber(throughputWatch), `At 80%+ on peak ${systemHealthReportCycleLabel(report)} average`],
        ['Trigger Watch', formatSystemHealthNumber(triggerWatch), 'At 80%+ trigger cycle capacity'],
        ['Trigger Drops', formatSystemHealthNumber(triggerDropSensors), 'Sensors with dropped trigger executions'],
        ['Discovery Overflow', formatSystemHealthNumber(discoverySensors), 'Sensors with Discovery devices']
    ];

    document.getElementById('systemHealthSummary').innerHTML = cards.map(([label, value, note]) => `
        <div class="stat">
            <div class="stat-label">${escapeHtml(label)}</div>
            <div class="stat-value">${escapeHtml(value)}</div>
            <div class="stat-sub">${escapeHtml(note)}</div>
        </div>
    `).join('');
}

function renderSystemHealthCharts(rows) {
    renderSystemHealthUtilizationChart('systemHealthPacketChart', rows, {
        key: 'packet',
        valueKey: 'packetPeak',
        capacityKey: 'packetCapacity',
        label: 'Packet Rate',
        formatter: formatSystemHealthRate
    });
    renderSystemHealthUtilizationChart('systemHealthThroughputChart', rows, {
        key: 'throughput',
        valueKey: 'throughputGbps',
        capacityKey: 'throughputCapacity',
        label: 'Throughput',
        formatter: formatSystemHealthGbps
    });
    renderSystemHealthUtilizationChart('systemHealthTriggersChart', rows, {
        key: 'triggers',
        valueKey: 'triggerCyclesPeak',
        capacityKey: 'triggerCyclesAvail',
        label: 'Trigger cycles',
        formatter: formatSystemHealthCycles,
        alert: row => row.triggerDropsTotal > 0,
        indicator: row => row.triggerDropsTotal > 0 ? 'drops detected' : ''
    });
    renderSystemHealthAnalysisChart(rows);
}

function renderSystemHealthUtilizationChart(canvasId, rows, options) {
    destroySystemHealthChart(canvasId);
    const canvas = document.getElementById(canvasId);
    const pages = systemHealthMetricModelPages(rows, options);
    const meta = currentSystemHealthModelPage(options.key, pages);
    updateSystemHealthModelHeader(options.key, meta, options);
    drawSystemHealthUtilizationCanvas(canvas, meta.rows, options, meta);
}

function renderSystemHealthAnalysisChart(rows) {
    const canvasId = 'systemHealthAnalysisChart';
    destroySystemHealthChart(canvasId);
    const canvas = document.getElementById(canvasId);
    const pages = systemHealthAnalysisModelPages(rows);
    const meta = currentSystemHealthModelPage('analysis', pages);
    updateSystemHealthAnalysisHeader(meta);
    drawSystemHealthAnalysisCanvas(canvas, meta.rows, meta);
}

function renderSystemHealthTable(rows) {
    const sorted = [...rows].sort((a, b) => {
        const aRisk = Math.max(
            a.packetCapacity ? a.packetPeak / a.packetCapacity : 0,
            a.throughputCapacity ? a.throughputGbps / a.throughputCapacity : 0,
            a.triggerCyclesAvail ? a.triggerCyclesPeak / a.triggerCyclesAvail : 0
        );
        const bRisk = Math.max(
            b.packetCapacity ? b.packetPeak / b.packetCapacity : 0,
            b.throughputCapacity ? b.throughputGbps / b.throughputCapacity : 0,
            b.triggerCyclesAvail ? b.triggerCyclesPeak / b.triggerCyclesAvail : 0
        );
        return bRisk - aRisk || (a.name || '').localeCompare(b.name || '');
    });

    document.getElementById('systemHealthTableBody').innerHTML = sorted.map(row => {
        const advancedCount = row.analysis.advanced || 0;
        const standardCount = row.analysis.standard || 0;
        const discoveryCount = row.analysis.discovery || 0;
        const totalCapacity = row.capacity && row.capacity.total_analysis !== null
            ? row.capacity.total_analysis
            : (row.advancedCapacity || 0) + (row.standardCapacity || 0);
        const overPacket = row.packetCapacity > 0 && row.packetPeak >= row.packetCapacity;
        const overThroughput = row.throughputCapacity > 0 && row.throughputGbps >= row.throughputCapacity;
        const overTriggers = row.triggerCyclesAvail > 0 && row.triggerCyclesPeak >= row.triggerCyclesAvail;
        const triggerDropsDetected = row.triggerDropsTotal > 0;
        const overAdvanced = row.advancedCapacity > 0 && advancedCount > row.advancedCapacity;
        const overStandard = row.standardCapacity > 0 && standardCount > row.standardCapacity;
        const overDiscovery = discoveryCount > 0;
        const rowFlagged = overPacket || overThroughput || overTriggers || triggerDropsDetected || overAdvanced || overStandard || overDiscovery;
        const cellClass = flag => flag ? ' class="system-health-overflow-cell"' : '';

        const statusText = systemHealthRowStatusText(row);
        return `
        <tr class="${rowFlagged ? 'system-health-overflow-row' : ''}">
            <td>${escapeSystemHealthHtml(row.name || row.hostname || row.id)}${statusText ? `<br><span class="field-hint">${escapeSystemHealthHtml(statusText)}</span>` : ''}</td>
            <td>${escapeSystemHealthHtml(row.license_platform || '')}</td>
            <td${cellClass(overPacket)}>${formatSystemHealthRate(row.packetPeak)}</td>
            <td>${formatSystemHealthRate(row.packetCapacity)}</td>
            <td${cellClass(overThroughput)}>${formatSystemHealthGbps(row.throughputGbps)}</td>
            <td>${formatSystemHealthGbps(row.throughputCapacity)}</td>
            <td${cellClass(overTriggers)}>${formatSystemHealthTriggerCapacity(row)}</td>
            <td${cellClass(triggerDropsDetected)}>${formatSystemHealthNumber(row.triggerDropsTotal)}</td>
            <td${cellClass(overAdvanced)}>${formatSystemHealthTierValue(advancedCount, row.advancedCapacity || 0)}</td>
            <td${cellClass(overStandard)}>${formatSystemHealthTierValue(standardCount, row.standardCapacity || 0)}</td>
            <td${cellClass(overDiscovery)}>${formatSystemHealthNumber(discoveryCount)}</td>
            <td>${formatSystemHealthNumber(totalCapacity)}</td>
        </tr>
    `;
    }).join('') || '<tr><td colspan="12">No Discover sensors were returned.</td></tr>';
}

function renderSystemHealthErrors(errors) {
    const notes = document.getElementById('systemHealthNotes');
    const list = document.getElementById('systemHealthErrorList');
    notes.style.display = errors.length ? 'block' : 'none';
    list.innerHTML = errors.map(error => `<li>${escapeSystemHealthHtml(error)}</li>`).join('');
}

function capitalizeSystemHealthKey(key) {
    return key.charAt(0).toUpperCase() + key.slice(1);
}

function resetSystemHealthPages() {
    systemHealthState.pages.packetModel = 0;
    systemHealthState.pages.packetRow = 0;
    systemHealthState.pages.throughputModel = 0;
    systemHealthState.pages.throughputRow = 0;
    systemHealthState.pages.triggersModel = 0;
    systemHealthState.pages.triggersRow = 0;
    systemHealthState.pages.analysisModel = 0;
    systemHealthState.pages.analysisRow = 0;
}

function setupSystemHealthPagers() {
    ['packet', 'throughput', 'triggers', 'analysis'].forEach(key => {
        const pager = document.getElementById(`systemHealth${capitalizeSystemHealthKey(key)}Pager`);
        const prev = pager ? pager.querySelector('[data-system-health-pager-prev]') : null;
        const next = pager ? pager.querySelector('[data-system-health-pager-next]') : null;
        const rowPager = document.getElementById(`systemHealth${capitalizeSystemHealthKey(key)}RowPager`);
        const rowPrev = rowPager ? rowPager.querySelector('[data-system-health-row-pager-prev]') : null;
        const rowNext = rowPager ? rowPager.querySelector('[data-system-health-row-pager-next]') : null;
        if (prev) prev.addEventListener('click', () => {
            if (!systemHealthState.currentReport) return;
            systemHealthState.pages[`${key}Model`] = Math.max(0, (systemHealthState.pages[`${key}Model`] || 0) - 1);
            systemHealthState.pages[`${key}Row`] = 0;
            renderSystemHealthReport(systemHealthState.currentReport);
        });
        if (next) next.addEventListener('click', () => {
            if (!systemHealthState.currentReport) return;
            systemHealthState.pages[`${key}Model`] = (systemHealthState.pages[`${key}Model`] || 0) + 1;
            systemHealthState.pages[`${key}Row`] = 0;
            renderSystemHealthReport(systemHealthState.currentReport);
        });
        if (rowPrev) rowPrev.addEventListener('click', () => {
            if (!systemHealthState.currentReport) return;
            systemHealthState.pages[`${key}Row`] = Math.max(0, (systemHealthState.pages[`${key}Row`] || 0) - 1);
            renderSystemHealthReport(systemHealthState.currentReport);
        });
        if (rowNext) rowNext.addEventListener('click', () => {
            if (!systemHealthState.currentReport) return;
            systemHealthState.pages[`${key}Row`] = (systemHealthState.pages[`${key}Row`] || 0) + 1;
            renderSystemHealthReport(systemHealthState.currentReport);
        });
    });
}

function systemHealthModelName(row) {
    return row.license_platform || (row.capacity && row.capacity.model) || 'Unknown';
}

function systemHealthMetricModelPages(rows, options) {
    const grouped = new Map();
    rows.forEach(row => {
        const model = systemHealthModelName(row);
        if (!grouped.has(model)) grouped.set(model, []);
        const capacity = Number(row[options.capacityKey] || 0);
        const value = Number(row[options.valueKey] || 0);
        grouped.get(model).push({
            ...row,
            alert: typeof options.alert === 'function' ? !!options.alert(row) : false,
            utilization: capacity > 0 ? value / capacity : null
        });
    });

    const pages = Array.from(grouped.entries()).map(([model, modelRows]) => {
        modelRows.sort((a, b) => {
            const aUtil = a.utilization === null ? -1 : a.utilization;
            const bUtil = b.utilization === null ? -1 : b.utilization;
            return Number(b.alert) - Number(a.alert) || bUtil - aUtil || (b[options.valueKey] || 0) - (a[options.valueKey] || 0) || (a.name || '').localeCompare(b.name || '');
        });
        const capacityRows = modelRows.filter(row => Number(row[options.capacityKey] || 0) > 0);
        const capacity = capacityRows.length ? Number(capacityRows[0][options.capacityKey] || 0) : 0;
        const maxUtilization = modelRows.reduce((max, row) => Math.max(max, row.utilization || 0), 0);
        const alertRows = modelRows.filter(row => row.alert).length;
        return { model, rows: modelRows, capacity, maxUtilization, ratedRows: capacityRows.length, alertRows };
    });

    pages.sort((a, b) => b.alertRows - a.alertRows || b.maxUtilization - a.maxUtilization || b.rows.length - a.rows.length || a.model.localeCompare(b.model));
    return pages;
}

function systemHealthAnalysisModelPages(rows) {
    const grouped = new Map();
    rows.forEach(row => {
        const model = systemHealthModelName(row);
        if (!grouped.has(model)) grouped.set(model, []);
        grouped.get(model).push(row);
    });

    const pages = Array.from(grouped.entries()).map(([model, modelRows]) => {
        const capacityRow = modelRows.find(row => row.advancedCapacity || row.standardCapacity) || {};
        const advancedCapacity = Number(capacityRow.advancedCapacity || 0);
        const standardCapacity = Number(capacityRow.standardCapacity || 0);
        const rowsWithRisk = modelRows.map(row => {
            const advanced = row.analysis.advanced || 0;
            const standard = row.analysis.standard || 0;
            const discovery = row.analysis.discovery || 0;
            const advancedRatio = advancedCapacity ? advanced / advancedCapacity : 0;
            const standardRatio = standardCapacity ? standard / standardCapacity : 0;
            const risk = Math.max(advancedRatio, standardRatio) + (discovery > 0 ? 0.001 + Math.min(1, discovery / 1000) : 0);
            return { ...row, advancedRatio, standardRatio, discoveryOverflow: discovery, risk };
        }).sort((a, b) => b.risk - a.risk || b.discoveryOverflow - a.discoveryOverflow || (a.name || '').localeCompare(b.name || ''));
        const discoveryTotal = rowsWithRisk.reduce((sum, row) => sum + (row.analysis.discovery || 0), 0);
        return { model, rows: rowsWithRisk, advancedCapacity, standardCapacity, discoveryTotal };
    });

    pages.sort((a, b) => b.discoveryTotal - a.discoveryTotal || b.rows.length - a.rows.length || a.model.localeCompare(b.model));
    return pages;
}

function currentSystemHealthModelPage(key, pages) {
    const allPages = pages.length ? pages : [{ model: 'No data', rows: [] }];
    const modelKey = `${key}Model`;
    const rowKey = `${key}Row`;
    const modelPageCount = Math.max(1, allPages.length);
    const modelPage = Math.min(Math.max(0, systemHealthState.pages[modelKey] || 0), modelPageCount - 1);
    systemHealthState.pages[modelKey] = modelPage;

    const page = allPages[modelPage];
    const rowPageCount = Math.max(1, Math.ceil((page.rows || []).length / SYSTEM_HEALTH_ROWS_PER_PAGE));
    const rowPage = Math.min(Math.max(0, systemHealthState.pages[rowKey] || 0), rowPageCount - 1);
    systemHealthState.pages[rowKey] = rowPage;

    return {
        ...page,
        rows: (page.rows || []).slice(rowPage * SYSTEM_HEALTH_ROWS_PER_PAGE, (rowPage + 1) * SYSTEM_HEALTH_ROWS_PER_PAGE),
        allRows: page.rows || [],
        modelPage,
        modelPageCount,
        rowPage,
        rowPageCount,
        totalRows: (page.rows || []).length
    };
}

function updateSystemHealthModelHeader(key, meta, options) {
    const prefix = capitalizeSystemHealthKey(key);
    const modelEl = document.getElementById(`systemHealth${prefix}ModelName`);
    const statsEl = document.getElementById(`systemHealth${prefix}ModelStats`);
    const pagerLabel = document.getElementById(`systemHealth${prefix}PagerLabel`);
    if (modelEl) modelEl.textContent = meta.model;
    if (statsEl) {
        const parts = [
            `${meta.totalRows} ${meta.totalRows === 1 ? 'sensor' : 'sensors'}`,
            meta.capacity ? `${options.label} cap ${options.formatter(meta.capacity)}` : 'No catalog capacity match',
            'Sorted by percent of model capacity',
            `Peak ${systemHealthReportCycleLabel(systemHealthState.currentReport || {})} average`
        ];
        if (meta.maxUtilization) parts.push(`Peak ${Math.round(meta.maxUtilization * 100)}%`);
        if (meta.alertRows) parts.push(`${meta.alertRows} with drops`);
        statsEl.textContent = parts.join(' | ');
    }
    if (pagerLabel) {
        const rowText = meta.rowPageCount > 1 ? ` | Page ${meta.rowPage + 1} of ${meta.rowPageCount}` : '';
        pagerLabel.textContent = `Model ${meta.modelPage + 1} of ${meta.modelPageCount}${rowText}`;
    }
    updateSystemHealthModelPager(key, meta);
    updateSystemHealthUtilizationLegend();
}

function updateSystemHealthAnalysisHeader(meta) {
    const modelEl = document.getElementById('systemHealthAnalysisModelName');
    const statsEl = document.getElementById('systemHealthAnalysisModelStats');
    const pagerLabel = document.getElementById('systemHealthAnalysisPagerLabel');
    if (modelEl) modelEl.textContent = meta.model;
    if (statsEl) {
        const advancedHot = meta.allRows.filter(row => row.advancedRatio >= 1).length;
        const standardHot = meta.allRows.filter(row => row.standardRatio >= 1).length;
        const discoveryHot = meta.allRows.filter(row => (row.analysis.discovery || 0) > 0).length;
        const parts = [
            `${meta.totalRows} ${meta.totalRows === 1 ? 'sensor' : 'sensors'}`,
            `Adv cap ${meta.advancedCapacity ? formatSystemHealthNumber(meta.advancedCapacity) : '-'}`,
            `Std cap ${meta.standardCapacity ? formatSystemHealthNumber(meta.standardCapacity) : '-'}`
        ];
        if (advancedHot) parts.push(`${advancedHot} at Adv cap`);
        if (standardHot) parts.push(`${standardHot} at Std cap`);
        if (discoveryHot) parts.push(`${discoveryHot} with Discovery overflow`);
        statsEl.textContent = parts.join(' | ');
    }
    if (pagerLabel) {
        const rowText = meta.rowPageCount > 1 ? ` | Page ${meta.rowPage + 1} of ${meta.rowPageCount}` : '';
        pagerLabel.textContent = `Model ${meta.modelPage + 1} of ${meta.modelPageCount}${rowText}`;
    }
    updateSystemHealthModelPager('analysis', meta);
    updateSystemHealthUtilizationLegend();
}

function updateSystemHealthModelPager(key, meta) {
    const prefix = capitalizeSystemHealthKey(key);
    const modelPager = document.getElementById(`systemHealth${prefix}Pager`);
    const rowPager = document.getElementById(`systemHealth${prefix}RowPager`);
    if (modelPager) {
        modelPager.style.display = meta.modelPageCount > 1 ? 'flex' : 'none';
        const label = modelPager.querySelector('[data-system-health-pager-label]');
        const prev = modelPager.querySelector('[data-system-health-pager-prev]');
        const next = modelPager.querySelector('[data-system-health-pager-next]');
        if (label) label.textContent = `Model ${meta.modelPage + 1} of ${meta.modelPageCount}`;
        if (prev) prev.disabled = meta.modelPage <= 0;
        if (next) next.disabled = meta.modelPage >= meta.modelPageCount - 1;
    }
    if (rowPager) {
        rowPager.style.display = meta.rowPageCount > 1 ? 'flex' : 'none';
        const label = rowPager.querySelector('[data-system-health-row-pager-label]');
        const prev = rowPager.querySelector('[data-system-health-row-pager-prev]');
        const next = rowPager.querySelector('[data-system-health-row-pager-next]');
        if (label) label.textContent = `Page ${meta.rowPage + 1} of ${meta.rowPageCount}`;
        if (prev) prev.disabled = meta.rowPage <= 0;
        if (next) next.disabled = meta.rowPage >= meta.rowPageCount - 1;
    }
}

function updateSystemHealthUtilizationLegend() {
    const colors = systemHealthStyleColors();
    document.querySelectorAll('[data-system-health-util-swatch="low"]').forEach(el => { el.style.background = colors.low; });
    document.querySelectorAll('[data-system-health-util-swatch="mid"]').forEach(el => { el.style.background = colors.mid; });
    document.querySelectorAll('[data-system-health-util-swatch="high"]').forEach(el => { el.style.background = colors.high; });
    document.querySelectorAll('[data-system-health-util-swatch="discovery"]').forEach(el => {
        el.style.background = `linear-gradient(135deg, ${colors.mid}, ${colors.high})`;
    });
}

function setupSystemHealthCanvas(canvas, desiredHeight) {
    const colors = systemHealthStyleColors();
    const parent = canvas ? canvas.parentElement : null;
    if (!canvas || !parent) return null;
    canvas.style.height = `${desiredHeight}px`;
    const width = Math.max(320, Math.round(parent.getBoundingClientRect().width || parent.clientWidth || 960));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(desiredHeight * dpr);
    canvas.style.width = `${width}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, desiredHeight);
    if (!colors.transparent) {
        ctx.fillStyle = colors.bg;
        ctx.fillRect(0, 0, width, desiredHeight);
    }
    return { ctx, width, height: desiredHeight };
}

function drawSystemHealthEmpty(ctx, width, height, message) {
    const colors = systemHealthStyleColors();
    ctx.fillStyle = colors.muted;
    ctx.font = '16px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message, width / 2, height / 2);
}

function systemHealthChartCollectionStatus(row, key) {
    const metrics = key === 'packet' ? ['pkts']
        : key === 'throughput' ? ['bytes']
            : key === 'triggers' ? ['trigger_utilization']
                : [];
    const statuses = metrics.map(metric => row.collectionStatus && row.collectionStatus[metric]).filter(Boolean);
    return statuses.find(status => !['complete', 'zero_valued'].includes(status)) || statuses[0] || 'unknown';
}

function truncateSystemHealthCanvasText(ctx, text, maxWidth) {
    const raw = String(text || '');
    if (ctx.measureText(raw).width <= maxWidth) return raw;
    let value = raw;
    while (value.length > 1 && ctx.measureText(`${value}...`).width > maxWidth) {
        value = value.slice(0, -1);
    }
    return `${value}...`;
}

function drawSystemHealthPercentGrid(ctx, x, y, width, height) {
    const colors = systemHealthStyleColors();
    ctx.strokeStyle = colors.grid;
    ctx.fillStyle = colors.muted;
    ctx.font = '10px Arial';
    ctx.textBaseline = 'top';
    [0, 50, 80, 100].forEach(percent => {
        const gx = x + (width * percent) / 100;
        ctx.beginPath();
        ctx.moveTo(gx, y);
        ctx.lineTo(gx, y + height);
        ctx.stroke();
        ctx.textAlign = percent === 80 ? 'right' : percent === 100 ? 'left' : 'center';
        ctx.fillText(`${percent}%`, gx, y + height + 8);
    });
}

function drawSystemHealthValueGrid(ctx, x, y, width, height, maxValue, formatter) {
    const colors = systemHealthStyleColors();
    ctx.strokeStyle = colors.grid;
    ctx.fillStyle = colors.muted;
    ctx.font = '10px Arial';
    ctx.textBaseline = 'top';
    [0, 0.5, 1].forEach(ratio => {
        const gx = x + width * ratio;
        ctx.beginPath();
        ctx.moveTo(gx, y);
        ctx.lineTo(gx, y + height);
        ctx.stroke();
        ctx.textAlign = ratio === 0 ? 'left' : ratio === 1 ? 'right' : 'center';
        ctx.fillText(formatter(maxValue * ratio), gx, y + height + 8);
    });
}

function drawSystemHealthUtilizationCanvas(canvas, rows, options, meta) {
    const rowHeight = 28;
    const top = 22;
    const bottom = 38;
    const desiredHeight = top + bottom + Math.max(1, rows.length) * rowHeight;
    const canvasState = setupSystemHealthCanvas(canvas, desiredHeight);
    if (!canvasState) return;
    const { ctx, width, height } = canvasState;
    if (!rows.length) return drawSystemHealthEmpty(ctx, width, height, 'No rated sensor data returned yet');

    const colors = systemHealthStyleColors();
    const compact = width < 760;
    const left = compact ? 130 : 220;
    const right = compact ? 118 : 170;
    const plotWidth = Math.max(120, width - left - right);
    const plotHeight = height - top - bottom;
    const hasCapacity = rows.some(row => Number(row[options.capacityKey] || 0) > 0);
    const maxValue = Math.max(...rows.map(row => Number(row[options.valueKey] || 0)), 1);
    if (hasCapacity) {
        drawSystemHealthPercentGrid(ctx, left, top, plotWidth, plotHeight);
    } else {
        drawSystemHealthValueGrid(ctx, left, top, plotWidth, plotHeight, maxValue, options.formatter);
    }

    rows.forEach((row, index) => {
        const y = top + rowHeight * index + Math.max(2, rowHeight * 0.2);
        const barHeight = Math.max(5, Math.min(16, rowHeight * 0.56));
        const value = Number(row[options.valueKey] || 0);
        const capacity = Number(row[options.capacityKey] || 0);
        const utilization = capacity > 0 ? value / capacity : null;
        const collectionStatus = systemHealthChartCollectionStatus(row, options.key);
        const unavailable = row.offline || !['complete', 'zero_valued'].includes(collectionStatus);
        const fillRatio = unavailable ? 0 : utilization === null ? value / maxValue : Math.min(1.1, utilization);
        const fillWidth = Math.min(plotWidth, plotWidth * fillRatio);
        const labelY = y + barHeight / 2;

        if (index % 2 === 1) {
            ctx.fillStyle = colors.altRow;
            ctx.fillRect(10, y - 4, width - 20, rowHeight);
        }

        ctx.fillStyle = colors.subtle;
        ctx.font = '11px Arial';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(truncateSystemHealthCanvasText(ctx, row.name || row.hostname || row.id, left - 18), left - 10, labelY);

        ctx.fillStyle = colors.track;
        ctx.fillRect(left, y, plotWidth, barHeight);
        ctx.fillStyle = utilization === null ? colors.low : systemHealthUtilizationColor(utilization);
        ctx.fillRect(left, y, fillWidth, barHeight);

        ctx.textAlign = 'left';
        ctx.fillStyle = colors.text;
        ctx.font = '11px Arial';
        const primaryLabel = unavailable
            ? (row.offline ? 'offline' : collectionStatus.replace(/_/g, ' '))
            : utilization === null
                ? options.formatter(value)
                : `${Math.round(utilization * 100)}%`;
        ctx.fillText(primaryLabel, left + plotWidth + 10, labelY);
        ctx.fillStyle = colors.muted;
        ctx.font = '10px Arial';
        const secondaryLabel = unavailable || utilization === null ? '' : options.formatter(value);
        if (secondaryLabel) {
            ctx.fillText(secondaryLabel, left + plotWidth + (compact ? 48 : 56), labelY);
        }
        const indicator = typeof options.indicator === 'function' ? options.indicator(row) : '';
        if (indicator) {
            ctx.fillStyle = colors.high;
            ctx.font = '700 10px Arial';
            ctx.fillText(indicator, left + plotWidth + 10, labelY + 11);
        }
    });
}

function drawSystemHealthOfflineText(ctx, x, y) {
    const colors = systemHealthStyleColors();
    ctx.fillStyle = colors.muted;
    ctx.font = '700 10px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('offline', x, y);
}

function drawSystemHealthTierBar(ctx, x, y, width, height, value, capacity) {
    const colors = systemHealthStyleColors();
    ctx.fillStyle = colors.track;
    ctx.fillRect(x, y, width, height);

    if (!capacity) {
        ctx.fillStyle = colors.muted;
        ctx.font = '10px Arial';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(formatSystemHealthNumber(value), x + width + 6, y + height / 2);
        return;
    }

    const ratio = value / capacity;
    const fillRatio = Math.min(1, ratio);
    const fillWidth = width * fillRatio;
    ctx.fillStyle = systemHealthUtilizationColor(ratio);
    ctx.fillRect(x, y, fillWidth, height);

    const percentLabel = `${Math.round(ratio * 100)}%`;
    ctx.font = '700 10px Arial';
    ctx.textBaseline = 'middle';
    if (fillRatio > 0.22) {
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.fillText(percentLabel, x + fillWidth - 5, y + height / 2);
    } else {
        ctx.fillStyle = colors.text;
        ctx.textAlign = 'left';
        ctx.fillText(percentLabel, x + fillWidth + 5, y + height / 2);
    }

    ctx.fillStyle = colors.subtle;
    ctx.font = '10px Arial';
    ctx.textAlign = 'left';
    ctx.fillText(formatSystemHealthTierValue(value, capacity), x + width + 7, y + height / 2);
}

function formatSystemHealthTierValue(value, capacity) {
    const countLabel = formatSystemHealthNumber(value);
    return capacity ? `${countLabel} / ${formatSystemHealthNumber(capacity)}` : countLabel;
}

function drawSystemHealthDiscoveryChip(ctx, x, y, height, value) {
    const colors = systemHealthStyleColors();
    ctx.font = '700 10px Arial';
    ctx.textBaseline = 'middle';
    if (!value) {
        ctx.fillStyle = colors.muted;
        ctx.textAlign = 'left';
        ctx.fillText('-', x, y + height / 2);
        return;
    }

    const label = formatSystemHealthNumber(value);
    const padX = 8;
    const chipWidth = ctx.measureText(label).width + padX * 2;
    const gradient = ctx.createLinearGradient(x, y, x + chipWidth, y);
    gradient.addColorStop(0, colors.mid);
    gradient.addColorStop(1, colors.high);
    ctx.fillStyle = gradient;
    if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(x, y, chipWidth, height, height / 2);
        ctx.fill();
    } else {
        ctx.fillRect(x, y, chipWidth, height);
    }
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(label, x + chipWidth / 2, y + height / 2);
}

function drawSystemHealthAnalysisCanvas(canvas, rows, meta) {
    const headerHeight = 32;
    const top = 18 + headerHeight;
    const bottom = 22;
    const rowHeight = 32;
    const desiredHeight = top + bottom + Math.max(1, rows.length) * rowHeight;
    const canvasState = setupSystemHealthCanvas(canvas, desiredHeight);
    if (!canvasState) return;
    const { ctx, width, height } = canvasState;
    if (!rows.length) return drawSystemHealthEmpty(ctx, width, height, 'No device analysis data returned yet');

    const colors = systemHealthStyleColors();
    const compact = width < 820;
    const padX = compact ? 10 : 20;
    const nameColWidth = compact ? 128 : 200;
    const discoveryColWidth = compact ? 76 : 120;
    const gap = compact ? 8 : 18;
    const valueLabelWidth = compact ? 68 : 100;
    const barsAvailable = width - padX * 2 - nameColWidth - discoveryColWidth - gap * 3 - valueLabelWidth * 2;
    const barWidth = Math.max(compact ? 62 : 120, barsAvailable / 2);
    const advancedX = padX + nameColWidth + gap;
    const standardX = advancedX + barWidth + valueLabelWidth + gap;
    const discoveryX = standardX + barWidth + valueLabelWidth + gap;

    ctx.fillStyle = colors.muted;
    ctx.font = '700 10px Arial';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'right';
    ctx.fillText('SENSOR', padX + nameColWidth, 32);
    ctx.textAlign = 'left';
    ctx.fillText('ADVANCED', advancedX, 32);
    ctx.fillText('STANDARD', standardX, 32);
    ctx.fillText('DISCOVERY', discoveryX, 32);
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.moveTo(padX, 42);
    ctx.lineTo(width - padX, 42);
    ctx.stroke();

    rows.forEach((row, index) => {
        const y = top + rowHeight * index;
        const centerY = y + rowHeight / 2;
        const barHeight = 16;
        const barY = centerY - barHeight / 2;

        if (index % 2 === 1) {
            ctx.fillStyle = colors.altRow;
            ctx.fillRect(padX, y, width - padX * 2, rowHeight);
        }

        ctx.fillStyle = colors.text;
        ctx.font = '11px Arial';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(truncateSystemHealthCanvasText(ctx, row.name || row.hostname || row.id, nameColWidth - 8), padX + nameColWidth, centerY);
        if (row.offline) {
            drawSystemHealthOfflineText(ctx, advancedX, centerY);
            drawSystemHealthOfflineText(ctx, standardX, centerY);
            drawSystemHealthOfflineText(ctx, discoveryX, centerY);
            return;
        }
        drawSystemHealthTierBar(ctx, advancedX, barY, barWidth, barHeight, row.analysis.advanced || 0, meta.advancedCapacity || 0);
        drawSystemHealthTierBar(ctx, standardX, barY, barWidth, barHeight, row.analysis.standard || 0, meta.standardCapacity || 0);
        drawSystemHealthDiscoveryChip(ctx, discoveryX, barY, barHeight, row.analysis.discovery || 0);
    });
}

function setupSystemHealthExportButtons() {
    document.querySelectorAll('[data-system-health-export]').forEach(button => {
        button.addEventListener('click', () => {
            const canvas = document.getElementById(button.dataset.systemHealthExport);
            if (!canvas) return;
            const link = document.createElement('a');
            link.download = systemHealthPngFilename(button.dataset.systemHealthExport);
            link.href = canvas.toDataURL('image/png');
            link.click();
        });
    });
}

function systemHealthPngFilename(canvasId) {
    const map = {
        systemHealthPacketChart: ['packet-rate', 'packet'],
        systemHealthThroughputChart: ['throughput', 'throughput'],
        systemHealthTriggersChart: ['trigger-cycle-capacity', 'triggers'],
        systemHealthAnalysisChart: ['analysis-tier-pressure', 'analysis']
    };
    const [prefix, key] = map[canvasId] || [canvasId, ''];
    const report = systemHealthState.currentReport;
    const rows = report ? systemHealthRows(report) : [];
    const pages = key === 'analysis'
        ? systemHealthAnalysisModelPages(rows)
        : key
            ? systemHealthMetricModelPages(rows, key === 'packet'
                ? { valueKey: 'packetPeak', capacityKey: 'packetCapacity' }
                : key === 'throughput'
                    ? { valueKey: 'throughputGbps', capacityKey: 'throughputCapacity' }
                    : { valueKey: 'triggerCyclesPeak', capacityKey: 'triggerCyclesAvail' })
            : [];
    const modelPage = Math.min(systemHealthState.pages[`${key}Model`] || 0, Math.max(0, pages.length - 1));
    const model = pages[modelPage] ? pages[modelPage].model : 'unknown';
    return `${prefix}-${slugSystemHealthFilename(model)}.png`;
}

function slugSystemHealthFilename(value) {
    return String(value || 'unknown')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'unknown';
}

function setupSystemHealthCsvControls() {
    const loadButton = document.getElementById('systemHealthLoadCsvButton');
    const exportButton = document.getElementById('systemHealthExportCsvButton');
    const pdfButton = document.getElementById('systemHealthExportPdfButton');
    const input = document.getElementById('systemHealthCsvInput');
    if (loadButton && input) loadButton.addEventListener('click', () => input.click());
    if (input) input.addEventListener('change', loadSystemHealthCsvFiles);
    if (exportButton) exportButton.addEventListener('click', exportSystemHealthCsvFiles);
    if (pdfButton) pdfButton.addEventListener('click', exportSystemHealthPdf);
    updateSystemHealthCsvButtons();
}

function updateSystemHealthCsvButtons() {
    const exportButton = document.getElementById('systemHealthExportCsvButton');
    const pdfButton = document.getElementById('systemHealthExportPdfButton');
    if (exportButton) exportButton.disabled = !systemHealthState.currentReport;
    if (pdfButton) pdfButton.disabled = !systemHealthState.currentReport;
}

async function loadSystemHealthCsvFiles(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;

    try {
        const byName = {};
        for (const file of files) {
            byName[file.name.toLowerCase()] = parseSystemHealthCsv(await file.text());
        }
        const bytesSummary = byName['capture_bytes_summary.csv'] || [];
        const pktsSummary = byName['capture_pkts_summary.csv'] || [];
        const triggerCyclesSummary = byName['capture_trigger_cycles_summary.csv'] || [];
        const triggerCyclesAvailSummary = byName['capture_trigger_cycles_avail_summary.csv'] || [];
        const triggerDropsSummary = byName['capture_trigger_drops_summary.csv'] || [];
        const deviceSummary = byName['device_analysis_summary.csv'] || [];
        if (!bytesSummary.length && !pktsSummary.length && !triggerCyclesSummary.length && !triggerCyclesAvailSummary.length && !triggerDropsSummary.length && !deviceSummary.length) {
            throw new Error('Select system health summary CSV files from a previous run.');
        }

        await loadSystemHealthCatalog();
        const report = buildSystemHealthReportFromCsvSummaries({ bytesSummary, pktsSummary, triggerCyclesSummary, triggerCyclesAvailSummary, triggerDropsSummary, deviceSummary });
        systemHealthState.currentReport = report;
        resetSystemHealthPages();
        document.getElementById('systemHealthResults').style.display = 'block';
        renderSystemHealthReport(report);
        setSystemHealthCsvStatus(`Loaded CSV summaries: ${files.map(file => file.name).join(', ')}`);
    } catch (error) {
        setSystemHealthCsvStatus(`CSV load failed: ${error.message}`, true);
    }
}

function buildSystemHealthReportFromCsvSummaries(csv) {
    const appliances = new Map();
    [
        ...csv.bytesSummary,
        ...csv.pktsSummary,
        ...csv.triggerCyclesSummary,
        ...csv.triggerCyclesAvailSummary,
        ...csv.triggerDropsSummary,
        ...csv.deviceSummary
    ].forEach(row => {
        if (!row.appliance_id) return;
        const id = systemHealthCsvKey(row);
        if (!appliances.has(id)) {
            const appliance = {
                id,
                source_appliance_id: systemHealthNumberOrString(row.appliance_id),
                name: row.appliance_name || `Sensor ${row.appliance_id}`,
                hostname: row.hostname || '',
                platform: row.platform || '',
                license_platform: row.license_platform || '',
                online: row.online === '' ? true : String(row.online).toLowerCase() === 'true',
                metric_eligible: row.metric_eligible === '' ? true : String(row.metric_eligible).toLowerCase() === 'true',
                data_access: row.data_access === '' ? undefined : String(row.data_access).toLowerCase() === 'true',
                license_status: row.license_status || '',
                status_message: row.status_message || '',
                advanced_analysis_capacity: systemHealthNumber(row.advanced_analysis_capacity),
                total_capacity: systemHealthNumber(row.total_capacity),
                health_conditions: [],
                uuid: '',
                firmware_version: ''
            };
            appliance.capacity = capacityForSystemHealthAppliance(appliance);
            appliances.set(id, appliance);
        }
    });

    const deviceAnalysis = {};
    csv.deviceSummary.forEach(row => {
        deviceAnalysis[systemHealthCsvKey(row)] = {
            advanced: systemHealthNumber(row.advanced_devices),
            standard: systemHealthNumber(row.standard_devices),
            discovery: systemHealthNumber(row.discovery_devices),
            unrecognized: systemHealthNumber(row.unrecognized_analysis_devices),
            total: systemHealthNumber(row.analysis_total_devices),
            status: row.collection_status || 'unknown'
        };
    });

    const cycleInput = document.getElementById('systemHealthCycle');
    const cycle = cycleInput ? cycleInput.value || '1hr' : '1hr';
    const triggerUtilization = {
        aggregation_mode: 'aligned_time_series_ratio',
        zero_available_policy: 'invalid_bucket_excluded',
        peak_by_sensor: {},
        invalid_by_sensor: {}
    };
    csv.triggerCyclesSummary.forEach(row => {
        const id = systemHealthCsvKey(row);
        const utilization = systemHealthNumber(row.trigger_utilization);
        if (utilization === null) return;
        triggerUtilization.peak_by_sensor[id] = {
            utilization,
            used_cycles: systemHealthNumber(row.trigger_used_cycles),
            available_cycles: systemHealthNumber(row.trigger_available_cycles),
            timestamp_ms: systemHealthNumber(row.trigger_peak_timestamp_ms),
            duration_ms: systemHealthNumber(row.trigger_peak_duration_ms),
            actual_cycle: row.actual_cycle || cycle
        };
    });
    return {
        generated_at: new Date().toISOString(),
        target: { type: 'csv', name: 'summary CSV files' },
        window: { lookback_days: 'CSV', until: 'latest CSV row' },
        cycle,
        summary_cycle_duration_ms: systemHealthCycleToMs(cycle),
        capacity_catalog_loaded: systemHealthState.catalogLoaded,
        appliances: Array.from(appliances.values()),
        device_analysis: deviceAnalysis,
        metrics: {
            bytes: {
                metric_category_used: 'csv summary',
                rows: [],
                summary: summarizeSystemHealthSummaryCsv(csv.bytesSummary),
                sensor_status: systemHealthCsvSensorStatus(csv.bytesSummary)
            },
            pkts: {
                metric_category_used: 'csv summary',
                rows: [],
                summary: summarizeSystemHealthSummaryCsv(csv.pktsSummary),
                sensor_status: systemHealthCsvSensorStatus(csv.pktsSummary)
            },
            trigger_cycles: {
                metric_category_used: 'csv summary',
                rows: [],
                summary: summarizeSystemHealthSummaryCsv(csv.triggerCyclesSummary),
                sensor_status: systemHealthCsvSensorStatus(csv.triggerCyclesSummary)
            },
            trigger_cycles_avail: {
                metric_category_used: 'csv summary',
                rows: [],
                summary: summarizeSystemHealthSummaryCsv(csv.triggerCyclesAvailSummary),
                sensor_status: systemHealthCsvSensorStatus(csv.triggerCyclesAvailSummary)
            },
            trigger_drops: {
                metric_category_used: 'csv summary',
                rows: [],
                summary: summarizeSystemHealthSummaryCsv(csv.triggerDropsSummary),
                sensor_status: systemHealthCsvSensorStatus(csv.triggerDropsSummary)
            }
        },
        trigger_utilization: triggerUtilization,
        errors: []
    };
}

function summarizeSystemHealthSummaryCsv(rows) {
    const summary = {
        aggregation_mode: rows[0] && rows[0].aggregation_mode || 'time_series',
        totals: {},
        point_counts: {},
        avg_values: {},
        peak_values: {},
        peak_times: {},
        latest_values: {},
        latest_times: {},
        peak_duration_ms: {},
        average_rates: {},
        aggregation_duration_ms: {},
        actual_cycles: {}
    };
    rows.forEach(row => {
        const id = systemHealthCsvKey(row);
        const assignments = [
            ['totals', 'total_value'],
            ['point_counts', 'point_count'],
            ['avg_values', 'avg_value'],
            ['peak_values', 'peak_value'],
            ['latest_values', 'latest_value'],
            ['peak_duration_ms', 'peak_duration_ms'],
            ['average_rates', 'average_rate'],
            ['aggregation_duration_ms', 'aggregation_duration_ms']
        ];
        assignments.forEach(([target, source]) => {
            const value = systemHealthNumber(row[source]);
            if (value !== null) summary[target][id] = value;
        });
        if (row.actual_cycle) summary.actual_cycles[id] = row.actual_cycle;
        const peakMs = Date.parse(row.peak_time_iso || '');
        if (Number.isFinite(peakMs)) summary.peak_times[id] = peakMs;
    });
    return summary;
}

function systemHealthCsvSensorStatus(rows) {
    return Object.fromEntries(rows.map(row => [
        systemHealthCsvKey(row),
        { status: row.collection_status || 'unknown' }
    ]));
}

function exportSystemHealthCsvFiles() {
    const report = systemHealthState.currentReport;
    if (!report) return;
    const appliancesById = Object.fromEntries((report.appliances || []).map(appliance => [String(appliance.id), appliance]));
    downloadSystemHealthCsv('capture_bytes.csv', systemHealthMetricRowsCsv((report.metrics.bytes && report.metrics.bytes.rows) || [], appliancesById, 'bytes'));
    downloadSystemHealthCsv('capture_pkts.csv', systemHealthMetricRowsCsv((report.metrics.pkts && report.metrics.pkts.rows) || [], appliancesById, 'pkts'));
    downloadSystemHealthCsv('capture_trigger_cycles.csv', systemHealthMetricRowsCsv((report.metrics.trigger_cycles && report.metrics.trigger_cycles.rows) || [], appliancesById, 'trigger_cycles'));
    downloadSystemHealthCsv('capture_trigger_cycles_avail.csv', systemHealthMetricRowsCsv((report.metrics.trigger_cycles_avail && report.metrics.trigger_cycles_avail.rows) || [], appliancesById, 'trigger_cycles_avail'));
    downloadSystemHealthCsv('capture_trigger_drops.csv', systemHealthMetricRowsCsv((report.metrics.trigger_drops && report.metrics.trigger_drops.rows) || [], appliancesById, 'trigger_drops'));
    downloadSystemHealthCsv('capture_bytes_summary.csv', systemHealthSummaryCsv(report, 'bytes', appliancesById));
    downloadSystemHealthCsv('capture_pkts_summary.csv', systemHealthSummaryCsv(report, 'pkts', appliancesById));
    downloadSystemHealthCsv('capture_trigger_cycles_summary.csv', systemHealthSummaryCsv(report, 'trigger_cycles', appliancesById));
    downloadSystemHealthCsv('capture_trigger_cycles_avail_summary.csv', systemHealthSummaryCsv(report, 'trigger_cycles_avail', appliancesById));
    downloadSystemHealthCsv('capture_trigger_drops_summary.csv', systemHealthSummaryCsv(report, 'trigger_drops', appliancesById));
    downloadSystemHealthCsv('device_analysis_summary.csv', systemHealthDeviceAnalysisCsv(report, appliancesById));
    setSystemHealthCsvStatus('Exported system health metric, trigger, and device analysis CSV files.');
}

async function exportSystemHealthPdf() {
    const report = systemHealthState.currentReport;
    if (!report) return;
    const button = document.getElementById('systemHealthExportPdfButton');
    if (button) button.disabled = true;
    setSystemHealthCsvStatus('Rendering system health PDF...');
    try {
        const response = await fetch('/backend/system-health/pdf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/pdf' },
            body: JSON.stringify({ report: systemHealthPdfProjection(report), style: systemHealthPdfStyle() })
        });
        if (!response.ok) {
            let message = `PDF export failed with HTTP ${response.status}`;
            try {
                const payload = await response.json();
                message = (payload && payload.detail && payload.detail.message) || (payload && payload.message) || message;
            } catch {}
            throw new Error(message);
        }
        const blob = await response.blob();
        const disposition = response.headers.get('content-disposition') || '';
        const filenameMatch = /filename="?([^"]+)"?/i.exec(disposition);
        const filename = filenameMatch ? filenameMatch[1] : systemHealthPdfFilename(report);
        const link = document.createElement('a');
        link.download = filename;
        link.href = URL.createObjectURL(blob);
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        setSystemHealthCsvStatus('Exported system health PDF.');
    } catch (error) {
        setSystemHealthCsvStatus(error.message || 'PDF export failed.', true);
    } finally {
        if (button) button.disabled = !systemHealthState.currentReport;
    }
}

function systemHealthPdfProjection(report) {
    return {
        ...report,
        metrics: Object.fromEntries(Object.entries(report.metrics || {}).map(([name, metric]) => [
            name,
            { ...metric, rows: [] }
        ]))
    };
}

function systemHealthPdfFilename(report) {
    const day = String(report.generated_at || new Date().toISOString()).slice(0, 10);
    return `system-health-report-${day}.pdf`;
}

function systemHealthMetricRowsCsv(rows, appliancesById, metricName) {
    const columns = ['appliance_id', 'metric_object_id', 'appliance_name', 'hostname', 'platform', 'license_platform', 'metric', 'aggregation_mode', 'actual_cycle', 'timestamp_ms', 'time_iso', 'duration_ms', 'aggregation_duration_ms', 'value', 'collection_status'];
    const csvRows = rows.map(row => {
        const appliance = appliancesById[String(row.appliance_id)] || {};
        const metric = (systemHealthState.currentReport.metrics || {})[metricName] || {};
        const status = metric.sensor_status && metric.sensor_status[String(row.appliance_id)];
        return {
            appliance_id: row.appliance_id,
            metric_object_id: row.metric_object_id || row.appliance_id,
            appliance_name: row.appliance_name || appliance.name || '',
            hostname: row.hostname || appliance.hostname || '',
            platform: row.platform || appliance.platform || '',
            license_platform: row.license_platform || appliance.license_platform || '',
            metric: row.metric || metricName,
            aggregation_mode: row.aggregation_mode || metric.aggregation_mode || '',
            actual_cycle: row.actual_cycle || '',
            timestamp_ms: row.timestamp_ms || '',
            time_iso: row.time_iso || systemHealthMsToIso(row.timestamp_ms),
            duration_ms: row.duration_ms || '',
            aggregation_duration_ms: row.aggregation_duration_ms || '',
            value: row.value === null || row.value === undefined ? '' : row.value,
            collection_status: status ? status.status : ''
        };
    });
    return systemHealthRowsToCsv(columns, csvRows);
}

function systemHealthSummaryCsv(report, metricName, appliancesById) {
    const columns = [
        'appliance_id', 'appliance_name', 'hostname', 'platform', 'license_platform',
        'aggregation_mode', 'collection_status', 'actual_cycle', 'report_from_ms', 'report_until_ms',
        'point_count', 'total_value', 'avg_value', 'average_rate', 'aggregation_duration_ms',
        'peak_value', 'peak_time_iso', 'peak_duration_ms', 'latest_value',
        'trigger_utilization', 'trigger_used_cycles', 'trigger_available_cycles',
        'trigger_peak_timestamp_ms', 'trigger_peak_duration_ms'
    ];
    const summary = (report.metrics[metricName] && report.metrics[metricName].summary) || summarizeSystemHealthRows([]);
    const metric = report.metrics[metricName] || {};
    const ids = new Set([...Object.keys(appliancesById), ...Object.keys(summary.point_counts || {})]);
    const rows = Array.from(ids).sort(systemHealthSortIds).map(id => {
        const appliance = appliancesById[String(id)] || {};
        const alignedTrigger = report.trigger_utilization
            && report.trigger_utilization.peak_by_sensor
            && report.trigger_utilization.peak_by_sensor[String(id)];
        const status = metric.sensor_status && metric.sensor_status[String(id)];
        return {
            appliance_id: id,
            appliance_name: appliance.name || appliance.appliance_name || `Sensor ${id}`,
            hostname: appliance.hostname || '',
            platform: appliance.platform || '',
            license_platform: appliance.license_platform || '',
            aggregation_mode: metric.aggregation_mode || summary.aggregation_mode || '',
            collection_status: status ? status.status : '',
            actual_cycle: summary.actual_cycles && summary.actual_cycles[id] || (alignedTrigger && alignedTrigger.actual_cycle) || '',
            report_from_ms: report.window && report.window.from_ms,
            report_until_ms: report.window && report.window.until_ms,
            point_count: summary.point_counts && summary.point_counts[id] || 0,
            total_value: summary.totals && summary.totals[id] !== undefined ? summary.totals[id] : '',
            avg_value: summary.avg_values && summary.avg_values[id] !== undefined ? summary.avg_values[id] : '',
            average_rate: summary.average_rates && summary.average_rates[id] !== undefined ? summary.average_rates[id] : '',
            aggregation_duration_ms: summary.aggregation_duration_ms && summary.aggregation_duration_ms[id] !== undefined ? summary.aggregation_duration_ms[id] : '',
            peak_value: summary.peak_values && summary.peak_values[id] !== undefined ? summary.peak_values[id] : '',
            peak_time_iso: systemHealthMsToIso(summary.peak_times && summary.peak_times[id]),
            peak_duration_ms: summary.peak_duration_ms && summary.peak_duration_ms[id] !== undefined ? summary.peak_duration_ms[id] : '',
            latest_value: summary.latest_values && summary.latest_values[id] !== undefined ? summary.latest_values[id] : '',
            trigger_utilization: metricName === 'trigger_cycles' && alignedTrigger ? alignedTrigger.utilization : '',
            trigger_used_cycles: metricName === 'trigger_cycles' && alignedTrigger ? alignedTrigger.used_cycles : '',
            trigger_available_cycles: metricName === 'trigger_cycles' && alignedTrigger ? alignedTrigger.available_cycles : '',
            trigger_peak_timestamp_ms: metricName === 'trigger_cycles' && alignedTrigger ? alignedTrigger.timestamp_ms : '',
            trigger_peak_duration_ms: metricName === 'trigger_cycles' && alignedTrigger ? alignedTrigger.duration_ms : ''
        };
    });
    return systemHealthRowsToCsv(columns, rows);
}

function systemHealthDeviceAnalysisCsv(report, appliancesById) {
    const columns = [
        'appliance_id', 'appliance_name', 'hostname', 'platform', 'license_platform',
        'status_message', 'online', 'metric_eligible', 'data_access', 'license_status',
        'advanced_analysis_capacity', 'total_capacity', 'advanced_capacity_used', 'standard_capacity_used',
        'capacity_source_advanced', 'capacity_source_standard', 'collection_status',
        'advanced_devices', 'standard_devices', 'discovery_devices', 'unrecognized_analysis_devices', 'analysis_total_devices'
    ];
    const ids = new Set([...Object.keys(appliancesById), ...Object.keys(report.device_analysis || {})]);
    const rows = Array.from(ids).sort(systemHealthSortIds).map(id => {
        const appliance = appliancesById[String(id)] || {};
        const analysis = report.device_analysis && report.device_analysis[String(id)] || {};
        const capacity = appliance.capacity || {};
        return {
            appliance_id: id,
            appliance_name: appliance.name || appliance.appliance_name || `Sensor ${id}`,
            hostname: appliance.hostname || '',
            platform: appliance.platform || '',
            license_platform: appliance.license_platform || '',
            status_message: appliance.status_message || '',
            online: appliance.online,
            metric_eligible: appliance.metric_eligible,
            data_access: appliance.data_access,
            license_status: appliance.license_status || '',
            advanced_analysis_capacity: appliance.advanced_analysis_capacity,
            total_capacity: appliance.total_capacity,
            advanced_capacity_used: capacity.advanced_analysis,
            standard_capacity_used: capacity.standard_analysis,
            capacity_source_advanced: capacity.advanced_source,
            capacity_source_standard: capacity.standard_source,
            collection_status: analysis.status || '',
            advanced_devices: analysis.advanced === null || analysis.advanced === undefined ? '' : analysis.advanced,
            standard_devices: analysis.standard === null || analysis.standard === undefined ? '' : analysis.standard,
            discovery_devices: analysis.discovery === null || analysis.discovery === undefined ? '' : analysis.discovery,
            unrecognized_analysis_devices: analysis.unrecognized === null || analysis.unrecognized === undefined ? '' : analysis.unrecognized,
            analysis_total_devices: analysis.total === null || analysis.total === undefined ? '' : analysis.total
        };
    });
    return systemHealthRowsToCsv(columns, rows);
}

function parseSystemHealthCsv(text) {
    const rows = [];
    let row = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (quoted) {
            if (char === '"' && next === '"') {
                value += '"';
                index += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                value += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ',') {
            row.push(value);
            value = '';
        } else if (char === '\n') {
            row.push(value);
            rows.push(row);
            row = [];
            value = '';
        } else if (char !== '\r') {
            value += char;
        }
    }
    if (value || row.length) {
        row.push(value);
        rows.push(row);
    }
    const headers = rows.shift() || [];
    return rows
        .filter(item => item.some(cell => cell !== ''))
        .map(item => Object.fromEntries(headers.map((header, index) => [header, item[index] === undefined ? '' : item[index]])));
}

function systemHealthRowsToCsv(columns, rows) {
    return `${columns.join(',')}\n${rows.map(row => columns.map(column => systemHealthCsvEscape(row[column])).join(',')).join('\n')}\n`;
}

function systemHealthCsvEscape(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadSystemHealthCsv(filename, text) {
    const link = document.createElement('a');
    link.download = filename;
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8;' }));
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function setSystemHealthCsvStatus(message, isError = false) {
    const el = document.getElementById('systemHealthCsvStatus');
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? '#dc2626' : 'var(--text-muted)';
}

function systemHealthCsvKey(row) {
    return [row.appliance_id || '', row.appliance_name || '', row.hostname || ''].map(item => String(item).trim()).join('|');
}

function systemHealthNumber(value) {
    if (value === '' || value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function systemHealthNumberOrString(value) {
    const parsed = systemHealthNumber(value);
    return parsed === null ? value : parsed;
}

function systemHealthSortIds(a, b) {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return String(a).localeCompare(String(b));
}

function setupSystemHealthStylePanel() {
    if (typeof window.initChartThemePanel !== 'function') {
        throw new Error('Chart theme dependency did not expose its panel initializer.');
    }
    window.initChartThemePanel({
        onChange: () => {
            if (systemHealthState.currentReport) renderSystemHealthReport(systemHealthState.currentReport);
        }
    });
}

function systemHealthStyleColors() {
    if (typeof window.chartThemeResolvedColors !== 'function') {
        throw new Error('Chart theme dependency did not expose its resolved palette.');
    }
    return window.chartThemeResolvedColors();
}

// The PDF renderer takes the already-resolved palette rather than a theme name,
// so a saved custom theme needs no duplicate definition on the Python side.
function systemHealthPdfStyle() {
    const { transparent, ...colors } = systemHealthStyleColors();
    return { transparent, colors };
}

function systemHealthChartBackgroundPlugin() {
    return {
        id: 'systemHealthChartBackground',
        beforeDraw(chart) {
            const colors = systemHealthStyleColors();
            if (colors.transparent) return;
            const { ctx, width, height } = chart;
            ctx.save();
            ctx.globalCompositeOperation = 'destination-over';
            ctx.fillStyle = colors.bg;
            ctx.fillRect(0, 0, width, height);
            ctx.restore();
        }
    };
}

function applySystemHealthCanvasStyle(canvas) {
    if (!canvas) return;
    const colors = systemHealthStyleColors();
    canvas.style.backgroundColor = colors.transparent ? 'transparent' : colors.bg;
}

function destroySystemHealthChart(canvasId) {
    if (systemHealthState.charts[canvasId]) {
        systemHealthState.charts[canvasId].destroy();
        delete systemHealthState.charts[canvasId];
    }
}

function systemHealthApplianceName(appliance, fallbackId) {
    if (!appliance) return `Appliance ${fallbackId}`;
    return appliance.display_name || appliance.nickname || appliance.hostname || appliance.uuid || `Appliance ${appliance.id || fallbackId}`;
}

function systemHealthUtilizationColor(ratio) {
    const colors = systemHealthStyleColors();
    if (ratio >= 1) return colors.high;
    if (ratio >= 0.8) return colors.mid;
    return colors.low;
}

function formatSystemHealthNumber(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '';
    return Number(value).toLocaleString();
}

function formatSystemHealthRate(value) {
    if (!value && value !== 0) return '';
    const prefixes = ['', 'K', 'M', 'G'];
    let size = Number(value);
    let prefix = 0;
    while (Math.abs(size) >= 1000 && prefix < prefixes.length - 1) {
        size /= 1000;
        prefix += 1;
    }
    const digits = Math.abs(size) >= 10 || prefix === 0 ? 0 : 1;
    return `${size.toLocaleString(undefined, { maximumFractionDigits: digits })}${prefixes[prefix]} p/s`;
}

function formatSystemHealthGbps(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '';
    return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })} Gbps`;
}

function formatSystemHealthCycles(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '';
    const prefixes = ['', 'K', 'M', 'B', 'T'];
    let size = Number(value);
    let prefix = 0;
    while (Math.abs(size) >= 1000 && prefix < prefixes.length - 1) {
        size /= 1000;
        prefix += 1;
    }
    const digits = Math.abs(size) >= 10 || prefix === 0 ? 0 : 1;
    return `${size.toLocaleString(undefined, { maximumFractionDigits: digits })}${prefixes[prefix]}`;
}

function formatSystemHealthTriggerCapacity(row) {
    const used = Number(row.triggerCyclesPeak || 0);
    const available = Number(row.triggerCyclesAvail || 0);
    if (!available) return used ? formatSystemHealthCycles(used) : '-';
    return `${Math.round((used / available) * 100)}% (${formatSystemHealthCycles(used)} / ${formatSystemHealthCycles(available)})`;
}

function escapeSystemHealthHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

window.initSystemHealthModule = initSystemHealthModule;
window.activateSystemHealthModule = activateSystemHealthModule;
