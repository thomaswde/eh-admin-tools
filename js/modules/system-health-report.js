// System Health Report Module

const SYSTEM_HEALTH_ROWS_PER_PAGE = 22;
const SYSTEM_HEALTH_METRICS = ['bytes', 'pkts', 'trigger_cycles', 'trigger_cycles_avail', 'trigger_drops'];
const SYSTEM_HEALTH_DAY_MS = 24 * 60 * 60 * 1000;
const SYSTEM_HEALTH_DEVICE_LIMIT = 5000;
const SYSTEM_HEALTH_STYLE_STORAGE_KEY = 'ehSystemHealthChartStyle';
const SYSTEM_HEALTH_LEGACY_STYLE_STORAGE_KEY = 'ehReportChartStyle';
const SYSTEM_HEALTH_COLORS = {
    cyan: '#00aaef',
    magenta: '#ec0089',
    tangerine: '#f05918',
    sapphire: '#261f63',
    plum: '#7f2854',
    green: '#16a34a',
    amber: '#f59e0b',
    red: '#dc2626'
};

const systemHealthState = {
    initialized: false,
    catalog: {},
    catalogLoaded: false,
    catalogPath: '',
    catalogError: '',
    catalogModelCount: 0,
    charts: {},
    currentReport: null,
    pages: {
        packetModel: 0,
        packetRow: 0,
        throughputModel: 0,
        throughputRow: 0,
        triggersModel: 0,
        triggersRow: 0,
        analysisModel: 0,
        analysisRow: 0
    },
    style: loadSystemHealthStyle()
};

function defaultSystemHealthStyle() {
    return {
        theme: 'light',
        transparent: false,
        bgHex: '#ffffff',
        textHex: SYSTEM_HEALTH_COLORS.sapphire,
        advHex: SYSTEM_HEALTH_COLORS.cyan,
        stdHex: SYSTEM_HEALTH_COLORS.plum,
        discHex: SYSTEM_HEALTH_COLORS.tangerine
    };
}

function loadSystemHealthStyle() {
    try {
        const params = new URLSearchParams(location.search);
        const styleParam = params.get('systemHealthStyle') || params.get('style');
        if (styleParam) return normalizeSystemHealthStyle(JSON.parse(styleParam));
    } catch {}

    for (const key of [SYSTEM_HEALTH_STYLE_STORAGE_KEY, SYSTEM_HEALTH_LEGACY_STYLE_STORAGE_KEY]) {
        try {
            const raw = localStorage.getItem(key);
            if (raw) return normalizeSystemHealthStyle(JSON.parse(raw));
        } catch {}
    }
    return defaultSystemHealthStyle();
}

