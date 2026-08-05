/* global ReportCacheValidation */
// Device Discovery Module

const deviceDiscoveryState = {
    selectedPeriod: 'yesterday',
    chartInstance: null,
    appliances: [],
    applianceMap: {},
    includeEfc: false,
    includeDiscovery: false,
    cacheRestoreAttempted: false,
    shouldStop: false,
    abortController: null
};

const DEVICE_ANALYSIS = {
    advanced: { key: 'advanced', label: 'Advanced', color: genericChartPaletteColor(0) },
    standard: { key: 'standard', label: 'Standard', color: stateIndicatorColor('warning') },
    discovery: { key: 'discovery', label: 'Discovery', color: stateIndicatorColor('error') },
    flow_log: { key: 'flow_log', label: 'Flow Log', color: genericChartPaletteColor(1) }
};

const DEVICE_LIMIT = 5000;
const DEVICE_MAX_PAGES = 100;
const DEVICE_MAX_ROWS = 250000;
const DEVICE_DISCOVERY_CACHE_PROJECTION_VERSION = 1;
const DEVICE_DISCOVERY_MAX_CACHE_NODES = 10_000;

function formatDateShort(date) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getPeriodRange(period, nowMs = Date.now()) {
    const now = new Date(nowMs);
    if (!Number.isFinite(now.getTime())) throw new Error('Unable to determine the device activity window');
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);

    if (period === 'yesterday') {
        return {
            label: 'Yesterday',
            activeFrom: yesterdayStart.getTime(),
            activeUntil: todayStart.getTime(),
            displayRange: formatDateShort(yesterdayStart)
        };
    }

    const days = period === 'week' ? 7 : 30;
    const start = new Date(todayStart);
    start.setDate(start.getDate() - days);
    return {
        label: period === 'week' ? 'Last 7 Days' : 'Last 30 Days',
        activeFrom: start.getTime(),
        activeUntil: now.getTime(),
        displayRange: `${formatDateShort(start)} – ${formatDateShort(now)}`
    };
}

function ensureApplianceMap(appliances) {
    if (!appliances || !appliances.length) return {};
    return appliances.reduce((map, appliance) => {
        if (appliance && typeof appliance.id !== 'undefined') {
            map[appliance.id] = appliance;
        }
        return map;
    }, {});
}

function getNodeLabel(nodeId, applianceMap) {
    const appliance = applianceMap[nodeId];
    if (!appliance) {
        return `Node ${nodeId ?? 'Unknown'}`;
    }
    const name = appliance.display_name || appliance.nickname || appliance.hostname || `Node ${appliance.id}`;
    const platform = appliance.license_platform ? ` (${appliance.license_platform})` : '';
    return `${name}${platform}`;
}

function getNodePlatform(nodeId, applianceMap) {
    const appliance = applianceMap[nodeId];
    if (!appliance) return 'Unknown';
    return appliance.license_platform || appliance.platform || 'Unknown';
}

function isEfcNode(nodeId, applianceMap) {
    const appliance = applianceMap[nodeId];
    if (!appliance) return false;
    const platform = appliance.license_platform || appliance.platform || '';
    return platform.startsWith('EFC');
}

async function loadAppliancesForDeviceModule(signal) {
    // Inventory is health and topology data, not static catalog data. Refresh it
    // for every report so reconnects and appliance state changes are visible.
    const appliances = await window.apiClient.getAppliances({ signal });
    deviceDiscoveryState.appliances = appliances;
    deviceDiscoveryState.applianceMap = ensureApplianceMap(appliances);
    return appliances;
}

