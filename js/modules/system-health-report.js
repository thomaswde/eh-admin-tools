// System Health Report Module

const SYSTEM_HEALTH_ROWS_PER_PAGE = 22;
const SYSTEM_HEALTH_DAY_MS = 24 * 60 * 60 * 1000;
const SYSTEM_HEALTH_DEVICE_LIMIT = 5000;
const SYSTEM_HEALTH_SUMMARY_CSV_SCHEMA_VERSION = '2';
const SYSTEM_HEALTH_SUMMARY_CSV_COLUMNS = [
    'schema_version', 'generated_at', 'report_lookback_days', 'report_from_ms', 'report_until_ms',
    'requested_cycle', 'query_cycle', 'capacity_catalog_loaded', 'report_errors_json',
    'appliance_id', 'appliance_name', 'hostname', 'platform', 'license_platform', 'uuid',
    'appliance_role', 'packetstore_metric_eligible', 'packetstore_metrics_json',
    'status_message', 'online', 'metric_eligible', 'data_access', 'license_status', 'sync_time',
    'firmware_version', 'health_conditions_json',
    'packet_peak_value', 'packet_peak_duration_ms', 'packet_peak_time_ms', 'packet_peak_pps',
    'packet_capacity_pps', 'packet_actual_cycle', 'packet_collection_status',
    'throughput_peak_bytes', 'throughput_peak_duration_ms', 'throughput_peak_time_ms',
    'throughput_peak_gbps', 'throughput_capacity_gbps', 'throughput_actual_cycle',
    'throughput_collection_status',
    'trigger_used_cycles', 'trigger_available_cycles', 'trigger_utilization',
    'trigger_peak_timestamp_ms', 'trigger_peak_duration_ms', 'trigger_actual_cycle',
    'trigger_collection_status', 'trigger_drops_total', 'trigger_drops_aggregation_duration_ms',
    'trigger_drops_collection_status',
    'advanced_devices', 'standard_devices', 'discovery_devices', 'unrecognized_analysis_devices',
    'analysis_total_devices', 'device_analysis_status',
    'packet_capacity_source', 'throughput_capacity_source', 'advanced_capacity',
    'standard_capacity', 'total_analysis_capacity', 'advanced_capacity_source',
    'standard_capacity_source', 'api_advanced_analysis_capacity', 'api_total_capacity'
];
const SYSTEM_HEALTH_DETAIL_CSV_COLUMNS = [
    'Sensor', 'Model', 'Status', 'Packet peak', 'Packet capacity',
    'Throughput peak', 'Throughput capacity', 'Trigger capacity', 'Trigger drops',
    'Advanced', 'Standard', 'Discovery', 'Analysis capacity'
];
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
        analysisRow: 0,
        packetstoreRow: 0
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
        const packetstoreAppliances = appliances.filter(isSystemHealthPacketstoreAppliance);
        const reportAppliances = Array.from(new Map(
            [...discoverSensors, ...packetstoreAppliances].map(item => [String(item.id), item])
        ).values());
        const packetstoreMetricAppliances = packetstoreAppliances.filter(isSystemHealthMetricSensor);
        const appliancesById = Object.fromEntries(reportAppliances.map(item => [String(item.id), item]));
        const cyclePolicy = SystemHealthCollection.chooseCyclePolicy({
            requestedCycle,
            windowMs: untilMs - fromMs,
            sensorCount: reportAppliances.length,
            scalarSeriesCount: (
                metricSensors.length * SystemHealthCollection.TIME_SERIES_METRICS.length
                + packetstoreMetricAppliances.length * SystemHealthCollection.PACKETSTORE_TIME_SERIES_METRICS.length
            )
        });

        loadingText.textContent = 'Collecting device tiers and batched system metrics...';
        const [deviceResult, metricCollection] = await Promise.all([
            collectSystemHealthDeviceAnalysis(fromMs, untilMs, abortController.signal).catch(error => {
                if (abortController.signal.aborted) throw error;
                return {
                    by_sensor: {},
                    warnings: [`Device analysis collection failed without substituting zero values: ${error.message}`],
                    error
                };
            }),
            collectSystemHealthMetrics(metricSensors, discoverSensors, packetstoreMetricAppliances, packetstoreAppliances, appliancesById, {
                fromMs,
                untilMs,
                cycle: cyclePolicy.query_cycle,
                signal: abortController.signal
            })
        ]);
        const { timeSeriesResult, triggerDropResult, packetstoreResult } = metricCollection;
        const metricResults = {
            ...timeSeriesResult.metrics,
            trigger_drops: triggerDropResult
        };

        const report = buildSystemHealthReport({
            appliances: reportAppliances,
            deviceAnalysis: deviceResult.by_sensor,
            metricResults,
            lookbackDays,
            cycle: cyclePolicy.query_cycle,
            requestedCycle,
            cyclePolicy,
            fromMs,
            untilMs,
            triggerUtilization: timeSeriesResult.trigger_utilization,
            packetstore: packetstoreResult,
            deviceAnalysisError: deviceResult.error,
            collectionErrors: [
                ...deviceResult.warnings,
                ...timeSeriesResult.errors,
                ...(triggerDropResult.errors || []),
                ...(packetstoreResult.errors || []),
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

async function collectSystemHealthMetrics(metricSensors, allSensors, packetstoreMetricAppliances, allPacketstoreAppliances, appliancesById, options) {
    // A console can return one XID per query and forward each continuation to
    // attached sensors. Drain one query completely before starting the next so
    // time-series and total polling do not contend for the same remote sensors.
    const timeSeriesResult = await collectSystemHealthTimeSeries(
        metricSensors,
        allSensors,
        appliancesById,
        options
    );
    const triggerDropResult = await collectSystemHealthTriggerDrops(
        metricSensors,
        allSensors,
        appliancesById,
        options
    );
    const packetstoreResult = Array.isArray(packetstoreMetricAppliances) && Array.isArray(allPacketstoreAppliances)
        ? await collectSystemHealthPacketstoreMetrics(
            packetstoreMetricAppliances,
            allPacketstoreAppliances,
            appliancesById,
            options
        )
        : { metric_category_used: 'cpc', appliance_ids: [], metrics: {}, errors: [] };
    return { timeSeriesResult, triggerDropResult, packetstoreResult };
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

function isSystemHealthPacketstoreAppliance(appliance) {
    if (String(appliance && appliance.platform || '').toLowerCase() === 'trace') return true;
    const catalog = capacityForSystemHealthAppliance(appliance || {});
    if (String(catalog.platform || '').toLowerCase() === 'all_in_one') return true;
    const licensedFeatures = appliance && appliance.licensed_features || {};
    const productModules = appliance && appliance.product_modules;
    const moduleValues = [
        ...(Array.isArray(licensedFeatures) ? licensedFeatures : Object.entries(licensedFeatures).flatMap(([key, value]) => [key, value])),
        ...(Array.isArray(productModules) ? productModules : productModules ? String(productModules).split(',') : [])
    ].map(value => String(value).toLowerCase());
    return moduleValues.some(value => /packet[_ -]?forensics|network[_ -]?forensics|packetstore/.test(value));
}

function systemHealthApplianceRole(appliance) {
    if (String(appliance && appliance.platform || '').toLowerCase() === 'trace') return 'packetstore';
    return isSystemHealthPacketstoreAppliance(appliance) ? 'all_in_one' : 'packet_sensor';
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
                rows.map(row => ({ appliance_id: row.appliance_id, value: row.value })),
                { sensorFailures: result.sensor_failures }
            );
            errors.push(...systemHealthCoverageErrors(coverage, metricName));
            metrics[metricName] = {
                metric_category_used: 'capture',
                aggregation_mode: 'time_series',
                rows,
                collection_metadata: normalized.metadata,
                sensor_failures: result.sensor_failures,
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
        const coverage = SystemHealthCollection.buildSensorCoverage(
            allSensors,
            normalized.rows,
            { sensorFailures: result.sensor_failures }
        );
        return {
            metric_category_used: 'capture',
            aggregation_mode: 'total_by_object',
            rows: normalized.rows,
            collection_metadata: normalized.metadata,
            sensor_failures: result.sensor_failures,
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

async function collectSystemHealthPacketstoreMetrics(metricAppliances, allAppliances, appliancesById, options) {
    const timeSeriesNames = SystemHealthCollection.PACKETSTORE_TIME_SERIES_METRICS;
    const totalNames = SystemHealthCollection.PACKETSTORE_TOTAL_METRICS;
    const metrics = {};
    const errors = [];

    const emptyMetric = (name, aggregationMode) => ({
        metric_category_used: 'cpc',
        aggregation_mode: aggregationMode,
        rows: [],
        summary: aggregationMode === 'time_series'
            ? SystemHealthCollection.summarizeTimeSeriesRows([], name)
            : SystemHealthCollection.summarizeAggregateRows([]),
        sensor_status: SystemHealthCollection.buildSensorCoverage(allAppliances, []),
        errors: []
    });
    [...timeSeriesNames, ...totalNames].forEach(name => {
        metrics[name] = emptyMetric(name, timeSeriesNames.includes(name) ? 'time_series' : 'total_by_object');
    });
    if (!metricAppliances.length) return { appliance_ids: allAppliances.map(item => String(item.id)), metrics, errors };

    const request = window.apiClient.request.bind(window.apiClient);
    const decorateRows = rows => rows.map(row => {
        const appliance = appliancesById[String(row.appliance_id)] || {};
        return {
            ...row,
            appliance_name: systemHealthApplianceName(appliance, row.appliance_id),
            hostname: appliance.hostname || '',
            platform: appliance.platform || '',
            license_platform: appliance.license_platform || '',
            time_iso: systemHealthMsToIso(row.timestamp_ms)
        };
    });

    try {
        const body = SystemHealthCollection.buildMetricRequest({
            cycle: options.cycle,
            fromMs: options.fromMs,
            untilMs: options.untilMs,
            objectIds: metricAppliances.map(item => item.id),
            metricNames: timeSeriesNames,
            metricCategory: 'cpc'
        });
        const result = await SystemHealthCollection.collectMetricEndpoint(request, '/metrics', body, { signal: options.signal });
        const normalized = SystemHealthCollection.normalizeTimeSeriesChunks(result.chunks, appliancesById, timeSeriesNames);
        timeSeriesNames.forEach(name => {
            const rows = decorateRows(normalized.rows.map(row => ({ ...row, metric: name, value: row.values[name] })));
            const coverage = SystemHealthCollection.buildSensorCoverage(allAppliances, rows, { sensorFailures: result.sensor_failures });
            metrics[name] = {
                metric_category_used: 'cpc', aggregation_mode: 'time_series', rows,
                collection_metadata: normalized.metadata, sensor_failures: result.sensor_failures,
                summary: SystemHealthCollection.summarizeTimeSeriesRows(normalized.rows, name),
                sensor_status: coverage, errors: []
            };
            errors.push(...systemHealthCoverageErrors(coverage, `Packetstore ${name}`));
        });
    } catch (error) {
        if (options.signal.aborted) throw error;
        const coverage = SystemHealthCollection.buildSensorCoverage(allAppliances, [], { error });
        timeSeriesNames.forEach(name => {
            metrics[name].sensor_status = coverage;
            metrics[name].errors = [error.message];
        });
        errors.push(`Packetstore time-series collection failed without substituting zero values: ${error.message}`);
    }

    try {
        const body = SystemHealthCollection.buildMetricRequest({
            cycle: options.cycle,
            fromMs: options.fromMs,
            untilMs: options.untilMs,
            objectIds: metricAppliances.map(item => item.id),
            metricNames: totalNames,
            metricCategory: 'cpc'
        });
        const result = await SystemHealthCollection.collectMetricEndpoint(request, '/metrics/totalbyobject', body, { signal: options.signal });
        const normalized = SystemHealthCollection.normalizeAggregateChunks(result.chunks, appliancesById, totalNames);
        totalNames.forEach(name => {
            const rows = decorateRows(normalized.rows.filter(row => row.metric === name));
            const coverage = SystemHealthCollection.buildSensorCoverage(allAppliances, rows, { sensorFailures: result.sensor_failures });
            metrics[name] = {
                metric_category_used: 'cpc', aggregation_mode: 'total_by_object', rows,
                collection_metadata: normalized.metadata, sensor_failures: result.sensor_failures,
                summary: SystemHealthCollection.summarizeAggregateRows(rows),
                sensor_status: coverage, errors: []
            };
            errors.push(...systemHealthCoverageErrors(coverage, `Packetstore ${name}`));
        });
    } catch (error) {
        if (options.signal.aborted) throw error;
        const coverage = SystemHealthCollection.buildSensorCoverage(allAppliances, [], { error });
        totalNames.forEach(name => {
            metrics[name].sensor_status = coverage;
            metrics[name].errors = [error.message];
        });
        errors.push(`Packetstore total collection failed without substituting zero values: ${error.message}`);
    }

    return {
        metric_category_used: 'cpc',
        appliance_ids: allAppliances.map(item => String(item.id)),
        metrics,
        errors: Array.from(new Set(errors))
    };
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
    packetstore = null,
    deviceAnalysisError = null,
    collectionErrors = []
}) {
    const compactAppliances = appliances.map(item => {
        const capacity = capacityForSystemHealthAppliance(item);
        const conditions = systemHealthApplianceHealthConditions(item, untilMs);
        const applianceRole = systemHealthApplianceRole(item);
        return {
            id: String(item.id),
            name: systemHealthApplianceName(item, item.id),
            hostname: item.hostname || '',
            platform: item.platform || '',
            license_platform: item.license_platform || '',
            appliance_role: applianceRole,
            status_message: item.status_message || '',
            online: String(item.status_message || '').toLowerCase() === 'online',
            metric_eligible: applianceRole !== 'packetstore' && isSystemHealthMetricSensor(item),
            packetstore_metric_eligible: isSystemHealthPacketstoreAppliance(item) && isSystemHealthMetricSensor(item),
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
        normalizedDeviceAnalysis[String(appliance.id)] = appliance.appliance_role === 'packetstore'
            ? { advanced: null, standard: null, discovery: null, unrecognized: null, total: null, status: 'not_applicable' }
            : returned
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
        source_type: 'api',
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
        packetstore: packetstore || { appliance_ids: [], metrics: {}, errors: [] },
        errors: Array.from(new Set([
            ...collectionErrors,
            ...Object.values(metricResults).flatMap(result => result.errors || []),
            ...((packetstore && packetstore.errors) || []),
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
    return (report.appliances || []).filter(sensor => sensor.appliance_role !== 'packetstore').map(sensor => {
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
            ? (collectionStatus.trigger_cycles || 'complete')
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

function systemHealthPacketstoreMetric(report, metricName) {
    return report.packetstore && report.packetstore.metrics && report.packetstore.metrics[metricName] || null;
}

function systemHealthPacketstoreSummaryValue(report, metricName, field, id) {
    const metric = systemHealthPacketstoreMetric(report, metricName);
    const values = metric && metric.summary && metric.summary[field];
    return values && values[String(id)] !== undefined ? values[String(id)] : null;
}

function systemHealthPacketstoreRows(report) {
    const ids = new Set((report.packetstore && report.packetstore.appliance_ids || []).map(String));
    return (report.appliances || []).filter(appliance => ids.has(String(appliance.id))).map(appliance => {
        const id = String(appliance.id);
        const total = name => systemHealthPacketstoreSummaryValue(report, name, 'totals', id);
        const peak = name => systemHealthPacketstoreSummaryValue(report, name, 'peak_values', id);
        const latest = name => systemHealthPacketstoreSummaryValue(report, name, 'latest_values', id);
        const minimum = name => systemHealthPacketstoreSummaryValue(report, name, 'min_values', id);
        const status = {};
        [...SystemHealthCollection.PACKETSTORE_TIME_SERIES_METRICS, ...SystemHealthCollection.PACKETSTORE_TOTAL_METRICS].forEach(name => {
            const metric = systemHealthPacketstoreMetric(report, name);
            status[name] = metric && metric.sensor_status && metric.sensor_status[id]
                ? metric.sensor_status[id].status : 'unknown';
        });
        const packets = total('pkts');
        const packetDrops = total('pkts_dropped');
        const secrets = total('secrets');
        const secretDrops = total('secrets_dropped');
        return {
            ...appliance,
            offline: !appliance.online,
            collectionStatus: status,
            lookbackLatestSec: latest('est_lookback_sec'),
            lookbackMinSec: minimum('est_lookback_sec'),
            packetsTotal: packets,
            packetDropsTotal: packetDrops,
            slowWriteDropsTotal: total('pkts_dropped_wrslow'),
            interfaceDropsTotal: total('if_drops'),
            packetDropRatio: packets !== null && packets > 0 && packetDrops !== null ? packetDrops / packets : null,
            secretsTotal: secrets,
            secretDropsTotal: secretDrops,
            secretDropRatio: secrets !== null && secrets > 0 && secretDrops !== null ? secretDrops / secrets : null,
            inputLoadPeak: peak('input_load'),
            compressionLoadPeak: peak('compress_load'),
            diskWriteLoadPeak: peak('disk_write_load')
        };
    }).sort((a, b) => {
        const aRisk = Math.max(a.packetDropRatio || 0, a.secretDropRatio || 0, (a.inputLoadPeak || 0) / 100, (a.compressionLoadPeak || 0) / 100, (a.diskWriteLoadPeak || 0) / 100);
        const bRisk = Math.max(b.packetDropRatio || 0, b.secretDropRatio || 0, (b.inputLoadPeak || 0) / 100, (b.compressionLoadPeak || 0) / 100, (b.diskWriteLoadPeak || 0) / 100);
        return bRisk - aRisk || (a.name || '').localeCompare(b.name || '');
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
    const packetstoreRows = systemHealthPacketstoreRows(report);
    renderSystemHealthSummary(report, rows, packetstoreRows);
    renderSystemHealthCharts(rows);
    renderSystemHealthPacketstoreCharts(report, packetstoreRows);
    renderSystemHealthTable(rows);
    renderSystemHealthPacketstoreTable(packetstoreRows);
    renderSystemHealthErrors(systemHealthCollectorNotes(report));
    updateSystemHealthCsvButtons();
}

function renderSystemHealthSummary(report, rows, packetstoreRows = []) {
    const offlineSensors = rows.filter(row => row.offline).length;
    const dataUnavailableSensors = rows.filter(row => row.data_access === false).length;
    const packetRisk = rows.filter(row => row.packetCapacity && row.packetPeak >= row.packetCapacity).length;
    const throughputWatch = rows.filter(row => row.throughputCapacity && row.throughputGbps / row.throughputCapacity >= 0.8).length;
    const triggerWatch = rows.filter(row => row.triggerUtilization !== null && row.triggerUtilization >= 0.8).length;
    const triggerDropSensors = rows.filter(row => row.triggerDropsTotal > 0).length;
    const discoverySensors = rows.filter(row => (row.analysis.discovery || 0) > 0).length;
    const packetstoreLoss = packetstoreRows.filter(row => (row.packetDropsTotal || 0) > 0 || (row.interfaceDropsTotal || 0) > 0 || (row.secretDropsTotal || 0) > 0).length;
    const cards = [
        ['Sensors', formatSystemHealthNumber(rows.length), 'Discover sensors returned'],
        ['Offline', formatSystemHealthNumber(offlineSensors), dataUnavailableSensors ? `${dataUnavailableSensors} also lack data access` : 'Appliance status is not online'],
        ['Lookback', `${report.window.lookback_days} days`, `Peak ${systemHealthReportCycleLabel(report)} averages`],
        ['Packet Risk', formatSystemHealthNumber(packetRisk), `At model rating on peak ${systemHealthReportCycleLabel(report)} average`],
        ['Throughput Watch', formatSystemHealthNumber(throughputWatch), `At 80%+ on peak ${systemHealthReportCycleLabel(report)} average`],
        ['Trigger Watch', formatSystemHealthNumber(triggerWatch), 'At 80%+ trigger cycle capacity'],
        ['Trigger Drops', formatSystemHealthNumber(triggerDropSensors), 'Sensors with dropped trigger executions'],
        ['PCAP Stores', formatSystemHealthNumber(packetstoreRows.length), 'AIO and dedicated Packetstore appliances'],
        ['PCAP Loss', formatSystemHealthNumber(packetstoreLoss), 'Stores with packet, interface, or secret drops'],
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

function renderSystemHealthPacketstoreCharts(report, rows) {
    const cycleLabel = document.getElementById('systemHealthPacketstoreCycleLabel');
    if (cycleLabel) cycleLabel.textContent = `Peak sampled 30-second input, header-compression, and disk-write CPU load at ${systemHealthPacketstoreCycleLabel(report)} cadence. The three loads are separate and are not summed.`;
    drawSystemHealthPacketstoreLookback(document.getElementById('systemHealthPacketstoreLookbackChart'), rows);
    drawSystemHealthPacketstoreFidelity(document.getElementById('systemHealthPacketstoreFidelityChart'), rows);
    drawSystemHealthPacketstoreLoad(document.getElementById('systemHealthPacketstoreLoadChart'), rows);
}

function systemHealthPacketstoreCycleLabel(report) {
    const cycles = new Set();
    Object.values(report.packetstore && report.packetstore.metrics || {}).forEach(metric => {
        Object.values(metric.summary && metric.summary.actual_cycles || {}).forEach(cycle => {
            if (cycle) cycles.add(String(cycle));
        });
        (metric.collection_metadata || []).forEach(metadata => {
            if (metadata && metadata.cycle) cycles.add(String(metadata.cycle));
        });
    });
    return cycles.size ? Array.from(cycles).sort().join('/') : (report.cycle || report.requested_cycle || 'unknown-cycle');
}

function systemHealthPacketstoreMetricAvailable(row, metricName) {
    return ['complete', 'zero_valued'].includes(row.collectionStatus && row.collectionStatus[metricName]);
}

function drawSystemHealthPacketstoreLookback(canvas, rows) {
    const height = 62 + Math.max(1, rows.length) * 30;
    const state = setupSystemHealthCanvas(canvas, height);
    if (!state) return;
    const { ctx, width } = state;
    if (!rows.length) return drawSystemHealthEmpty(ctx, width, height, 'No Packetstore-capable appliances were found');
    const colors = systemHealthStyleColors();
    const left = width < 760 ? 135 : 220;
    const right = 125;
    const plotWidth = Math.max(100, width - left - right);
    const maxDays = Math.max(1, ...rows.map(row => Number(row.lookbackLatestSec || 0) / 86400));
    drawSystemHealthValueGrid(ctx, left, 18, plotWidth, rows.length * 30, maxDays, value => `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}d`);
    rows.forEach((row, index) => {
        const y = 24 + index * 30;
        const latestDays = Number(row.lookbackLatestSec || 0) / 86400;
        const minDays = Number(row.lookbackMinSec || 0) / 86400;
        ctx.fillStyle = colors.subtle; ctx.font = '11px Arial'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(truncateSystemHealthCanvasText(ctx, row.name || row.id, left - 12), left - 8, y + 7);
        ctx.fillStyle = colors.track; ctx.fillRect(left, y, plotWidth, 14);
        if (systemHealthPacketstoreMetricAvailable(row, 'est_lookback_sec')) {
            ctx.fillStyle = colors.low; ctx.fillRect(left, y, plotWidth * Math.min(1, latestDays / maxDays), 14);
            const markerX = left + plotWidth * Math.min(1, minDays / maxDays);
            ctx.fillStyle = colors.high; ctx.fillRect(markerX - 1, y - 2, 3, 18);
            ctx.fillStyle = colors.text; ctx.textAlign = 'left'; ctx.fillText(`${formatSystemHealthDays(latestDays)} latest · ${formatSystemHealthDays(minDays)} min`, left + plotWidth + 8, y + 7);
        } else {
            ctx.fillStyle = colors.muted; ctx.textAlign = 'left'; ctx.fillText((row.collectionStatus.est_lookback_sec || 'unavailable').replace(/_/g, ' '), left + plotWidth + 8, y + 7);
        }
    });
}

function drawSystemHealthPacketstoreFidelity(canvas, rows) {
    const height = 72 + Math.max(1, rows.length) * 42;
    const state = setupSystemHealthCanvas(canvas, height);
    if (!state) return;
    const { ctx, width } = state;
    if (!rows.length) return drawSystemHealthEmpty(ctx, width, height, 'No Packetstore-capable appliances were found');
    const colors = systemHealthStyleColors();
    const left = width < 760 ? 135 : 220;
    const right = 205;
    const plotWidth = Math.max(100, width - left - right);
    const maxRatio = Math.max(0.000001, ...rows.flatMap(row => [row.packetDropRatio || 0, row.secretDropRatio || 0]));
    drawSystemHealthValueGrid(ctx, left, 18, plotWidth, rows.length * 42, maxRatio * 100, value => formatSystemHealthPercent(value / 100));
    rows.forEach((row, index) => {
        const y = 24 + index * 42;
        ctx.fillStyle = colors.subtle; ctx.font = '11px Arial'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(truncateSystemHealthCanvasText(ctx, row.name || row.id, left - 12), left - 8, y + 13);
        [['packetDropRatio', colors.high, 0], ['secretDropRatio', colors.mid, 16]].forEach(([key, color, offset]) => {
            const value = row[key];
            ctx.fillStyle = colors.track; ctx.fillRect(left, y + offset, plotWidth, 10);
            if (value !== null) { ctx.fillStyle = color; ctx.fillRect(left, y + offset, plotWidth * Math.min(1, value / maxRatio), 10); }
        });
        ctx.fillStyle = colors.text; ctx.textAlign = 'left'; ctx.font = '10px Arial';
        ctx.fillText(`packets ${formatSystemHealthPercent(row.packetDropRatio)} · secrets ${formatSystemHealthPercent(row.secretDropRatio)}`, left + plotWidth + 8, y + 7);
        ctx.fillStyle = colors.muted;
        ctx.fillText(`slow-write ${formatSystemHealthNumber(row.slowWriteDropsTotal)} · interface ${formatSystemHealthNumber(row.interfaceDropsTotal)}`, left + plotWidth + 8, y + 23);
    });
}

function drawSystemHealthPacketstoreLoad(canvas, rows) {
    const height = 72 + Math.max(1, rows.length) * 42;
    const state = setupSystemHealthCanvas(canvas, height);
    if (!state) return;
    const { ctx, width } = state;
    if (!rows.length) return drawSystemHealthEmpty(ctx, width, height, 'No Packetstore-capable appliances were found');
    const colors = systemHealthStyleColors();
    const left = width < 760 ? 135 : 220;
    const right = 155;
    const plotWidth = Math.max(100, width - left - right);
    drawSystemHealthPercentGrid(ctx, left, 18, plotWidth, rows.length * 42);
    rows.forEach((row, index) => {
        const y = 24 + index * 42;
        ctx.fillStyle = colors.subtle; ctx.font = '11px Arial'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(truncateSystemHealthCanvasText(ctx, row.name || row.id, left - 12), left - 8, y + 13);
        const loads = [['inputLoadPeak', 'input_load', 0], ['compressionLoadPeak', 'compress_load', 11], ['diskWriteLoadPeak', 'disk_write_load', 22]];
        loads.forEach(([key, metric, offset]) => {
            const value = row[key];
            ctx.fillStyle = colors.track; ctx.fillRect(left, y + offset, plotWidth, 8);
            if (value !== null && systemHealthPacketstoreMetricAvailable(row, metric)) {
                ctx.fillStyle = systemHealthUtilizationColor(Number(value) / 100);
                ctx.fillRect(left, y + offset, plotWidth * Math.min(1, Number(value) / 100), 8);
            }
        });
        ctx.fillStyle = colors.text; ctx.textAlign = 'left'; ctx.font = '10px Arial';
        ctx.fillText(`input ${formatSystemHealthPercentValue(row.inputLoadPeak)} · compress ${formatSystemHealthPercentValue(row.compressionLoadPeak)} · write ${formatSystemHealthPercentValue(row.diskWriteLoadPeak)}`, left + plotWidth + 8, y + 13);
    });
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
    const sorted = sortSystemHealthDetailRows(rows);

    document.getElementById('systemHealthTableBody').innerHTML = sorted.map(row => {
        const advancedCount = row.analysis.advanced || 0;
        const standardCount = row.analysis.standard || 0;
        const discoveryCount = row.analysis.discovery || 0;
        const totalCapacity = systemHealthTotalAnalysisCapacity(row);
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
            <td>${escapeSystemHealthHtml(row.name || row.hostname || row.id)}</td>
            <td>${escapeSystemHealthHtml(row.license_platform || '')}</td>
            <td>${escapeSystemHealthHtml(statusText || 'complete')}</td>
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
    }).join('') || '<tr><td colspan="13">No Discover sensors were returned.</td></tr>';
}

function renderSystemHealthPacketstoreTable(rows) {
    const body = document.getElementById('systemHealthPacketstoreTableBody');
    if (!body) return;
    body.innerHTML = rows.map(row => {
        const dropped = (row.packetDropsTotal || 0) > 0 || (row.interfaceDropsTotal || 0) > 0 || (row.secretDropsTotal || 0) > 0;
        const hot = Math.max(row.inputLoadPeak || 0, row.compressionLoadPeak || 0, row.diskWriteLoadPeak || 0) >= 80;
        return `<tr class="${dropped || hot ? 'system-health-overflow-row' : ''}">
            <td>${escapeSystemHealthHtml(row.name || row.id)}</td>
            <td>${escapeSystemHealthHtml(row.appliance_role === 'all_in_one' ? 'All in One' : 'Packetstore')}</td>
            <td>${escapeSystemHealthHtml(row.license_platform || '')}</td>
            <td>${escapeSystemHealthHtml(systemHealthRowStatusText(row) || 'complete')}</td>
            <td>${formatSystemHealthDays(Number(row.lookbackLatestSec) / 86400)}</td>
            <td>${formatSystemHealthDays(Number(row.lookbackMinSec) / 86400)}</td>
            <td>${formatSystemHealthNumber(row.packetsTotal)}</td>
            <td${dropped ? ' class="system-health-overflow-cell"' : ''}>${formatSystemHealthNumber(row.packetDropsTotal)} (${formatSystemHealthPercent(row.packetDropRatio)})</td>
            <td>${formatSystemHealthNumber(row.slowWriteDropsTotal)}</td>
            <td>${formatSystemHealthNumber(row.interfaceDropsTotal)}</td>
            <td>${formatSystemHealthNumber(row.secretsTotal)}</td>
            <td>${formatSystemHealthNumber(row.secretDropsTotal)} (${formatSystemHealthPercent(row.secretDropRatio)})</td>
            <td>${formatSystemHealthPercentValue(row.inputLoadPeak)}</td>
            <td>${formatSystemHealthPercentValue(row.compressionLoadPeak)}</td>
            <td>${formatSystemHealthPercentValue(row.diskWriteLoadPeak)}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="15">No Packetstore-capable appliances were returned.</td></tr>';
}

function sortSystemHealthDetailRows(rows) {
    return [...rows].sort((a, b) => {
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
}

function systemHealthTotalAnalysisCapacity(row) {
    return row.capacity && row.capacity.total_analysis !== null && row.capacity.total_analysis !== undefined
        ? row.capacity.total_analysis
        : (row.advancedCapacity || 0) + (row.standardCapacity || 0);
}

function systemHealthSensorDetailRows(report) {
    return sortSystemHealthDetailRows(systemHealthRows(report)).map(row => {
        const advancedCount = row.analysis.advanced || 0;
        const standardCount = row.analysis.standard || 0;
        const discoveryCount = row.analysis.discovery || 0;
        return {
            'Sensor': row.name || row.hostname || row.id,
            'Model': row.license_platform || '',
            'Status': systemHealthRowStatusText(row) || 'complete',
            'Packet peak': formatSystemHealthRate(row.packetPeak),
            'Packet capacity': formatSystemHealthRate(row.packetCapacity),
            'Throughput peak': formatSystemHealthGbps(row.throughputGbps),
            'Throughput capacity': formatSystemHealthGbps(row.throughputCapacity),
            'Trigger capacity': formatSystemHealthTriggerCapacity(row),
            'Trigger drops': formatSystemHealthNumber(row.triggerDropsTotal),
            'Advanced': formatSystemHealthTierValue(advancedCount, row.advancedCapacity || 0),
            'Standard': formatSystemHealthTierValue(standardCount, row.standardCapacity || 0),
            'Discovery': formatSystemHealthNumber(discoveryCount),
            'Analysis capacity': formatSystemHealthNumber(systemHealthTotalAnalysisCapacity(row))
        };
    });
}

function systemHealthSensorDetailCsv(report) {
    return systemHealthRowsToCsv(SYSTEM_HEALTH_DETAIL_CSV_COLUMNS, systemHealthSensorDetailRows(report));
}

function renderSystemHealthErrors(errors) {
    const notes = document.getElementById('systemHealthNotes');
    const list = document.getElementById('systemHealthErrorList');
    notes.style.display = errors.length ? 'block' : 'none';
    list.innerHTML = errors.map(error => `<li>${escapeSystemHealthHtml(error)}</li>`).join('');
}

function systemHealthCollectorNotes(report) {
    const errors = Array.from(new Set((report && report.errors) || []));
    const remaining = new Set(errors);
    const appliances = (report && report.appliances) || [];
    const appliancesById = Object.fromEntries(appliances.map(appliance => [String(appliance.id), appliance]));
    const notes = [];
    const coverageGroups = new Map();
    const coveragePattern = /^(.+?) \(([^()]+)\): ([a-z][a-z0-9_]*)(?: - (.*))?$/i;

    errors.forEach(error => {
        const match = coveragePattern.exec(String(error));
        if (!match) return;
        const [, rawMetric, rawId, rawStatus, rawDetail = ''] = match;
        const id = String(rawId);
        const status = rawStatus.toLowerCase();
        const detail = rawDetail.trim();
        const key = `${status}\u0000${detail.toLowerCase()}`;
        if (!coverageGroups.has(key)) {
            coverageGroups.set(key, {
                status,
                detail,
                sensorIds: new Set(),
                metrics: new Set()
            });
        }
        const group = coverageGroups.get(key);
        group.sensorIds.add(id);
        group.metrics.add(systemHealthCollectorMetricLabel(rawMetric));
        remaining.delete(error);
    });

    const coveredConditionKeys = new Set();
    coverageGroups.forEach(group => {
        const sensorIds = Array.from(group.sensorIds).sort(systemHealthSortIds);
        const metricLabels = Array.from(group.metrics).sort((a, b) => {
            const order = ['Packet rate', 'Throughput', 'Trigger cycles', 'Trigger capacity', 'Trigger-drop totals'];
            return order.indexOf(a) - order.indexOf(b) || a.localeCompare(b);
        });
        sensorIds.forEach(id => coveredConditionKeys.add(`${id}\u0000${group.status}\u0000${group.detail.toLowerCase()}`));
        const count = sensorIds.length;
        const checks = systemHealthNaturalList(metricLabels);
        const statusText = group.status === 'offline'
            ? 'Metric collection was unavailable'
            : `${capitalizeSystemHealthKey(group.status.replace(/_/g, ' '))} metric coverage`;
        const detailText = group.detail ? `: ${group.detail}` : '';
        notes.push(`${statusText} for ${count.toLocaleString()} ${count === 1 ? 'sensor' : 'sensors'} across ${checks}${detailText}. Affected: ${systemHealthCollectorSubjectList(sensorIds, appliancesById)}.`);
    });

    const analysisSubjects = [];
    let unrecognizedTotal = 0;
    Object.entries((report && report.device_analysis) || {}).forEach(([id, analysis]) => {
        const count = Number(analysis && analysis.unrecognized || 0);
        if (!count) return;
        unrecognizedTotal += count;
        analysisSubjects.push(`${systemHealthCollectorSubject(id, appliancesById)} (${count.toLocaleString()})`);
    });
    if (analysisSubjects.length) {
        const sensorCount = analysisSubjects.length;
        notes.push(`${unrecognizedTotal.toLocaleString()} ${unrecognizedTotal === 1 ? 'device has' : 'devices have'} unrecognized analysis values across ${sensorCount.toLocaleString()} ${sensorCount === 1 ? 'sensor' : 'sensors'}. Affected: ${systemHealthTruncatedList(analysisSubjects)}.`);
    }
    errors.forEach(error => {
        if (/^Device analysis \([^)]+\): \d+ devices? had unrecognized analysis values\.$/i.test(String(error))) {
            remaining.delete(error);
        }
    });

    const healthGroups = new Map();
    const synchronizationSubjects = [];
    const synchronizationTimes = [];
    appliances.forEach(appliance => {
        const id = String(appliance.id);
        (appliance.health_conditions || []).forEach(condition => {
            const rawError = `${appliance.name}: ${condition.message}`;
            remaining.delete(rawError);
            const detail = String(condition.message || '');
            if (condition.type === 'offline') {
                const statusDetail = detail.replace(/^appliance status is /i, '');
                if (coveredConditionKeys.has(`${id}\u0000offline\u0000${statusDetail.toLowerCase()}`)) return;
            }
            if (condition.type === 'synchronization') {
                synchronizationSubjects.push(systemHealthCollectorSubject(id, appliancesById));
                const timeMatch = /last synchronization was (.+)$/i.exec(detail);
                const timestamp = timeMatch ? Date.parse(timeMatch[1]) : NaN;
                if (Number.isFinite(timestamp)) synchronizationTimes.push(timestamp);
                return;
            }
            const key = `${condition.type || 'health'}\u0000${detail}`;
            if (!healthGroups.has(key)) {
                healthGroups.set(key, {
                    type: condition.type || 'health',
                    detail,
                    sensorIds: []
                });
            }
            healthGroups.get(key).sensorIds.push(id);
        });
    });

    healthGroups.forEach(group => {
        const subjects = Array.from(new Set(group.sensorIds)).sort(systemHealthSortIds);
        const count = subjects.length;
        let message;
        if (group.type === 'license') {
            const status = group.detail.replace(/^license status is /i, '');
            message = `${count.toLocaleString()} ${count === 1 ? 'sensor reports' : 'sensors report'} license status “${status}”`;
        } else if (group.type === 'data_access') {
            message = `${count.toLocaleString()} ${count === 1 ? 'sensor does' : 'sensors do'} not allow metric data access`;
        } else if (group.type === 'offline') {
            const status = group.detail.replace(/^appliance status is /i, '');
            message = `${count.toLocaleString()} ${count === 1 ? 'sensor reports' : 'sensors report'} appliance status “${status}”`;
        } else {
            message = `${count.toLocaleString()} ${count === 1 ? 'sensor reports' : 'sensors report'} ${group.detail}`;
        }
        notes.push(`${message}. Affected: ${systemHealthCollectorSubjectList(subjects, appliancesById)}.`);
    });

    if (synchronizationSubjects.length) {
        const subjects = Array.from(new Set(synchronizationSubjects)).sort();
        const oldest = synchronizationTimes.length
            ? ` Oldest reported synchronization: ${new Date(Math.min(...synchronizationTimes)).toISOString()}.`
            : '';
        notes.push(`${subjects.length.toLocaleString()} ${subjects.length === 1 ? 'sensor has' : 'sensors have'} a stale synchronization timestamp.${oldest} Affected: ${systemHealthTruncatedList(subjects)}.`);
    }

    notes.push(...remaining);
    return Array.from(new Set(notes));
}

function systemHealthCollectorMetricLabel(metric) {
    const labels = {
        bytes: 'Throughput',
        pkts: 'Packet rate',
        trigger_cycles: 'Trigger cycles',
        trigger_cycles_avail: 'Trigger capacity',
        'trigger-drop totals': 'Trigger-drop totals'
    };
    return labels[String(metric).trim()] || String(metric).trim();
}

function systemHealthNaturalList(values) {
    if (!values.length) return 'the collected metrics';
    if (values.length === 1) return values[0];
    if (values.length === 2) return `${values[0]} and ${values[1]}`;
    return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function systemHealthCollectorSubject(id, appliancesById) {
    const appliance = appliancesById[String(id)] || {};
    const name = appliance.name || appliance.hostname || '';
    return name && name !== String(id) ? `${name} (${id})` : String(id);
}

function systemHealthCollectorSubjectList(ids, appliancesById) {
    return systemHealthTruncatedList(ids.map(id => systemHealthCollectorSubject(id, appliancesById)));
}

function systemHealthTruncatedList(values, limit = 8) {
    const shown = values.slice(0, limit);
    const remainder = values.length - shown.length;
    return remainder > 0 ? `${shown.join(', ')}, and ${remainder.toLocaleString()} more` : systemHealthNaturalList(shown);
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
            const totalDevices = systemHealthAnalysisDeviceTotal(row);
            return { ...row, advancedRatio, standardRatio, discoveryOverflow: discovery, totalDevices };
        }).sort((a, b) => b.totalDevices - a.totalDevices || (a.name || '').localeCompare(b.name || ''));
        const discoveryTotal = rowsWithRisk.reduce((sum, row) => sum + (row.analysis.discovery || 0), 0);
        const totalDevices = rowsWithRisk.reduce((sum, row) => sum + row.totalDevices, 0);
        return { model, rows: rowsWithRisk, advancedCapacity, standardCapacity, discoveryTotal, totalDevices };
    });

    pages.sort((a, b) => b.totalDevices - a.totalDevices || b.rows.length - a.rows.length || a.model.localeCompare(b.model));
    return pages;
}

function systemHealthAnalysisDeviceTotal(row) {
    const reported = row.analysis && row.analysis.total;
    if (reported !== null && reported !== undefined && Number.isFinite(Number(reported))) {
        return Number(reported);
    }
    return ['advanced', 'standard', 'discovery', 'unrecognized']
        .reduce((sum, tier) => sum + Number(row.analysis && row.analysis[tier] || 0), 0);
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
            `Std cap ${meta.standardCapacity ? formatSystemHealthNumber(meta.standardCapacity) : '-'}`,
            'Sorted by total devices'
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
    const exportScale = Math.max(1, Number(canvas.dataset.systemHealthExportScale || 1));
    const dpr = (window.devicePixelRatio || 1) * exportScale;
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
        systemHealthAnalysisChart: ['analysis-tier-pressure', 'analysis'],
        systemHealthPacketstoreLookbackChart: ['packetstore-lookback', ''],
        systemHealthPacketstoreFidelityChart: ['packetstore-fidelity', ''],
        systemHealthPacketstoreLoadChart: ['packetstore-load', '']
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
    const model = pages[modelPage] ? pages[modelPage].model : '';
    return model ? `${prefix}-${slugSystemHealthFilename(model)}.png` : `${prefix}.png`;
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
    const tableExportButton = document.getElementById('systemHealthExportTableCsvButton');
    const apiExportButton = document.getElementById('systemHealthExportApiCsvButton');
    const pdfButton = document.getElementById('systemHealthExportPdfButton');
    const pptxButton = document.getElementById('systemHealthExportPptxButton');
    const pptxForm = document.getElementById('systemHealthPptxForm');
    const pptxCancel = document.getElementById('systemHealthPptxCancel');
    const input = document.getElementById('systemHealthCsvInput');
    if (loadButton && input) loadButton.addEventListener('click', () => input.click());
    if (input) input.addEventListener('change', loadSystemHealthCsvFiles);
    if (exportButton) exportButton.addEventListener('click', exportSystemHealthSummaryCsv);
    if (tableExportButton) tableExportButton.addEventListener('click', exportSystemHealthSensorDetailCsv);
    if (apiExportButton) apiExportButton.addEventListener('click', exportSystemHealthApiCsvFiles);
    if (pdfButton) pdfButton.addEventListener('click', exportSystemHealthPdf);
    if (pptxButton) pptxButton.addEventListener('click', openSystemHealthPptxDialog);
    if (pptxForm) pptxForm.addEventListener('submit', exportSystemHealthPptx);
    if (pptxCancel) pptxCancel.addEventListener('click', () => hideModal('systemHealthPptxModal'));
    updateSystemHealthCsvButtons();
}

function updateSystemHealthCsvButtons() {
    const exportButton = document.getElementById('systemHealthExportCsvButton');
    const tableExportButton = document.getElementById('systemHealthExportTableCsvButton');
    const apiExportButton = document.getElementById('systemHealthExportApiCsvButton');
    const pdfButton = document.getElementById('systemHealthExportPdfButton');
    const pptxButton = document.getElementById('systemHealthExportPptxButton');
    if (exportButton) exportButton.disabled = !systemHealthState.currentReport;
    if (tableExportButton) tableExportButton.disabled = !systemHealthState.currentReport;
    if (apiExportButton) {
        const report = systemHealthState.currentReport;
        apiExportButton.disabled = !report || report.source_type !== 'api';
        apiExportButton.title = report && report.source_type !== 'api'
            ? 'Detailed API response rows are not present in a unified summary CSV.'
            : '';
    }
    if (pdfButton) pdfButton.disabled = !systemHealthState.currentReport;
    if (pptxButton) pptxButton.disabled = !systemHealthState.currentReport;
}

async function loadSystemHealthCsvFiles(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;

    try {
        if (files.length !== 1) throw new Error('Select one system health summary CSV.');
        const rows = parseSystemHealthCsv(await files[0].text());
        const report = buildSystemHealthReportFromUnifiedCsv(rows);
        systemHealthState.currentReport = report;
        resetSystemHealthPages();
        document.getElementById('systemHealthResults').style.display = 'block';
        renderSystemHealthReport(report);
        setSystemHealthCsvStatus(`Loaded ${rows.length.toLocaleString()} sensor rows from ${files[0].name}.`);
    } catch (error) {
        setSystemHealthCsvStatus(`CSV load failed: ${error.message}`, true);
    }
}

function buildSystemHealthReportFromUnifiedCsv(rows) {
    if (!Array.isArray(rows) || !rows.length) {
        throw new Error('The unified system health CSV does not contain any sensor rows.');
    }
    const missingColumns = SYSTEM_HEALTH_SUMMARY_CSV_COLUMNS.filter(column => !(column in rows[0]));
    if (missingColumns.length) {
        throw new Error(`This is not a unified system health summary CSV. Missing columns: ${missingColumns.slice(0, 5).join(', ')}${missingColumns.length > 5 ? ', …' : ''}`);
    }
    const versions = new Set(rows.map(row => String(row.schema_version || '')));
    if (versions.size !== 1 || !versions.has(SYSTEM_HEALTH_SUMMARY_CSV_SCHEMA_VERSION)) {
        throw new Error(`Unsupported system health summary CSV schema version: ${Array.from(versions).join(', ') || 'missing'}.`);
    }

    const first = rows[0];
    const reportColumns = [
        'generated_at', 'report_lookback_days', 'report_from_ms', 'report_until_ms',
        'requested_cycle', 'query_cycle', 'capacity_catalog_loaded'
    ];
    rows.slice(1).forEach((row, index) => {
        const changed = reportColumns.find(column => String(row[column] || '') !== String(first[column] || ''));
        if (changed) throw new Error(`Row ${index + 3} has inconsistent ${changed} report metadata.`);
    });
    const appliances = [];
    const deviceAnalysis = {};
    const metrics = {
        bytes: systemHealthEmptyImportedMetric('time_series'),
        pkts: systemHealthEmptyImportedMetric('time_series'),
        trigger_cycles: systemHealthEmptyImportedMetric('time_series'),
        trigger_cycles_avail: systemHealthEmptyImportedMetric('time_series'),
        trigger_drops: systemHealthEmptyImportedMetric('total_by_object')
    };
    const triggerUtilization = {
        aggregation_mode: 'aligned_time_series_ratio',
        zero_available_policy: 'invalid_bucket_excluded',
        peak_by_sensor: {},
        invalid_by_sensor: {}
    };
    const packetstore = { metric_category_used: 'cpc', appliance_ids: [], metrics: {}, errors: [] };
    SystemHealthCollection.PACKETSTORE_TIME_SERIES_METRICS.forEach(name => {
        packetstore.metrics[name] = systemHealthEmptyImportedMetric('time_series');
    });
    SystemHealthCollection.PACKETSTORE_TOTAL_METRICS.forEach(name => {
        packetstore.metrics[name] = systemHealthEmptyImportedMetric('total_by_object');
    });
    const seenIds = new Set();

    rows.forEach((row, index) => {
        const id = String(row.appliance_id || '').trim();
        if (!id) throw new Error(`Row ${index + 2} does not contain an appliance_id.`);
        if (seenIds.has(id)) throw new Error(`The unified summary contains duplicate appliance_id ${id}.`);
        seenIds.add(id);

        const healthConditions = systemHealthJsonArray(row.health_conditions_json, 'health_conditions_json', index);
        const capacity = {
            model: row.license_platform || '',
            base_packetrate: systemHealthNumber(row.packet_capacity_pps) || 0,
            base_gbps: systemHealthNumber(row.throughput_capacity_gbps) || 0,
            advanced_analysis: systemHealthNumber(row.advanced_capacity) || 0,
            standard_analysis: systemHealthNumber(row.standard_capacity) || 0,
            total_analysis: systemHealthNumber(row.total_analysis_capacity),
            advanced_source: row.advanced_capacity_source || '',
            standard_source: row.standard_capacity_source || '',
            capacity_source: {
                packet_rate: row.packet_capacity_source || '',
                throughput: row.throughput_capacity_source || '',
                advanced_analysis: row.advanced_capacity_source || '',
                standard_analysis: row.standard_capacity_source || ''
            },
            api_advanced_analysis_capacity: systemHealthNumber(row.api_advanced_analysis_capacity),
            api_total_capacity: systemHealthNumber(row.api_total_capacity)
        };
        appliances.push({
            id,
            name: row.appliance_name || `Sensor ${id}`,
            hostname: row.hostname || '',
            platform: row.platform || '',
            license_platform: row.license_platform || '',
            uuid: row.uuid || '',
            appliance_role: row.appliance_role || 'packet_sensor',
            packetstore_metric_eligible: systemHealthBoolean(row.packetstore_metric_eligible, false),
            status_message: row.status_message || '',
            online: systemHealthBoolean(row.online, true),
            metric_eligible: systemHealthBoolean(row.metric_eligible, true),
            data_access: systemHealthOptionalBoolean(row.data_access),
            license_status: row.license_status || '',
            sync_time: systemHealthNumberOrString(row.sync_time),
            firmware_version: row.firmware_version || '',
            advanced_analysis_capacity: systemHealthNumber(row.api_advanced_analysis_capacity),
            total_capacity: systemHealthNumber(row.api_total_capacity),
            health_conditions: healthConditions,
            capacity
        });
        const packetstoreSnapshot = systemHealthJsonObject(row.packetstore_metrics_json, 'packetstore_metrics_json', index);
        if (Object.keys(packetstoreSnapshot).length) packetstore.appliance_ids.push(id);
        Object.entries(packetstoreSnapshot).forEach(([name, value]) => {
            const metric = packetstore.metrics[name];
            if (!metric || !value || typeof value !== 'object') return;
            const summary = metric.summary;
            if (metric.aggregation_mode === 'time_series') {
                systemHealthImportPeak(summary, id, value.peak, value.peak_duration_ms, value.peak_time_ms, value.actual_cycle);
                const latest = systemHealthNumber(value.latest);
                const latestTime = systemHealthNumber(value.latest_time_ms);
                const minimum = systemHealthNumber(value.minimum);
                const minimumTime = systemHealthNumber(value.minimum_time_ms);
                if (latest !== null) summary.latest_values[id] = latest;
                if (latestTime !== null) summary.latest_times[id] = latestTime;
                if (minimum !== null) summary.min_values[id] = minimum;
                if (minimumTime !== null) summary.min_times[id] = minimumTime;
            } else {
                systemHealthImportTotal(summary, id, value.total, value.aggregation_duration_ms);
            }
            metric.sensor_status[id] = { status: value.status || 'unknown' };
        });
        deviceAnalysis[id] = {
            advanced: systemHealthNumber(row.advanced_devices),
            standard: systemHealthNumber(row.standard_devices),
            discovery: systemHealthNumber(row.discovery_devices),
            unrecognized: systemHealthNumber(row.unrecognized_analysis_devices),
            total: systemHealthNumber(row.analysis_total_devices),
            status: row.device_analysis_status || 'unknown'
        };

        systemHealthImportPeak(metrics.pkts.summary, id, row.packet_peak_value, row.packet_peak_duration_ms, row.packet_peak_time_ms, row.packet_actual_cycle);
        systemHealthImportPeak(metrics.bytes.summary, id, row.throughput_peak_bytes, row.throughput_peak_duration_ms, row.throughput_peak_time_ms, row.throughput_actual_cycle);
        systemHealthImportPeak(metrics.trigger_cycles.summary, id, row.trigger_used_cycles, row.trigger_peak_duration_ms, row.trigger_peak_timestamp_ms, row.trigger_actual_cycle);
        systemHealthImportPeak(metrics.trigger_cycles_avail.summary, id, row.trigger_available_cycles, row.trigger_peak_duration_ms, row.trigger_peak_timestamp_ms, row.trigger_actual_cycle);
        systemHealthImportTotal(metrics.trigger_drops.summary, id, row.trigger_drops_total, row.trigger_drops_aggregation_duration_ms);

        metrics.pkts.sensor_status[id] = { status: row.packet_collection_status || 'unknown' };
        metrics.bytes.sensor_status[id] = { status: row.throughput_collection_status || 'unknown' };
        metrics.trigger_cycles.sensor_status[id] = { status: row.trigger_collection_status || 'unknown' };
        metrics.trigger_cycles_avail.sensor_status[id] = { status: row.trigger_collection_status || 'unknown' };
        metrics.trigger_drops.sensor_status[id] = { status: row.trigger_drops_collection_status || 'unknown' };

        const triggerUsed = systemHealthNumber(row.trigger_used_cycles);
        const triggerAvailable = systemHealthNumber(row.trigger_available_cycles);
        const triggerRatio = systemHealthNumber(row.trigger_utilization);
        if (triggerUsed !== null && triggerAvailable !== null && triggerAvailable > 0 && triggerRatio !== null) {
            triggerUtilization.peak_by_sensor[id] = {
                used_cycles: triggerUsed,
                available_cycles: triggerAvailable,
                utilization: triggerRatio,
                timestamp_ms: systemHealthNumber(row.trigger_peak_timestamp_ms),
                duration_ms: systemHealthNumber(row.trigger_peak_duration_ms),
                actual_cycle: row.trigger_actual_cycle || row.query_cycle || ''
            };
        } else if (row.trigger_collection_status) {
            triggerUtilization.invalid_by_sensor[id] = row.trigger_collection_status;
        }
    });

    return {
        source_type: 'summary_csv',
        generated_at: first.generated_at || new Date().toISOString(),
        target: { type: 'csv', name: 'unified system health summary CSV' },
        window: {
            lookback_days: systemHealthNumberOrString(first.report_lookback_days),
            from_ms: systemHealthNumber(first.report_from_ms),
            until_ms: systemHealthNumber(first.report_until_ms),
            from_iso: systemHealthMsToIso(first.report_from_ms),
            until_iso: systemHealthMsToIso(first.report_until_ms)
        },
        requested_cycle: first.requested_cycle || first.query_cycle || '',
        cycle: first.query_cycle || first.requested_cycle || '',
        capacity_catalog_loaded: systemHealthBoolean(first.capacity_catalog_loaded, false),
        appliances,
        device_analysis: deviceAnalysis,
        metrics,
        trigger_utilization: triggerUtilization,
        packetstore,
        errors: systemHealthJsonArray(first.report_errors_json, 'report_errors_json', 0)
    };
}

function systemHealthEmptyImportedMetric(aggregationMode) {
    return {
        metric_category_used: 'unified summary CSV',
        aggregation_mode: aggregationMode,
        rows: [],
        summary: {
            aggregation_mode: aggregationMode,
            totals: {},
            point_counts: {},
            avg_values: {},
            peak_values: {},
            peak_times: {},
            latest_values: {},
            latest_times: {},
            min_values: {},
            min_times: {},
            min_duration_ms: {},
            peak_duration_ms: {},
            average_rates: {},
            aggregation_duration_ms: {},
            actual_cycles: {}
        },
        sensor_status: {},
        errors: []
    };
}

function systemHealthJsonObject(value, column, rowIndex) {
    if (!value) return {};
    try {
        const parsed = JSON.parse(value);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('not an object');
        return parsed;
    } catch {
        throw new Error(`Invalid ${column} JSON in row ${rowIndex + 2}.`);
    }
}

function systemHealthImportPeak(summary, id, rawValue, rawDuration, rawTimestamp, actualCycle) {
    const value = systemHealthNumber(rawValue);
    const duration = systemHealthNumber(rawDuration);
    const timestamp = systemHealthNumber(rawTimestamp);
    if (value !== null) summary.peak_values[id] = value;
    if (duration !== null) summary.peak_duration_ms[id] = duration;
    if (timestamp !== null) summary.peak_times[id] = timestamp;
    if (actualCycle) summary.actual_cycles[id] = actualCycle;
}

function systemHealthImportTotal(summary, id, rawValue, rawDuration) {
    const value = systemHealthNumber(rawValue);
    const duration = systemHealthNumber(rawDuration);
    if (value !== null) summary.totals[id] = value;
    if (duration !== null) {
        summary.aggregation_duration_ms[id] = duration;
        if (value !== null && duration > 0) summary.average_rates[id] = value / (duration / 1000);
    }
}

function systemHealthJsonArray(value, column, rowIndex) {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) throw new Error('not an array');
        return parsed;
    } catch {
        throw new Error(`Invalid ${column} JSON in row ${rowIndex + 2}.`);
    }
}

function exportSystemHealthSummaryCsv() {
    const report = systemHealthState.currentReport;
    if (!report) return;
    downloadSystemHealthCsv('system_health_summary.csv', systemHealthUnifiedSummaryCsv(report));
    setSystemHealthCsvStatus('Exported system_health_summary.csv. This single file can rebuild every System Health chart.');
}

function exportSystemHealthSensorDetailCsv() {
    const report = systemHealthState.currentReport;
    if (!report) return;
    downloadSystemHealthCsv('system_health_sensor_detail.csv', systemHealthSensorDetailCsv(report));
    setSystemHealthCsvStatus('Exported system_health_sensor_detail.csv with the Sensor detail table columns and rows.');
}

function systemHealthUnifiedSummaryCsv(report) {
    return systemHealthRowsToCsv(SYSTEM_HEALTH_SUMMARY_CSV_COLUMNS, systemHealthUnifiedSummaryRows(report));
}

function systemHealthUnifiedSummaryRows(report) {
    const sensorById = Object.fromEntries(systemHealthRows(report).map(row => [String(row.id), row]));
    const packetstoreById = Object.fromEntries(systemHealthPacketstoreRows(report).map(row => [String(row.id), row]));
    const rows = (report.appliances || []).map(appliance => ({
        ...appliance,
        ...(sensorById[String(appliance.id)] || {}),
        packetstoreRow: packetstoreById[String(appliance.id)] || null
    }));
    const errorsJson = JSON.stringify(report.errors || []);
    return rows.map((row, index) => {
        const capacity = row.capacity || {};
        const packetSummary = report.metrics && report.metrics.pkts && report.metrics.pkts.summary || {};
        const bytesSummary = report.metrics && report.metrics.bytes && report.metrics.bytes.summary || {};
        const dropsSummary = report.metrics && report.metrics.trigger_drops && report.metrics.trigger_drops.summary || {};
        const id = String(row.id);
        const totalAnalysis = capacity.total_analysis !== null && capacity.total_analysis !== undefined
            ? capacity.total_analysis
            : (row.advancedCapacity || 0) + (row.standardCapacity || 0);
        return {
            schema_version: SYSTEM_HEALTH_SUMMARY_CSV_SCHEMA_VERSION,
            generated_at: report.generated_at || '',
            report_lookback_days: report.window && report.window.lookback_days,
            report_from_ms: report.window && report.window.from_ms,
            report_until_ms: report.window && report.window.until_ms,
            requested_cycle: report.requested_cycle || '',
            query_cycle: report.cycle || '',
            capacity_catalog_loaded: report.capacity_catalog_loaded,
            report_errors_json: index === 0 ? errorsJson : '',
            appliance_id: id,
            appliance_name: row.name || '',
            hostname: row.hostname || '',
            platform: row.platform || '',
            license_platform: row.license_platform || '',
            uuid: row.uuid || '',
            appliance_role: row.appliance_role || 'packet_sensor',
            packetstore_metric_eligible: row.packetstore_metric_eligible,
            packetstore_metrics_json: JSON.stringify(systemHealthPacketstoreMetricSnapshot(report, id)),
            status_message: row.status_message || '',
            online: row.online,
            metric_eligible: row.metric_eligible,
            data_access: row.data_access,
            license_status: row.license_status || '',
            sync_time: row.sync_time,
            firmware_version: row.firmware_version || '',
            health_conditions_json: JSON.stringify(row.health_conditions || []),
            packet_peak_value: systemHealthSummaryValue(packetSummary, 'peak_values', id),
            packet_peak_duration_ms: systemHealthSummaryValue(packetSummary, 'peak_duration_ms', id),
            packet_peak_time_ms: systemHealthSummaryValue(packetSummary, 'peak_times', id),
            packet_peak_pps: row.packetPeak,
            packet_capacity_pps: row.packetCapacity,
            packet_actual_cycle: systemHealthSummaryValue(packetSummary, 'actual_cycles', id),
            packet_collection_status: row.collectionStatus && row.collectionStatus.pkts,
            throughput_peak_bytes: systemHealthSummaryValue(bytesSummary, 'peak_values', id),
            throughput_peak_duration_ms: systemHealthSummaryValue(bytesSummary, 'peak_duration_ms', id),
            throughput_peak_time_ms: systemHealthSummaryValue(bytesSummary, 'peak_times', id),
            throughput_peak_gbps: row.throughputGbps,
            throughput_capacity_gbps: row.throughputCapacity,
            throughput_actual_cycle: systemHealthSummaryValue(bytesSummary, 'actual_cycles', id),
            throughput_collection_status: row.collectionStatus && row.collectionStatus.bytes,
            trigger_used_cycles: row.triggerCyclesPeak,
            trigger_available_cycles: row.triggerCyclesAvail,
            trigger_utilization: row.triggerUtilization,
            trigger_peak_timestamp_ms: row.triggerPeakTimestampMs,
            trigger_peak_duration_ms: row.triggerPeakDurationMs,
            trigger_actual_cycle: report.trigger_utilization
                && report.trigger_utilization.peak_by_sensor
                && report.trigger_utilization.peak_by_sensor[id]
                && report.trigger_utilization.peak_by_sensor[id].actual_cycle || '',
            trigger_collection_status: row.collectionStatus && row.collectionStatus.trigger_utilization,
            trigger_drops_total: row.triggerDropsTotal,
            trigger_drops_aggregation_duration_ms: systemHealthSummaryValue(dropsSummary, 'aggregation_duration_ms', id),
            trigger_drops_collection_status: row.collectionStatus && row.collectionStatus.trigger_drops,
            advanced_devices: row.analysis && row.analysis.advanced,
            standard_devices: row.analysis && row.analysis.standard,
            discovery_devices: row.analysis && row.analysis.discovery,
            unrecognized_analysis_devices: row.analysis && row.analysis.unrecognized,
            analysis_total_devices: row.analysis && row.analysis.total,
            device_analysis_status: row.collectionStatus && row.collectionStatus.device_analysis,
            packet_capacity_source: capacity.capacity_source && capacity.capacity_source.packet_rate,
            throughput_capacity_source: capacity.capacity_source && capacity.capacity_source.throughput,
            advanced_capacity: row.advancedCapacity,
            standard_capacity: row.standardCapacity,
            total_analysis_capacity: totalAnalysis,
            advanced_capacity_source: capacity.advanced_source
                || capacity.capacity_source && capacity.capacity_source.advanced_analysis,
            standard_capacity_source: capacity.standard_source
                || capacity.capacity_source && capacity.capacity_source.standard_analysis,
            api_advanced_analysis_capacity: row.advanced_analysis_capacity,
            api_total_capacity: row.total_capacity
        };
    });
}

function systemHealthPacketstoreMetricSnapshot(report, id) {
    if (!(report.packetstore && (report.packetstore.appliance_ids || []).map(String).includes(String(id)))) return {};
    const snapshot = {};
    [...SystemHealthCollection.PACKETSTORE_TIME_SERIES_METRICS, ...SystemHealthCollection.PACKETSTORE_TOTAL_METRICS].forEach(name => {
        const metric = systemHealthPacketstoreMetric(report, name);
        const summary = metric && metric.summary || {};
        const status = metric && metric.sensor_status && metric.sensor_status[String(id)];
        snapshot[name] = {
            aggregation_mode: metric && metric.aggregation_mode || '',
            status: status && status.status || 'unknown',
            total: systemHealthSummaryValue(summary, 'totals', String(id)),
            aggregation_duration_ms: systemHealthSummaryValue(summary, 'aggregation_duration_ms', String(id)),
            peak: systemHealthSummaryValue(summary, 'peak_values', String(id)),
            peak_time_ms: systemHealthSummaryValue(summary, 'peak_times', String(id)),
            peak_duration_ms: systemHealthSummaryValue(summary, 'peak_duration_ms', String(id)),
            latest: systemHealthSummaryValue(summary, 'latest_values', String(id)),
            latest_time_ms: systemHealthSummaryValue(summary, 'latest_times', String(id)),
            minimum: systemHealthSummaryValue(summary, 'min_values', String(id)),
            minimum_time_ms: systemHealthSummaryValue(summary, 'min_times', String(id)),
            actual_cycle: systemHealthSummaryValue(summary, 'actual_cycles', String(id))
        };
    });
    return snapshot;
}

function systemHealthSummaryValue(summary, key, id) {
    const values = summary && summary[key];
    return values && values[id] !== undefined ? values[id] : '';
}

function exportSystemHealthApiCsvFiles() {
    const report = systemHealthState.currentReport;
    if (!report || report.source_type !== 'api') return;
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
    [...SystemHealthCollection.PACKETSTORE_TIME_SERIES_METRICS, ...SystemHealthCollection.PACKETSTORE_TOTAL_METRICS].forEach(metricName => {
        const metric = systemHealthPacketstoreMetric(report, metricName) || { rows: [] };
        downloadSystemHealthCsv(`packetstore_${metricName}.csv`, systemHealthMetricRowsCsv(metric.rows || [], appliancesById, metricName));
        downloadSystemHealthCsv(`packetstore_${metricName}_summary.csv`, systemHealthSummaryCsv(report, metricName, appliancesById));
    });
    downloadSystemHealthCsv('device_analysis_summary.csv', systemHealthDeviceAnalysisCsv(report, appliancesById));
    setSystemHealthCsvStatus('Exported all available System Health API response data and per-metric summaries as CSV files.');
}

function openSystemHealthPptxDialog() {
    if (!systemHealthState.currentReport) return;
    showModal('systemHealthPptxModal');
    setTimeout(() => document.getElementById('systemHealthPptxTitle')?.focus(), 0);
}

function systemHealthPptxOptionsFromForm() {
    return {
        title: document.getElementById('systemHealthPptxTitle')?.value || '',
        customer: document.getElementById('systemHealthPptxCustomer')?.value || '',
        prepared_by: document.getElementById('systemHealthPptxPreparedBy')?.value || '',
        window_label: document.getElementById('systemHealthPptxWindow')?.value || '',
        context: document.getElementById('systemHealthPptxContext')?.value || ''
    };
}

function systemHealthPptxTargetLabel(report) {
    const target = report && report.target || {};
    if (target.type === 'csv') return '';
    if (target.tenant) return String(target.tenant);
    if (target.host) return String(target.host);
    if (target.name && target.name !== 'unified system health summary CSV') return String(target.name);
    return '';
}

function systemHealthPptxMeta(report) {
    return {
        generated_at: report.generated_at || '',
        lookback_days: report.window && report.window.lookback_days,
        from_ms: report.window && report.window.from_ms,
        until_ms: report.window && report.window.until_ms,
        cycle_label: systemHealthReportCycleLabel(report),
        target_label: systemHealthPptxTargetLabel(report),
        source_type: report.source_type || ''
    };
}

async function exportSystemHealthPptx(event) {
    if (event) event.preventDefault();
    const report = systemHealthState.currentReport;
    if (!report) return;
    if (!window.SystemHealthPptx || typeof window.SystemHealthPptx.exportDeck !== 'function') {
        setSystemHealthCsvStatus('PowerPoint export module did not load.', true);
        return;
    }

    const confirmButton = document.getElementById('systemHealthPptxConfirm');
    const exportButton = document.getElementById('systemHealthExportPptxButton');
    const originalConfirmText = confirmButton ? confirmButton.textContent : '';
    if (confirmButton) {
        confirmButton.disabled = true;
        confirmButton.textContent = 'Building presentation…';
    }
    if (exportButton) exportButton.disabled = true;
    hideModal('systemHealthPptxModal');
    setSystemHealthCsvStatus('Building editable PowerPoint slides…');

    try {
        const result = await window.SystemHealthPptx.exportDeck({
            meta: systemHealthPptxMeta(report),
            options: systemHealthPptxOptionsFromForm(),
            rows: systemHealthRows(report),
            packetstore_rows: systemHealthPacketstoreRows(report),
            palette: systemHealthStyleColors(),
            collector_notes: systemHealthCollectorNotes(report)
        });
        setSystemHealthCsvStatus(`Exported ${result.filename}. Charts are drawn as native shapes, so every slide stays editable.`);
    } catch (error) {
        console.error('System Health PowerPoint export failed:', error);
        setSystemHealthCsvStatus(error.message || 'PowerPoint export failed.', true);
    } finally {
        if (confirmButton) {
            confirmButton.disabled = false;
            confirmButton.textContent = originalConfirmText || 'Export PowerPoint';
        }
        if (exportButton) exportButton.disabled = !systemHealthState.currentReport;
    }
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
        ])),
        packetstore: report.packetstore ? {
            ...report.packetstore,
            metrics: Object.fromEntries(Object.entries(report.packetstore.metrics || {}).map(([name, metric]) => [
                name,
                { ...metric, rows: [] }
            ]))
        } : { appliance_ids: [], metrics: {}, errors: [] }
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
        const currentReport = systemHealthState.currentReport || {};
        const metric = (currentReport.metrics || {})[metricName]
            || (currentReport.packetstore && currentReport.packetstore.metrics || {})[metricName] || {};
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
    const metric = (report.metrics && report.metrics[metricName])
        || (report.packetstore && report.packetstore.metrics && report.packetstore.metrics[metricName]) || {};
    const summary = metric.summary || summarizeSystemHealthRows([]);
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

function systemHealthNumber(value) {
    if (value === '' || value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function systemHealthNumberOrString(value) {
    const parsed = systemHealthNumber(value);
    return parsed === null ? value : parsed;
}

function systemHealthBoolean(value, fallback = false) {
    if (value === '' || value === null || value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return fallback;
}

function systemHealthOptionalBoolean(value) {
    if (value === '' || value === null || value === undefined) return undefined;
    return systemHealthBoolean(value);
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

function formatSystemHealthPercent(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
    const percent = Number(value) * 100;
    const digits = percent > 0 && percent < 0.01 ? 4 : percent < 1 ? 2 : 1;
    return `${percent.toLocaleString(undefined, { maximumFractionDigits: digits })}%`;
}

function formatSystemHealthPercentValue(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
    return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function formatSystemHealthDays(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
    return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}d`;
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