function normalizeSystemHealthStyle(raw) {
    const style = { ...defaultSystemHealthStyle(), ...(raw || {}) };
    if (style.theme === 'default') style.theme = 'light';
    if (style.bg === 'transparent') style.transparent = true;
    if (style.bg === 'sapphire') style.theme = 'dark';
    if (style.bg === 'custom') style.theme = 'custom';
    delete style.bg;
    if (raw && raw.lowHex && !raw.advHex) style.advHex = raw.lowHex;
    if (raw && raw.midHex && !raw.stdHex) style.stdHex = raw.midHex;
    if (raw && raw.highHex && !raw.discHex) style.discHex = raw.highHex;
    return style;
}

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
        systemHealthState.catalogModelCount = Object.keys(systemHealthState.catalog).length;
    } catch (error) {
        console.warn('Could not load system health catalog:', error);
        systemHealthState.catalogLoaded = false;
        systemHealthState.catalog = {};
        systemHealthState.catalogError = error.message || 'Catalog could not be loaded.';
        systemHealthState.catalogModelCount = 0;
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
        const modelText = systemHealthState.catalogModelCount === 1 ? '1 model' : `${systemHealthState.catalogModelCount} models`;
        el.className = 'system-health-catalog-status is-loaded';
        el.innerHTML = `
            <span class="system-health-catalog-badge">Catalog loaded</span>
            <span>Capacity comparisons are active using ${escapeSystemHealthHtml(modelText)} from ${escapeSystemHealthHtml(systemHealthState.catalogPath || 'default catalog')}.</span>
        `;
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
    const loading = document.getElementById('systemHealthLoading');
    const results = document.getElementById('systemHealthResults');
    const loadingText = document.getElementById('systemHealthLoadingText');
    const button = document.getElementById('runSystemHealthReport');

    loading.style.display = 'block';
    results.style.display = 'none';
    button.disabled = true;

    try {
        const lookbackDays = Number(document.getElementById('systemHealthLookback').value || 7);
        const cycle = document.getElementById('systemHealthCycle').value || '1hr';

        loadingText.textContent = 'Loading product catalog...';
        await loadSystemHealthCatalog();

        loadingText.textContent = 'Loading appliance inventory...';
        const appliances = normalizeSystemHealthAppliances(await window.apiClient.getAppliances());
        const discoverSensors = appliances.filter(item => String(item.platform || '').toLowerCase() === 'discover');
        const metricSensors = discoverSensors.filter(isSystemHealthMetricSensor);
        const appliancesById = Object.fromEntries(metricSensors.map(item => [String(item.id), item]));

        loadingText.textContent = 'Counting device analysis tiers...';
        const deviceAnalysis = await collectSystemHealthDeviceAnalysis(lookbackDays);

        loadingText.textContent = 'Collecting peak packet, throughput, and trigger metrics...';
        const metricResults = {};
        for (const metricName of SYSTEM_HEALTH_METRICS) {
            metricResults[metricName] = await collectSystemHealthMetric(
                metricSensors,
                appliancesById,
                metricName,
                lookbackDays,
                cycle
            );
        }

        const report = buildSystemHealthReport({
            appliances: discoverSensors,
            deviceAnalysis,
            metricResults,
            lookbackDays,
            cycle
        });

        systemHealthState.currentReport = report;
        resetSystemHealthPages();
        results.style.display = 'block';
        renderSystemHealthReport(report);
        updateSystemHealthCsvButtons();
    } catch (error) {
        showErrorModal(error.message || 'System Health report failed', {
            url: '/backend/extrahop',
            headers: { 'Content-Type': 'application/json' },
            body: 'System Health report collection',
            status: error.status ? String(error.status) : 'Collection Error',
            response: error.details || error.message || 'No additional details'
        });
    } finally {
        loading.style.display = 'none';
        button.disabled = false;
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

async function collectSystemHealthMetric(sensors, appliancesById, metricName, lookbackDays, cycle) {
    if (!sensors.length) {
        return { metric_category_used: 'capture', rows: [], summary: summarizeSystemHealthRows([]), errors: [] };
    }

    const categories = ['capture', 'system.capture'];
    const errors = [];
    let lastEmptyResult = null;

    for (const category of categories) {
        const rows = [];
        for (const sensor of sensors) {
            const sensorId = Number(sensor.id);
            if (!Number.isFinite(sensorId)) continue;
            const body = {
                cycle,
                from: -(lookbackDays * SYSTEM_HEALTH_DAY_MS),
                until: 0,
                object_type: 'system',
                object_ids: [sensorId],
                metric_category: category,
                metric_specs: [{ name: metricName }]
            };
            try {
                const chunks = await collectSystemHealthMetricChunks(body);
                const sensorRows = normalizeSystemHealthMetricRows(chunks, appliancesById, metricName);
                const fallback = await collectSystemHealthMetricFallbackIfEmpty(body, appliancesById, metricName, sensorRows);
                const resultRows = fallback.rows.length ? fallback.rows : sensorRows;
                if (fallback.rows.length) {
                    errors.push(`${metricName} (${category}, ${systemHealthApplianceName(sensor, sensor.id)}): interval metrics were empty; used total-by-object fallback. Rates are averaged across the lookback.`);
                }
                rows.push(...resultRows);
            } catch (error) {
                errors.push(`${metricName} (${category}, ${systemHealthApplianceName(sensor, sensor.id)}): ${error.message}`);
            }
        }

        if (!systemHealthRowsHaveValues(rows)) {
            errors.push(`${metricName} (${category}): response contained no metric values for ${sensors.length} online sensors.`);
            lastEmptyResult = {
                metric_category_used: category,
                rows,
                summary: summarizeSystemHealthRows(rows),
                errors: [...errors]
            };
            continue;
        }

        return {
            metric_category_used: category,
            rows,
            summary: summarizeSystemHealthRows(rows),
            errors
        };
    }

    return lastEmptyResult || { metric_category_used: 'capture', rows: [], summary: summarizeSystemHealthRows([]), errors };
}

async function collectSystemHealthMetricChunks(body) {
    const initial = await window.apiClient.request('/metrics', {
        method: 'POST',
        body: JSON.stringify(body)
    });

    if (!initial || !initial.xid) {
        return initial ? [initial] : [];
    }

    const chunks = [];
    for (let attempts = 0; attempts < 120; attempts += 1) {
        const chunk = await window.apiClient.request(`/metrics/next/${encodeURIComponent(initial.xid)}`);
        if (chunk === null || chunk === undefined) break;
        if (chunk === 'again') {
            await waitSystemHealth(2000);
            continue;
        }
        if (chunk && typeof chunk === 'object' && Object.keys(chunk).length === 0) break;
        if (chunk && typeof chunk === 'object') {
            chunks.push(chunk);
            continue;
        }
        throw new Error(`Unexpected /metrics/next response: ${String(chunk)}`);
    }
    return chunks;
}

async function collectSystemHealthMetricFallbackIfEmpty(body, appliancesById, metricName, rows) {
    if (systemHealthRowsHaveValues(rows)) return { rows: [] };

    const response = await window.apiClient.request('/metrics/totalbyobject', {
        method: 'POST',
        body: JSON.stringify(body)
    });
    const fallbackRows = normalizeSystemHealthMetricRows([response], appliancesById, metricName);
    return { rows: systemHealthRowsHaveValues(fallbackRows) ? fallbackRows : [] };
}

function systemHealthRowsHaveValues(rows) {
    return rows.some(row => typeof row.value === 'number' && Number.isFinite(row.value));
}

function normalizeSystemHealthMetricRows(chunks, appliancesById, metricName) {
    const rows = [];
    chunks.forEach(chunk => {
        const stats = chunk && Array.isArray(chunk.stats) ? chunk.stats : [];
        const chunkNodeId = chunk ? chunk.node_id : undefined;
        stats.forEach(stat => {
            const applianceId = resolveSystemHealthApplianceId(stat.oid, chunkNodeId, appliancesById);
            const appliance = appliancesById[String(applianceId)] || null;
            rows.push({
                appliance_id: applianceId !== null && applianceId !== undefined ? applianceId : stat.oid,
                metric_object_id: stat.oid,
                appliance_name: systemHealthApplianceName(appliance, stat.oid),
                hostname: appliance ? appliance.hostname || '' : '',
                platform: appliance ? appliance.platform || '' : '',
                license_platform: appliance ? appliance.license_platform || '' : '',
                metric: metricName,
                timestamp_ms: stat.time,
                time_iso: systemHealthMsToIso(stat.time),
                duration_ms: stat.duration,
                value: firstSystemHealthValue(stat.values)
            });
        });
    });
    return rows;
}

function resolveSystemHealthApplianceId(metricObjectId, chunkNodeId, appliancesById) {
    if (typeof metricObjectId === 'number') {
        if (appliancesById[String(metricObjectId)]) return metricObjectId;
        const shifted = Math.floor(metricObjectId / 2 ** 32);
        if (appliancesById[String(shifted)]) return shifted;
    }
    if (chunkNodeId !== undefined && appliancesById[String(chunkNodeId)]) return chunkNodeId;
    return null;
}

function firstSystemHealthValue(values) {
    if (!Array.isArray(values) || !values.length) return null;
    return firstSystemHealthNumber(values[0]);
}

function firstSystemHealthNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
        for (const item of value) {
            const nested = firstSystemHealthNumber(item);
            if (nested !== null) return nested;
        }
        return null;
    }
    if (value && typeof value === 'object') {
        if (typeof value.value === 'number' && Number.isFinite(value.value)) return value.value;
        if (typeof value.freq === 'number' && Number.isFinite(value.freq)) return value.freq;
    }
    return null;
}