async function fetchDevicesBatch(range, signal, options = {}) {
    const maxPages = options.maxPages ?? DEVICE_MAX_PAGES;
    const maxRows = options.maxRows ?? DEVICE_MAX_ROWS;
    if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error('Device page budget must be a positive integer');
    if (!Number.isInteger(maxRows) || maxRows < 1) throw new Error('Device row budget must be a positive integer');
    const aggregate = {};
    const perLevelTotals = { advanced: 0, standard: 0, discovery: 0, flow_log: 0 };
    const seenDeviceIds = new Set();
    let offset = 0;
    let totalDevices = 0;
    let pagesFetched = 0;
    let rowsFetched = 0;
    const loadingText = document.getElementById('deviceLoadingText');

    const partial = (reason, detail) => ({
        aggregate,
        perLevelTotals,
        totalDevices,
        pagesFetched,
        rowsFetched,
        incomplete: true,
        reason,
        detail
    });

    while (!deviceDiscoveryState.shouldStop) {
        if (signal?.aborted) {
            return partial('cancelled', 'collection was stopped before every page was retrieved');
        }
        if (pagesFetched >= maxPages) {
            return partial('page_budget', `the ${maxPages.toLocaleString()}-page safety limit was reached`);
        }
        if (rowsFetched >= maxRows) {
            return partial('row_budget', `the ${maxRows.toLocaleString()}-row safety limit was reached`);
        }
        const payload = {
            active_from: range.activeFrom,
            active_until: range.activeUntil,
            limit: DEVICE_LIMIT,
            offset,
            result_fields: ['node_id', 'analysis', 'id']
        };

        const filterRules = [
            {
                field: 'analysis',
                operand: 'l2_exempt',
                operator: '!='
            }
        ];

        if (!deviceDiscoveryState.includeDiscovery) {
            filterRules.push({
                field: 'analysis',
                operand: 'discovery',
                operator: '!='
            });
        }

        payload.filter = {
            operator: 'and',
            rules: filterRules
        };

        let response;
        try {
            response = await window.apiClient.request('/devices/search', {
                method: 'POST',
                body: JSON.stringify(payload),
                signal
            });
        } catch (error) {
            if (deviceDiscoveryState.shouldStop || signal?.aborted) {
                return partial('cancelled', 'collection was stopped before every page was retrieved');
            }
            if (rowsFetched > 0) {
                return partial('failed', `a later page failed after ${rowsFetched.toLocaleString()} rows: ${error.message}`);
            }
            throw error;
        }

        const devices = Array.isArray(response) ? response : (response?.devices || []);
        pagesFetched += 1;

        if (!devices.length) break;

        const remaining = maxRows - rowsFetched;
        const acceptedDevices = devices.slice(0, remaining);
        rowsFetched += acceptedDevices.length;
        acceptedDevices.forEach(device => {
            const deviceId = device?.id;
            if (deviceId !== null && typeof deviceId !== 'undefined') {
                const stableId = String(deviceId);
                if (seenDeviceIds.has(stableId)) return;
                seenDeviceIds.add(stableId);
            }
            const nodeId = device.node_id ?? 'unassigned';
            const analysisKey = device.analysis;
            if (!aggregate[nodeId]) {
                aggregate[nodeId] = { advanced: 0, standard: 0, discovery: 0, flow_log: 0, total: 0 };
            }

            const analysisEntry = DEVICE_ANALYSIS[analysisKey];
            if (analysisEntry) {
                aggregate[nodeId][analysisEntry.key] += 1;
                if (Object.prototype.hasOwnProperty.call(perLevelTotals, analysisEntry.key)) {
                    perLevelTotals[analysisEntry.key] += 1;
                }
            }

            aggregate[nodeId].total += 1;
            totalDevices += 1;
        });

        if (devices.length > remaining) {
            return partial('row_budget', `the ${maxRows.toLocaleString()}-row safety limit was reached`);
        }

        if (loadingText) {
            loadingText.textContent = `Loading devices... (${totalDevices.toLocaleString()} fetched so far)`;
        }

        if (devices.length < DEVICE_LIMIT) {
            break;
        }
        offset += DEVICE_LIMIT;
    }

    if (deviceDiscoveryState.shouldStop) {
        return partial('cancelled', 'collection was stopped before every page was retrieved');
    }

    return {
        aggregate,
        perLevelTotals,
        totalDevices,
        pagesFetched,
        rowsFetched,
        incomplete: false,
        reason: null,
        detail: 'complete'
    };
}

