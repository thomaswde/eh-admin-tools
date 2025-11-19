// Device Discovery Module

const deviceDiscoveryState = {
    selectedPeriod: 'yesterday',
    chartInstance: null,
    appliances: [],
    applianceMap: {},
    includeEfc: false
};

const DEVICE_ANALYSIS = {
    1: { key: 'advanced', label: 'Advanced', color: '#ec0089' },
    2: { key: 'standard', label: 'Standard', color: '#261f63' },
    3: { key: 'discovery', label: 'Discovery', color: '#f05918' }
};

const DEVICE_LIMIT = 1000;

function formatDateShort(date) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getPeriodRange(period) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const yesterdayEnd = new Date(todayStart.getTime() - 1);

    if (period === 'yesterday') {
        return {
            label: 'Yesterday',
            activeFrom: yesterdayStart.getTime(),
            activeUntil: yesterdayEnd.getTime(),
            displayRange: formatDateShort(yesterdayStart)
        };
    }

    const days = period === 'week' ? 7 : 30;
    const start = new Date(todayStart);
    start.setDate(start.getDate() - days);
    return {
        label: period === 'week' ? 'Last 7 Days' : 'Last 30 Days',
        activeFrom: start.getTime(),
        activeUntil: 0,
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

async function loadAppliancesForDeviceModule() {
    if (deviceDiscoveryState.appliances.length) {
        return deviceDiscoveryState.appliances;
    }
    const appliances = await window.apiClient.getAppliances();
    deviceDiscoveryState.appliances = appliances;
    deviceDiscoveryState.applianceMap = ensureApplianceMap(appliances);
    return appliances;
}

async function fetchDevicesBatch(range) {
    const aggregate = {};
    const perLevelTotals = { advanced: 0, standard: 0, discovery: 0 };
    let offset = 0;
    let totalDevices = 0;

    while (true) {
        const payload = {
            active_from: range.activeFrom,
            active_until: range.activeUntil,
            limit: DEVICE_LIMIT,
            offset,
            result_fields: ['node_id', 'analysis_level', 'id']
        };

        const response = await window.apiClient.request('/devices/search', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        const devices = Array.isArray(response) ? response : (response?.devices || []);

        if (!devices.length) break;

        devices.forEach(device => {
            const nodeId = device.node_id ?? 'unassigned';
            const analysisEntry = DEVICE_ANALYSIS[device.analysis_level];
            if (!aggregate[nodeId]) {
                aggregate[nodeId] = { advanced: 0, standard: 0, discovery: 0, total: 0 };
            }

            if (analysisEntry) {
                aggregate[nodeId][analysisEntry.key] += 1;
                perLevelTotals[analysisEntry.key] += 1;
            }

            aggregate[nodeId].total += 1;
            totalDevices += 1;
        });

        if (devices.length < DEVICE_LIMIT) {
            break;
        }
        offset += DEVICE_LIMIT;
    }

    return { aggregate, perLevelTotals, totalDevices };
}

function updateDeviceDiscoveryKpis(totals) {
    const { totalDevices, perLevelTotals } = totals;
    document.getElementById('deviceTotalCount').textContent = totalDevices.toLocaleString();
    document.getElementById('deviceAdvancedCount').textContent = perLevelTotals.advanced.toLocaleString();
    document.getElementById('deviceStandardCount').textContent = perLevelTotals.standard.toLocaleString();
    document.getElementById('deviceDiscoveryCount').textContent = perLevelTotals.discovery.toLocaleString();
}

function renderDeviceDiscoveryChart(sortedNodes) {
    const canvas = document.getElementById('deviceStackedChart');
    const ctx = canvas.getContext('2d');

    if (deviceDiscoveryState.chartInstance) {
        deviceDiscoveryState.chartInstance.destroy();
    }

    const labels = sortedNodes.map(node => node.label);
    const datasets = Object.values(DEVICE_ANALYSIS).map(analysis => ({
        label: `${analysis.label}`,
        data: sortedNodes.map(node => node.counts[analysis.key]),
        backgroundColor: analysis.color,
        borderWidth: 1
    }));

    deviceDiscoveryState.chartInstance = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' }
            },
            scales: {
                x: { stacked: true, ticks: { autoSkip: false, maxRotation: 45, minRotation: 45 } },
                y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Devices' } }
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
            <td>${node.label}</td>
            <td>${getNodePlatform(node.id, applianceMap)}</td>
            <td>${node.counts.advanced.toLocaleString()}</td>
            <td>${node.counts.standard.toLocaleString()}</td>
            <td>${node.counts.discovery.toLocaleString()}</td>
            <td>${node.counts.total.toLocaleString()}</td>
        `;
        tbody.appendChild(tr);
    });

    const totals = sortedNodes.reduce((acc, node) => {
        acc.advanced += node.counts.advanced;
        acc.standard += node.counts.standard;
        acc.discovery += node.counts.discovery;
        acc.total += node.counts.total;
        return acc;
    }, { advanced: 0, standard: 0, discovery: 0, total: 0 });

    const totalRow = document.createElement('tr');
    totalRow.style.fontWeight = '600';
    totalRow.innerHTML = `
        <td colspan="2">TOTAL</td>
        <td>${totals.advanced.toLocaleString()}</td>
        <td>${totals.standard.toLocaleString()}</td>
        <td>${totals.discovery.toLocaleString()}</td>
        <td>${totals.total.toLocaleString()}</td>
    `;
    tbody.appendChild(totalRow);
}

async function generateDeviceDiscoveryReport() {
    const loading = document.getElementById('deviceDiscoveryLoading');
    const results = document.getElementById('deviceDiscoveryResults');
    const noData = document.getElementById('deviceNoDataMessage');
    const rangeInfo = document.getElementById('deviceReportRange');
    const nodeCount = document.getElementById('deviceNodeCount');

    loading.style.display = 'block';
    results.style.display = 'none';
    noData.style.display = 'none';

    try {
        await loadAppliancesForDeviceModule();
        const range = getPeriodRange(deviceDiscoveryState.selectedPeriod);
        rangeInfo.textContent = `${range.label} · ${range.displayRange}`;

        const data = await fetchDevicesBatch(range);
        const aggregateEntries = Object.entries(data.aggregate);

        if (!aggregateEntries.length) {
            noData.style.display = 'block';
            updateDeviceDiscoveryKpis({ totalDevices: 0, perLevelTotals: { advanced: 0, standard: 0, discovery: 0 } });
            nodeCount.textContent = 'Nodes represented: 0';
        } else {
            let filteredEntries = aggregateEntries;
            
            // Filter out EFC nodes if includeEfc is false
            if (!deviceDiscoveryState.includeEfc) {
                filteredEntries = aggregateEntries.filter(([nodeId]) => !isEfcNode(nodeId, deviceDiscoveryState.applianceMap));
            }

            const sortedNodes = filteredEntries.map(([nodeId, counts]) => ({
                id: nodeId,
                label: getNodeLabel(nodeId, deviceDiscoveryState.applianceMap),
                counts
            })).sort((a, b) => b.counts.total - a.counts.total);

            // Recalculate totals if we filtered out EFC nodes
            let finalData = data;
            if (!deviceDiscoveryState.includeEfc) {
                const filteredAggregate = {};
                const filteredPerLevelTotals = { advanced: 0, standard: 0, discovery: 0 };
                let filteredTotalDevices = 0;

                sortedNodes.forEach(node => {
                    filteredAggregate[node.id] = node.counts;
                    filteredPerLevelTotals.advanced += node.counts.advanced;
                    filteredPerLevelTotals.standard += node.counts.standard;
                    filteredPerLevelTotals.discovery += node.counts.discovery;
                    filteredTotalDevices += node.counts.total;
                });

                finalData = {
                    aggregate: filteredAggregate,
                    perLevelTotals: filteredPerLevelTotals,
                    totalDevices: filteredTotalDevices
                };
            }

            nodeCount.textContent = `Nodes represented: ${sortedNodes.length}`;
            updateDeviceDiscoveryKpis(finalData);
            renderDeviceDiscoveryChart(sortedNodes);
            renderDeviceDiscoveryTable(sortedNodes, deviceDiscoveryState.applianceMap);
        }

        loading.style.display = 'none';
        results.style.display = 'block';
    } catch (error) {
        console.error('Error generating device discovery report', error);
        loading.style.display = 'none';
        alert(`Error generating Device Discovery report: ${error.message}`);
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
}

function initDeviceDiscoveryModule() {
    setupDeviceDiscoveryEvents();
}

function activateDeviceDiscoveryModule() {
    // Placeholder for future activation logic
}

window.initDeviceDiscoveryModule = initDeviceDiscoveryModule;
window.activateDeviceDiscoveryModule = activateDeviceDiscoveryModule;