function systemHealthMsToIso(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return new Date(number).toISOString().replace('.000Z', '+00:00');
}

function summarizeSystemHealthRows(rows) {
    const totals = {};
    const pointCounts = {};
    const latestValues = {};
    const peakValues = {};
    const peakTimes = {};
    const peakDurationMs = {};

    rows.forEach(row => {
        const id = String(row.appliance_id);
        if (typeof row.value === 'number') {
            totals[id] = (totals[id] || 0) + row.value;
            latestValues[id] = row.value;
            if (peakValues[id] === undefined || row.value > peakValues[id]) {
                peakValues[id] = row.value;
                peakTimes[id] = row.timestamp_ms;
                peakDurationMs[id] = row.duration_ms;
            }
        }
        pointCounts[id] = (pointCounts[id] || 0) + 1;
    });

    const avgValues = {};
    Object.keys(totals).forEach(id => {
        if (pointCounts[id]) avgValues[id] = totals[id] / pointCounts[id];
    });

    return { totals, point_counts: pointCounts, avg_values: avgValues, peak_values: peakValues, peak_times: peakTimes, latest_values: latestValues, peak_duration_ms: peakDurationMs };
}

async function collectSystemHealthDeviceAnalysis(lookbackDays) {
    const activeFrom = Date.now() - (lookbackDays * SYSTEM_HEALTH_DAY_MS);
    const aggregate = {};
    let offset = 0;

    while (true) {
        const payload = {
            active_from: activeFrom,
            active_until: 0,
            limit: SYSTEM_HEALTH_DEVICE_LIMIT,
            offset,
            result_fields: ['node_id', 'analysis', 'id'],
            filter: {
                operator: 'and',
                rules: [{ field: 'analysis', operand: 'l2_exempt', operator: '!=' }]
            }
        };

        const response = await window.apiClient.request('/devices/search', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        const devices = Array.isArray(response) ? response : ((response && response.devices) || []);
        if (!devices.length) break;

        devices.forEach(device => {
            if (device.node_id === undefined || device.node_id === null) return;
            const id = String(device.node_id);
            if (!aggregate[id]) aggregate[id] = { advanced: 0, standard: 0, discovery: 0, total: 0 };
            if (['advanced', 'standard', 'discovery'].includes(device.analysis)) {
                aggregate[id][device.analysis] += 1;
            }
            aggregate[id].total += 1;
        });

        if (devices.length < SYSTEM_HEALTH_DEVICE_LIMIT) break;
        offset += SYSTEM_HEALTH_DEVICE_LIMIT;
    }

    return aggregate;
}

function buildSystemHealthReport({ appliances, deviceAnalysis, metricResults, lookbackDays, cycle }) {
    const compactAppliances = appliances.map(item => ({
        id: item.id,
        name: systemHealthApplianceName(item, item.id),
        hostname: item.hostname || '',
        platform: item.platform || '',
        license_platform: item.license_platform || '',
        status_message: item.status_message || '',
        online: isSystemHealthMetricSensor(item),
        capacity: capacityForSystemHealthAppliance(item),
        uuid: item.uuid || '',
        firmware_version: item.firmware_version || ''
    }));

    return {
        generated_at: new Date().toISOString(),
        target: state.apiConfig || {},
        window: { lookback_days: lookbackDays, until: 'now' },
        cycle,
        capacity_catalog_loaded: systemHealthState.catalogLoaded,
        appliances: compactAppliances,
        device_analysis: deviceAnalysis,
        metrics: metricResults,
        errors: Object.values(metricResults).flatMap(result => result.errors || [])
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
    for (const candidate of candidates) {
        const match = systemHealthState.catalog[String(candidate || '').toUpperCase()];
        if (match) return match;
    }
    return null;
}

function normalizeSystemHealthModelName(value) {
    return String(value || '').replace(/_TRACE$/i, '');
}

function systemHealthRows(report) {
    return (report.appliances || []).map(sensor => {
        const capacity = sensor.capacity || {};
        const offline = !sensor.online;
        const packetPeak = metricSystemHealthPeakRate(report, 'pkts', sensor.id);
        const throughputGbps = systemHealthBytesToGbps(report, sensor.id);
        const triggerCyclesPeak = metricSystemHealthPeak(report, 'trigger_cycles', sensor.id);
        const triggerCyclesAvail = metricSystemHealthCapacityValue(report, 'trigger_cycles_avail', sensor.id);
        const triggerDropsPeak = metricSystemHealthPeak(report, 'trigger_drops', sensor.id);
        const triggerDropsTotal = metricSystemHealthTotal(report, 'trigger_drops', sensor.id);
        return {
            ...sensor,
            offline,
            analysis: (report.device_analysis && report.device_analysis[String(sensor.id)]) || { advanced: 0, standard: 0, discovery: 0, total: 0 },
            packetPeak,
            packetCapacity: Number(capacity.base_packetrate || 0),
            throughputGbps,
            throughputCapacity: Number(capacity.base_gbps || 0),
            triggerCyclesPeak,
            triggerCyclesAvail,
            triggerDropsPeak,
            triggerDropsTotal,
            advancedCapacity: Number(capacity.advanced_analysis || 0),
            standardCapacity: Number(capacity.standard_analysis || 0)
        };
    });
}

function metricSystemHealthPeak(report, metricName, id) {
    const metric = report.metrics ? report.metrics[metricName] : null;
    return (metric && metric.summary && metric.summary.peak_values && metric.summary.peak_values[String(id)]) || 0;
}

function metricSystemHealthTotal(report, metricName, id) {
    const metric = report.metrics ? report.metrics[metricName] : null;
    return (metric && metric.summary && metric.summary.totals && metric.summary.totals[String(id)]) || 0;
}

function metricSystemHealthLatest(report, metricName, id) {
    const metric = report.metrics ? report.metrics[metricName] : null;
    return (metric && metric.summary && metric.summary.latest_values && metric.summary.latest_values[String(id)]) || 0;
}

function metricSystemHealthAverage(report, metricName, id) {
    const metric = report.metrics ? report.metrics[metricName] : null;
    return (metric && metric.summary && metric.summary.avg_values && metric.summary.avg_values[String(id)]) || 0;
}

function metricSystemHealthCapacityValue(report, metricName, id) {
    return metricSystemHealthPeak(report, metricName, id)
        || metricSystemHealthLatest(report, metricName, id)
        || metricSystemHealthAverage(report, metricName, id);
}

function metricSystemHealthDuration(report, metricName, id) {
    const metric = report.metrics ? report.metrics[metricName] : null;
    return (metric && metric.summary && metric.summary.peak_duration_ms && metric.summary.peak_duration_ms[String(id)]) || systemHealthCycleToMs(report.cycle);
}

function metricSystemHealthPeakRate(report, metricName, id) {
    const duration = metricSystemHealthDuration(report, metricName, id);
    return duration ? Number(metricSystemHealthPeak(report, metricName, id) || 0) / (duration / 1000) : 0;
}

function systemHealthBytesToGbps(report, id) {
    const duration = metricSystemHealthDuration(report, 'bytes', id);
    return duration ? (Number(metricSystemHealthPeak(report, 'bytes', id) || 0) * 8) / (duration / 1000) / 1_000_000_000 : 0;
}

function systemHealthCycleToMs(cycle) {
    return {
        '1sec': 1000,
        '30sec': 30000,
        '5min': 300000,
        '1hr': 3600000,
        '24hr': 86400000
    }[cycle] || 3600000;
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
    const packetRisk = rows.filter(row => row.packetCapacity && row.packetPeak >= row.packetCapacity).length;
    const throughputWatch = rows.filter(row => row.throughputCapacity && row.throughputGbps / row.throughputCapacity >= 0.8).length;
    const triggerWatch = rows.filter(row => row.triggerCyclesAvail && row.triggerCyclesPeak / row.triggerCyclesAvail >= 0.8).length;
    const triggerDropSensors = rows.filter(row => row.triggerDropsTotal > 0 || row.triggerDropsPeak > 0).length;
    const discoverySensors = rows.filter(row => (row.analysis.discovery || 0) > 0).length;
    const cards = [
        ['Sensors', formatSystemHealthNumber(rows.length), 'Discover sensors returned'],
        ['Lookback', `${report.window.lookback_days} days`, `Cycle ${report.cycle}`],
        ['Packet Risk', formatSystemHealthNumber(packetRisk), 'At or above model packet rating'],
        ['Throughput Watch', formatSystemHealthNumber(throughputWatch), 'At 80%+ model throughput rating'],
        ['Trigger Watch', formatSystemHealthNumber(triggerWatch), 'At 80%+ trigger cycle capacity'],
        ['Trigger Drops', formatSystemHealthNumber(triggerDropSensors), 'Sensors with dropped trigger executions'],
        ['Discovery Overflow', formatSystemHealthNumber(discoverySensors), 'Sensors with Discovery devices']
    ];

    document.getElementById('systemHealthSummary').innerHTML = cards.map(([label, value, note]) => `
        <div class="p-6 rounded-lg text-center" style="background-color: var(--bg-card); border: 2px solid var(--cyan);">
            <div class="text-sm font-medium mb-2" style="color: var(--text-muted);">${label}</div>
            <div class="text-3xl font-bold" style="color: var(--sapphire);">${value}</div>
            <div class="text-xs mt-2" style="color: var(--text-muted);">${note}</div>
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
        alert: row => row.triggerDropsTotal > 0 || row.triggerDropsPeak > 0,
        indicator: row => (row.triggerDropsTotal > 0 || row.triggerDropsPeak > 0) ? 'drops detected' : ''
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
        const totalCapacity = (row.advancedCapacity || 0) + (row.standardCapacity || 0);
        const overPacket = row.packetCapacity > 0 && row.packetPeak >= row.packetCapacity;
        const overThroughput = row.throughputCapacity > 0 && row.throughputGbps >= row.throughputCapacity;
        const overTriggers = row.triggerCyclesAvail > 0 && row.triggerCyclesPeak >= row.triggerCyclesAvail;
        const triggerDropsDetected = row.triggerDropsTotal > 0 || row.triggerDropsPeak > 0;
        const overAdvanced = row.advancedCapacity > 0 && advancedCount > row.advancedCapacity;
        const overStandard = row.standardCapacity > 0 && standardCount > row.standardCapacity;
        const overDiscovery = discoveryCount > 0;
        const rowFlagged = overPacket || overThroughput || overTriggers || triggerDropsDetected || overAdvanced || overStandard || overDiscovery;
        const cellClass = flag => flag ? ' class="system-health-overflow-cell"' : '';

        return `
        <tr class="${rowFlagged ? 'system-health-overflow-row' : ''}">
            <td>${escapeSystemHealthHtml(row.name || row.hostname || row.id)}</td>
            <td>${escapeSystemHealthHtml(row.license_platform || '')}</td>
            <td${cellClass(overPacket)}>${formatSystemHealthRate(row.packetPeak)}</td>
            <td>${formatSystemHealthRate(row.packetCapacity)}</td>
            <td${cellClass(overThroughput)}>${formatSystemHealthGbps(row.throughputGbps)}</td>
            <td>${formatSystemHealthGbps(row.throughputCapacity)}</td>
            <td${cellClass(overTriggers)}>${formatSystemHealthTriggerCapacity(row)}</td>
            <td${cellClass(triggerDropsDetected)}>${formatSystemHealthNumber(row.triggerDropsTotal || row.triggerDropsPeak || 0)}</td>
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
            'Sorted by percent of model capacity'
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
        el.style.background = `linear-gradient(135deg, ${colors.discovery}, ${colors.high})`;
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
        const fillRatio = row.offline ? 0 : utilization === null ? value / maxValue : Math.min(1.1, utilization);
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
        const primaryLabel = row.offline
            ? 'offline'
            : utilization === null
                ? options.formatter(value)
                : `${Math.round(utilization * 100)}%`;
        ctx.fillText(primaryLabel, left + plotWidth + 10, labelY);
        ctx.fillStyle = colors.muted;
        ctx.font = '10px Arial';
        const secondaryLabel = row.offline || utilization === null ? '' : options.formatter(value);
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
    gradient.addColorStop(0, colors.discovery);
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
                capacity: capacityForSystemHealthAppliance(row),
                uuid: '',
                firmware_version: ''
            };
            appliances.set(id, appliance);
        }
    });

    const deviceAnalysis = {};
    csv.deviceSummary.forEach(row => {
        deviceAnalysis[systemHealthCsvKey(row)] = {
            advanced: Number(row.advanced_devices || 0),
            standard: Number(row.standard_devices || 0),
            discovery: Number(row.discovery_devices || 0),
            total: Number(row.analysis_total_devices || 0)
        };
    });

    const cycleInput = document.getElementById('systemHealthCycle');
    const cycle = cycleInput ? cycleInput.value || '1hr' : '1hr';
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
                summary: summarizeSystemHealthSummaryCsv(csv.bytesSummary)
            },
            pkts: {
                metric_category_used: 'csv summary',
                rows: [],
                summary: summarizeSystemHealthSummaryCsv(csv.pktsSummary)
            },
            trigger_cycles: {
                metric_category_used: 'csv summary',
                rows: [],
                summary: summarizeSystemHealthSummaryCsv(csv.triggerCyclesSummary)
            },
            trigger_cycles_avail: {
                metric_category_used: 'csv summary',
                rows: [],
                summary: summarizeSystemHealthSummaryCsv(csv.triggerCyclesAvailSummary)
            },
            trigger_drops: {
                metric_category_used: 'csv summary',
                rows: [],
                summary: summarizeSystemHealthSummaryCsv(csv.triggerDropsSummary)
            }
        },
        errors: []
    };
}