function updateDeviceDiscoveryKpis(totals, options = {}) {
    const { totalDevices, perLevelTotals } = totals;
    const { discoveryIncluded = true } = options;

    document.getElementById('deviceTotalCount').textContent = totalDevices.toLocaleString();
    document.getElementById('deviceAdvancedCount').textContent = perLevelTotals.advanced.toLocaleString();
    document.getElementById('deviceStandardCount').textContent = perLevelTotals.standard.toLocaleString();

    const discoveryElem = document.getElementById('deviceDiscoveryCount');
    if (discoveryIncluded) {
        discoveryElem.textContent = perLevelTotals.discovery.toLocaleString();
    } else {
        discoveryElem.textContent = 'N/A';
    }
}

function renderDeviceDiscoveryChart(sortedNodes) {
    const canvas = document.getElementById('deviceStackedChart');
    const wrapper = document.getElementById('deviceChartWrapper');
    const ctx = canvas.getContext('2d');

    if (deviceDiscoveryState.chartInstance) {
        deviceDiscoveryState.chartInstance.destroy();
    }

    const labels = sortedNodes.map(node => node.label);
    const datasets = Object.values(DEVICE_ANALYSIS).map(analysis => ({
        label: `${analysis.label}`,
        data: sortedNodes.map(node => node.counts[analysis.key]),
        backgroundColor: analysis.color,
        borderWidth: 0,
        borderRadius: 3,
        borderSkipped: false
    }));

    if (wrapper) {
        wrapper.style.height = `${Math.max(420, sortedNodes.length * 28 + 84)}px`;
    }

    deviceDiscoveryState.chartInstance = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' }
            },
            scales: {
                x: {
                    stacked: true,
                    beginAtZero: true,
                    title: { display: true, text: 'Devices' }
                },
                y: {
                    stacked: true,
                    grid: { display: false },
                    ticks: { autoSkip: false }
                }
            }
        }
    });
}

function renderDeviceDiscoveryTable(sortedNodes, applianceMap) {
    const tbody = document.getElementById('deviceDetailsBody');
    const emptyState = document.getElementById('deviceTableEmpty');
    tbody.innerHTML = '';

    if (!sortedNodes.length) {
        emptyState.style.display = 'block';
        return;
    }

    emptyState.style.display = 'none';

    sortedNodes.forEach(node => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(node.label)}</td>
            <td>${escapeHtml(getNodePlatform(node.id, applianceMap))}</td>
            <td>${node.counts.advanced.toLocaleString()}</td>
            <td>${node.counts.standard.toLocaleString()}</td>
            <td>${node.counts.discovery.toLocaleString()}</td>
            <td>${node.counts.flow_log.toLocaleString()}</td>
            <td>${node.counts.total.toLocaleString()}</td>
        `;
        tbody.appendChild(tr);
    });

    const totals = sortedNodes.reduce((acc, node) => {
        acc.advanced += node.counts.advanced;
        acc.standard += node.counts.standard;
        acc.discovery += node.counts.discovery;
        acc.flow_log += node.counts.flow_log;
        acc.total += node.counts.total;
        return acc;
    }, { advanced: 0, standard: 0, discovery: 0, flow_log: 0, total: 0 });

    const totalRow = document.createElement('tr');
    totalRow.style.fontWeight = '600';
    totalRow.innerHTML = `
        <td colspan="2">TOTAL</td>
        <td>${totals.advanced.toLocaleString()}</td>
        <td>${totals.standard.toLocaleString()}</td>
        <td>${totals.discovery.toLocaleString()}</td>
        <td>${totals.flow_log.toLocaleString()}</td>
        <td>${totals.total.toLocaleString()}</td>
    `;
    tbody.appendChild(totalRow);
}

function buildDeviceDiscoveryResult(data, range) {
    const aggregateEntries = Object.entries(data.aggregate || {});
    let filteredEntries = aggregateEntries;
    if (!deviceDiscoveryState.includeEfc) {
        filteredEntries = aggregateEntries.filter(([nodeId]) => !isEfcNode(nodeId, deviceDiscoveryState.applianceMap));
    }
    const sortedNodes = filteredEntries.map(([nodeId, counts]) => ({
        id: nodeId,
        label: getNodeLabel(nodeId, deviceDiscoveryState.applianceMap),
        counts
    })).sort((a, b) => b.counts.total - a.counts.total);

    let totals = data;
    if (!deviceDiscoveryState.includeEfc) {
        const aggregate = {};
        const perLevelTotals = { advanced: 0, standard: 0, discovery: 0, flow_log: 0 };
        let totalDevices = 0;
        sortedNodes.forEach(node => {
            aggregate[node.id] = node.counts;
            perLevelTotals.advanced += node.counts.advanced;
            perLevelTotals.standard += node.counts.standard;
            perLevelTotals.discovery += node.counts.discovery;
            perLevelTotals.flow_log += node.counts.flow_log;
            totalDevices += node.counts.total;
        });
        totals = { aggregate, perLevelTotals, totalDevices };
    }
    return {
        projectionVersion: DEVICE_DISCOVERY_CACHE_PROJECTION_VERSION,
        selectedPeriod: deviceDiscoveryState.selectedPeriod,
        includeEfc: deviceDiscoveryState.includeEfc,
        includeDiscovery: deviceDiscoveryState.includeDiscovery,
        appliances: deviceDiscoveryState.appliances,
        range,
        totals: {
            aggregate: totals.aggregate || {},
            perLevelTotals: totals.perLevelTotals || { advanced: 0, standard: 0, discovery: 0, flow_log: 0 },
            totalDevices: totals.totalDevices || 0
        },
        sortedNodes,
        incomplete: !!data.incomplete,
        detail: data.detail || ''
    };
}

function validateDeviceDiscoveryCounts(counts, label) {
    ReportCacheValidation.requirePlainObject(counts, label);
    const fields = ['advanced', 'standard', 'discovery', 'flow_log', 'total'];
    fields.forEach(field => {
        ReportCacheValidation.requireFiniteNumber(counts[field], `${label}.${field}`, {
            integer: true,
            minimum: 0,
            maximum: DEVICE_MAX_ROWS
        });
    });
    if (counts.total !== counts.advanced + counts.standard + counts.discovery + counts.flow_log) {
        throw new Error(`${label}.total does not match its analysis counts.`);
    }
    return counts;
}

function validateDeviceDiscoveryCachePayload(payload) {
    ReportCacheValidation.validateJsonTree(payload, {
        label: 'Cached Device Discovery report',
        maxDepth: 10,
        maxNodes: 250_000,
        maxArrayLength: DEVICE_DISCOVERY_MAX_CACHE_NODES,
        maxObjectKeys: DEVICE_DISCOVERY_MAX_CACHE_NODES,
        maxStringLength: 4096
    });
    ReportCacheValidation.requirePlainObject(payload, 'Cached Device Discovery report');
    if (payload.projectionVersion !== DEVICE_DISCOVERY_CACHE_PROJECTION_VERSION) {
        throw new Error('Cached Device Discovery report uses an unsupported projection version.');
    }
    if (!['yesterday', 'week', 'month'].includes(payload.selectedPeriod)) {
        throw new Error('Cached Device Discovery report has an invalid period.');
    }
    ReportCacheValidation.requireBoolean(payload.includeEfc, 'Cached Device Discovery includeEfc');
    ReportCacheValidation.requireBoolean(payload.includeDiscovery, 'Cached Device Discovery includeDiscovery');
    ReportCacheValidation.requireBoolean(payload.incomplete, 'Cached Device Discovery incomplete');
    ReportCacheValidation.requireString(payload.detail, 'Cached Device Discovery detail', {
        allowEmpty: true,
        maxLength: 1000
    });

    const range = ReportCacheValidation.requirePlainObject(payload.range, 'Cached Device Discovery range');
    ReportCacheValidation.requireString(range.label, 'Cached Device Discovery range label', { maxLength: 120 });
    ReportCacheValidation.requireString(range.displayRange, 'Cached Device Discovery display range', { maxLength: 240 });
    const activeFrom = ReportCacheValidation.requireFiniteNumber(range.activeFrom, 'Cached Device Discovery range start', {
        integer: true,
        minimum: 0
    });
    const activeUntil = ReportCacheValidation.requireFiniteNumber(range.activeUntil, 'Cached Device Discovery range end', {
        integer: true,
        minimum: 0
    });
    if (activeUntil < activeFrom) throw new Error('Cached Device Discovery range ends before it starts.');

    const appliances = ReportCacheValidation.requireArray(payload.appliances, 'Cached Device Discovery appliances', {
        maxLength: DEVICE_DISCOVERY_MAX_CACHE_NODES
    });
    const applianceIds = new Set();
    appliances.forEach((appliance, index) => {
        const label = `Cached Device Discovery appliance ${index + 1}`;
        ReportCacheValidation.requirePlainObject(appliance, label);
        const applianceId = ReportCacheValidation.requireString(appliance.id, `${label} ID`, { maxLength: 64 });
        if (applianceIds.has(applianceId)) throw new Error(`Cached Device Discovery contains duplicate appliance ID ${applianceId}.`);
        applianceIds.add(applianceId);
        ['display_name', 'nickname', 'hostname', 'license_platform', 'platform'].forEach(field => {
            if (appliance[field] !== null && appliance[field] !== undefined) {
                ReportCacheValidation.requireString(appliance[field], `${label} ${field}`, {
                    allowEmpty: true,
                    maxLength: 500
                });
            }
        });
    });

    const totals = ReportCacheValidation.requirePlainObject(payload.totals, 'Cached Device Discovery totals');
    const perLevel = { ...totals.perLevelTotals, total: totals.totalDevices };
    validateDeviceDiscoveryCounts(perLevel, 'Cached Device Discovery totals');
    const aggregate = ReportCacheValidation.requirePlainObject(totals.aggregate, 'Cached Device Discovery aggregate');
    if (Object.keys(aggregate).length > DEVICE_DISCOVERY_MAX_CACHE_NODES) {
        throw new Error('Cached Device Discovery aggregate exceeds the node limit.');
    }
    const aggregateTotals = { advanced: 0, standard: 0, discovery: 0, flow_log: 0, total: 0 };
    Object.entries(aggregate).forEach(([nodeId, counts]) => {
        ReportCacheValidation.requireString(nodeId, 'Cached Device Discovery aggregate node ID', { maxLength: 64 });
        validateDeviceDiscoveryCounts(counts, `Cached Device Discovery aggregate ${nodeId}`);
        Object.keys(aggregateTotals).forEach(field => {
            aggregateTotals[field] += counts[field];
        });
    });
    Object.keys(aggregateTotals).forEach(field => {
        if (aggregateTotals[field] !== perLevel[field]) {
            throw new Error(`Cached Device Discovery aggregate ${field} does not match its totals.`);
        }
    });

    const sortedNodes = ReportCacheValidation.requireArray(payload.sortedNodes, 'Cached Device Discovery nodes', {
        maxLength: DEVICE_DISCOVERY_MAX_CACHE_NODES
    });
    const sortedNodeIds = new Set();
    sortedNodes.forEach((node, index) => {
        const label = `Cached Device Discovery node ${index + 1}`;
        ReportCacheValidation.requirePlainObject(node, label);
        const nodeId = ReportCacheValidation.requireString(node.id, `${label} ID`, { maxLength: 64 });
        if (sortedNodeIds.has(nodeId)) throw new Error(`Cached Device Discovery contains duplicate node ID ${nodeId}.`);
        sortedNodeIds.add(nodeId);
        ReportCacheValidation.requireString(node.label, `${label} label`, { maxLength: 500 });
        validateDeviceDiscoveryCounts(node.counts, `${label} counts`);
        const aggregateCounts = aggregate[nodeId];
        if (!aggregateCounts || ['advanced', 'standard', 'discovery', 'flow_log', 'total'].some(
            field => aggregateCounts[field] !== node.counts[field]
        )) {
            throw new Error(`${label} does not match the cached aggregate.`);
        }
    });
    if (sortedNodeIds.size !== Object.keys(aggregate).length) {
        throw new Error('Cached Device Discovery node list does not match its aggregate.');
    }
    return payload;
}

function renderDeviceDiscoveryResult(payload, cachedAt = '') {
    if (!payload || !payload.range || !payload.totals || !Array.isArray(payload.sortedNodes)) return false;
    deviceDiscoveryState.selectedPeriod = payload.selectedPeriod || 'yesterday';
    deviceDiscoveryState.includeEfc = payload.includeEfc === true;
    deviceDiscoveryState.includeDiscovery = payload.includeDiscovery === true;
    deviceDiscoveryState.appliances = Array.isArray(payload.appliances) ? payload.appliances : [];
    deviceDiscoveryState.applianceMap = ensureApplianceMap(deviceDiscoveryState.appliances);

    document.querySelectorAll('.device-period-btn').forEach(button => {
        button.classList.toggle('active', button.dataset.period === deviceDiscoveryState.selectedPeriod);
    });
    const includeEfcToggle = document.getElementById('includeEfcToggle');
    const includeDiscoveryToggle = document.getElementById('includeDiscoveryToggle');
    if (includeEfcToggle) includeEfcToggle.checked = deviceDiscoveryState.includeEfc;
    if (includeDiscoveryToggle) includeDiscoveryToggle.checked = deviceDiscoveryState.includeDiscovery;

    const cachedLabel = cachedAt ? ` · Cached ${new Date(cachedAt).toLocaleString()}` : '';
    document.getElementById('deviceReportRange').textContent =
        `${payload.range.label} · ${payload.range.displayRange}${cachedLabel}`;
    const count = payload.sortedNodes.length;
    document.getElementById('deviceNodeCount').textContent = `Nodes represented: ${count}`
        + (payload.incomplete ? ` (partial results - ${payload.detail})` : '');
    document.getElementById('deviceNoDataMessage').style.display = count ? 'none' : 'block';
    updateDeviceDiscoveryKpis(payload.totals, { discoveryIncluded: deviceDiscoveryState.includeDiscovery });
    if (count) renderDeviceDiscoveryChart(payload.sortedNodes);
    renderDeviceDiscoveryTable(payload.sortedNodes, deviceDiscoveryState.applianceMap);
    document.getElementById('deviceDiscoveryLoading').style.display = 'none';
    document.getElementById('deviceDiscoveryResults').style.display = 'flex';
    return true;
}

async function restoreDeviceDiscoveryCache() {
    if (deviceDiscoveryState.cacheRestoreAttempted || !window.state?.connected) return;
    deviceDiscoveryState.cacheRestoreAttempted = true;
    try {
        const cached = await ExtraHopAPI.getReportCache('device-discovery');
        if (cached?.cached) {
            renderDeviceDiscoveryResult(validateDeviceDiscoveryCachePayload(cached.payload), cached.cachedAt);
        }
    } catch (error) {
        console.warn('Could not restore the Device Discovery report cache:', error);
    }
}

async function generateDeviceDiscoveryReport() {
    const loading = document.getElementById('deviceDiscoveryLoading');
    const noData = document.getElementById('deviceNoDataMessage');
    const generateBtn = document.getElementById('generateDeviceReport');
    const stopBtn = document.getElementById('stopDeviceDiscoveryLoad');
    const loadingText = document.getElementById('deviceLoadingText');

    deviceDiscoveryState.shouldStop = false;
    deviceDiscoveryState.abortController?.abort(new DOMException('Superseded by a new report.', 'AbortError'));
    const abortController = new AbortController();
    deviceDiscoveryState.abortController = abortController;

    if (generateBtn) {
        generateBtn.disabled = true;
        generateBtn.style.display = 'none';
    }
    if (stopBtn) {
        stopBtn.style.display = 'inline-block';
    }
    if (loadingText) {
        loadingText.textContent = 'Collecting appliance inventory and device activity...';
    }

    loading.style.display = 'block';
    results.style.display = 'none';
    noData.style.display = 'none';

    let stoppedEarly = false;

    try {
        await loadAppliancesForDeviceModule(abortController.signal);
        const range = getPeriodRange(deviceDiscoveryState.selectedPeriod, Date.now());
        const data = await fetchDevicesBatch(range, abortController.signal);
        stoppedEarly = !!data.incomplete;
        const result = buildDeviceDiscoveryResult(data, range);
        renderDeviceDiscoveryResult(result);
        if (!stoppedEarly) {
            try {
                await ExtraHopAPI.saveReportCache('device-discovery', result);
            } catch (error) {
                console.warn('Could not save the Device Discovery report cache:', error);
                const rangeInfo = document.getElementById('deviceReportRange');
                rangeInfo.textContent += ` · Cache not updated: ${error.message}`;
            }
        }
    } catch (error) {
        if (abortController.signal.aborted) return;
        console.error('Error generating device discovery report', error);
        loading.style.display = 'none';
        alert(`Error generating Device Discovery report: ${error.message}`);
    } finally {
        if (generateBtn) {
            generateBtn.disabled = false;
            generateBtn.style.display = 'block';
        }
        if (stopBtn) {
            stopBtn.style.display = 'none';
        }
        deviceDiscoveryState.shouldStop = false;
        if (deviceDiscoveryState.abortController === abortController) {
            deviceDiscoveryState.abortController = null;
        }
    }
}

function stopDeviceDiscoveryLoad() {
    deviceDiscoveryState.shouldStop = true;
    deviceDiscoveryState.abortController?.abort(new DOMException('Device collection stopped by user.', 'AbortError'));
    const loadingText = document.getElementById('deviceLoadingText');
    if (loadingText) {
        loadingText.textContent = 'Stopping device load...';
    }
}

function setupDeviceDiscoveryEvents() {
    const periodButtons = document.querySelectorAll('.device-period-btn');
    periodButtons.forEach(button => {
        if (button.getAttribute('data-listener-added')) return;
        button.addEventListener('click', () => {
            periodButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            deviceDiscoveryState.selectedPeriod = button.dataset.period;
        });
        button.setAttribute('data-listener-added', 'true');
    });

    const generateBtn = document.getElementById('generateDeviceReport');
    if (generateBtn && !generateBtn.getAttribute('data-listener-added')) {
        generateBtn.addEventListener('click', generateDeviceDiscoveryReport);
        generateBtn.setAttribute('data-listener-added', 'true');
    }

    const includeEfcToggle = document.getElementById('includeEfcToggle');
    if (includeEfcToggle && !includeEfcToggle.getAttribute('data-listener-added')) {
        includeEfcToggle.addEventListener('change', (e) => {
            deviceDiscoveryState.includeEfc = e.target.checked;
        });
        includeEfcToggle.setAttribute('data-listener-added', 'true');
    }

    const includeDiscoveryToggle = document.getElementById('includeDiscoveryToggle');
    if (includeDiscoveryToggle && !includeDiscoveryToggle.getAttribute('data-listener-added')) {
        includeDiscoveryToggle.addEventListener('change', (e) => {
            deviceDiscoveryState.includeDiscovery = e.target.checked;
        });
        includeDiscoveryToggle.setAttribute('data-listener-added', 'true');
    }

    const stopBtn = document.getElementById('stopDeviceDiscoveryLoad');
    if (stopBtn && !stopBtn.getAttribute('data-listener-added')) {
        stopBtn.addEventListener('click', stopDeviceDiscoveryLoad);
        stopBtn.setAttribute('data-listener-added', 'true');
    }
}

function initDeviceDiscoveryModule() {
    setupDeviceDiscoveryEvents();
}

async function activateDeviceDiscoveryModule() {
    await restoreDeviceDiscoveryCache();
}

function cancelDeviceDiscoveryModule() {
    if (deviceDiscoveryState.abortController) stopDeviceDiscoveryLoad();
}

if (typeof featureRegistry !== 'undefined') {
    featureRegistry.register('device-discovery', {
        initialize: initDeviceDiscoveryModule,
        activate: activateDeviceDiscoveryModule,
        cancel: cancelDeviceDiscoveryModule
    });
}