function summarizeSystemHealthSummaryCsv(rows) {
    const summary = { totals: {}, point_counts: {}, avg_values: {}, peak_values: {}, peak_times: {}, latest_values: {}, peak_duration_ms: {} };
    rows.forEach(row => {
        const id = systemHealthCsvKey(row);
        summary.totals[id] = systemHealthNumber(row.total_value) || 0;
        summary.point_counts[id] = systemHealthNumber(row.point_count) || 0;
        summary.avg_values[id] = systemHealthNumber(row.avg_value) || 0;
        summary.peak_values[id] = systemHealthNumber(row.peak_value) || 0;
        summary.latest_values[id] = systemHealthNumber(row.latest_value) || 0;
        summary.peak_duration_ms[id] = systemHealthNumber(row.peak_duration_ms) || null;
        const peakMs = Date.parse(row.peak_time_iso || '');
        if (Number.isFinite(peakMs)) summary.peak_times[id] = peakMs;
    });
    return summary;
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
            body: JSON.stringify({ report, style: systemHealthState.style })
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

function systemHealthPdfFilename(report) {
    const day = String(report.generated_at || new Date().toISOString()).slice(0, 10);
    return `system-health-report-${day}.pdf`;
}

function systemHealthMetricRowsCsv(rows, appliancesById, metricName) {
    const columns = ['appliance_id', 'metric_object_id', 'appliance_name', 'hostname', 'platform', 'license_platform', 'metric', 'timestamp_ms', 'time_iso', 'duration_ms', 'value'];
    const csvRows = rows.map(row => {
        const appliance = appliancesById[String(row.appliance_id)] || {};
        return {
            appliance_id: row.appliance_id,
            metric_object_id: row.metric_object_id || row.appliance_id,
            appliance_name: row.appliance_name || appliance.name || '',
            hostname: row.hostname || appliance.hostname || '',
            platform: row.platform || appliance.platform || '',
            license_platform: row.license_platform || appliance.license_platform || '',
            metric: row.metric || metricName,
            timestamp_ms: row.timestamp_ms || '',
            time_iso: row.time_iso || systemHealthMsToIso(row.timestamp_ms),
            duration_ms: row.duration_ms || '',
            value: row.value === null || row.value === undefined ? '' : row.value
        };
    });
    return systemHealthRowsToCsv(columns, csvRows);
}

function systemHealthSummaryCsv(report, metricName, appliancesById) {
    const columns = ['appliance_id', 'appliance_name', 'hostname', 'platform', 'license_platform', 'point_count', 'total_value', 'avg_value', 'peak_value', 'peak_time_iso', 'peak_duration_ms', 'latest_value'];
    const summary = (report.metrics[metricName] && report.metrics[metricName].summary) || summarizeSystemHealthRows([]);
    const ids = new Set([...Object.keys(appliancesById), ...Object.keys(summary.point_counts || {})]);
    const rows = Array.from(ids).sort(systemHealthSortIds).map(id => {
        const appliance = appliancesById[String(id)] || {};
        return {
            appliance_id: id,
            appliance_name: appliance.name || appliance.appliance_name || `Sensor ${id}`,
            hostname: appliance.hostname || '',
            platform: appliance.platform || '',
            license_platform: appliance.license_platform || '',
            point_count: summary.point_counts && summary.point_counts[id] || 0,
            total_value: summary.totals && summary.totals[id] !== undefined ? summary.totals[id] : '',
            avg_value: summary.avg_values && summary.avg_values[id] !== undefined ? summary.avg_values[id] : '',
            peak_value: summary.peak_values && summary.peak_values[id] !== undefined ? summary.peak_values[id] : '',
            peak_time_iso: systemHealthMsToIso(summary.peak_times && summary.peak_times[id]),
            peak_duration_ms: summary.peak_duration_ms && summary.peak_duration_ms[id] !== undefined ? summary.peak_duration_ms[id] : '',
            latest_value: summary.latest_values && summary.latest_values[id] !== undefined ? summary.latest_values[id] : ''
        };
    });
    return systemHealthRowsToCsv(columns, rows);
}

function systemHealthDeviceAnalysisCsv(report, appliancesById) {
    const columns = ['appliance_id', 'appliance_name', 'hostname', 'platform', 'license_platform', 'advanced_devices', 'standard_devices', 'discovery_devices', 'analysis_total_devices'];
    const ids = new Set([...Object.keys(appliancesById), ...Object.keys(report.device_analysis || {})]);
    const rows = Array.from(ids).sort(systemHealthSortIds).map(id => {
        const appliance = appliancesById[String(id)] || {};
        const analysis = report.device_analysis && report.device_analysis[String(id)] || {};
        return {
            appliance_id: id,
            appliance_name: appliance.name || appliance.appliance_name || `Sensor ${id}`,
            hostname: appliance.hostname || '',
            platform: appliance.platform || '',
            license_platform: appliance.license_platform || '',
            advanced_devices: analysis.advanced || 0,
            standard_devices: analysis.standard || 0,
            discovery_devices: analysis.discovery || 0,
            analysis_total_devices: analysis.total || 0
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
    const panel = document.querySelector('.system-health-style-panel');
    if (!panel) return;
    hydrateSystemHealthStyleInputs(panel);
    refreshSystemHealthStylePanel();
    panel.querySelectorAll('[data-system-health-style-key]').forEach(el => {
        const key = el.dataset.systemHealthStyleKey;
        const update = () => {
            systemHealthState.style[key] = el.type === 'checkbox' ? el.checked : el.value;
            persistSystemHealthStyle();
            refreshSystemHealthStylePanel();
            if (systemHealthState.currentReport) renderSystemHealthReport(systemHealthState.currentReport);
        };
        el.addEventListener('change', update);
        if (el.type === 'color') el.addEventListener('input', update);
    });
    const resetButton = document.getElementById('systemHealthStyleReset');
    if (resetButton) resetButton.addEventListener('click', () => {
        systemHealthState.style = defaultSystemHealthStyle();
        persistSystemHealthStyle();
        hydrateSystemHealthStyleInputs(panel);
        refreshSystemHealthStylePanel();
        if (systemHealthState.currentReport) renderSystemHealthReport(systemHealthState.currentReport);
    });
}

function hydrateSystemHealthStyleInputs(panel) {
    panel.querySelectorAll('[data-system-health-style-key]').forEach(el => {
        const key = el.dataset.systemHealthStyleKey;
        if (!(key in systemHealthState.style)) return;
        if (el.type === 'checkbox') {
            el.checked = !!systemHealthState.style[key];
        } else {
            el.value = systemHealthState.style[key];
        }
    });
}

function refreshSystemHealthStylePanel() {
    document.querySelectorAll('[data-system-health-style-when]').forEach(el => {
        const [key, value] = el.dataset.systemHealthStyleWhen.split('=');
        el.hidden = systemHealthState.style[key] !== value;
    });
    const hint = document.getElementById('systemHealthStyleHint');
    if (hint) {
        const theme = { light: 'Light', dark: 'Dark', mono: 'Monochrome', custom: 'Custom' }[systemHealthState.style.theme] || 'Light';
        const bg = systemHealthState.style.transparent
            ? 'Transparent background'
            : systemHealthState.style.theme === 'dark'
                ? 'Sapphire background'
                : systemHealthState.style.theme === 'custom'
                    ? `Custom ${systemHealthState.style.bgHex}`
                    : 'White background';
        hint.textContent = `${theme} · ${bg}`;
    }
}

function persistSystemHealthStyle() {
    try {
        localStorage.setItem(SYSTEM_HEALTH_STYLE_STORAGE_KEY, JSON.stringify(systemHealthState.style));
    } catch {}
}

function systemHealthStyleColors() {
    const style = systemHealthState.style;
    const presets = {
        light: {
            bg: '#ffffff',
            text: SYSTEM_HEALTH_COLORS.sapphire,
            muted: '#6b7280',
            subtle: '#4b5563',
            grid: '#e5e7eb',
            track: '#eef2f7',
            altRow: '#fafbfc',
            low: '#4aa7df',
            mid: SYSTEM_HEALTH_COLORS.tangerine,
            high: SYSTEM_HEALTH_COLORS.magenta,
            advanced: SYSTEM_HEALTH_COLORS.cyan,
            standard: SYSTEM_HEALTH_COLORS.plum,
            discovery: SYSTEM_HEALTH_COLORS.tangerine
        },
        dark: {
            bg: SYSTEM_HEALTH_COLORS.sapphire,
            text: '#ffffff',
            muted: '#dbe4f0',
            subtle: '#f5f5fb',
            grid: '#64748b',
            track: '#334155',
            altRow: 'rgba(255,255,255,0.05)',
            low: '#4aa7df',
            mid: SYSTEM_HEALTH_COLORS.tangerine,
            high: SYSTEM_HEALTH_COLORS.magenta,
            advanced: SYSTEM_HEALTH_COLORS.cyan,
            standard: SYSTEM_HEALTH_COLORS.plum,
            discovery: SYSTEM_HEALTH_COLORS.tangerine
        },
        mono: {
            bg: '#ffffff',
            text: '#111827',
            muted: '#6b7280',
            subtle: '#4b5563',
            grid: '#d1d5db',
            track: '#e5e7eb',
            altRow: '#f9fafb',
            low: '#9ca3af',
            mid: '#6b7280',
            high: '#111827',
            advanced: '#111827',
            standard: '#6b7280',
            discovery: '#d1d5db'
        },
        custom: {
            bg: style.bgHex,
            text: style.textHex,
            muted: isLightSystemHealthHex(style.bgHex) ? '#6b7280' : '#cbd5e1',
            subtle: isLightSystemHealthHex(style.bgHex) ? '#4b5563' : '#e5e7eb',
            grid: isLightSystemHealthHex(style.bgHex) ? '#d1d5db' : '#64748b',
            track: isLightSystemHealthHex(style.bgHex) ? '#eef2f7' : '#334155',
            altRow: isLightSystemHealthHex(style.bgHex) ? '#fafbfc' : 'rgba(255,255,255,0.05)',
            low: style.advHex,
            mid: style.stdHex,
            high: style.discHex,
            advanced: style.advHex,
            standard: style.stdHex,
            discovery: style.discHex
        }
    };
    const selected = presets[style.theme] || presets.light;
    return { ...selected, transparent: !!style.transparent };
}

function isLightSystemHealthHex(hex) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!match) return true;
    const value = parseInt(match[1], 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 160;
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

function waitSystemHealth(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
