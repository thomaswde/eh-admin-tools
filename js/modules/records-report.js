// Records Report (CRS Usage) Module

const crsState = {
    selectedPeriod: 'yesterday',
    inputMethod: 'manual',
    csvData: null,
    lastReport: null,
    chartInstances: {}
};

const CRS_DAY_MS = 24 * 60 * 60 * 1000;
const CRS_PERIOD_DAYS = {
    yesterday: 1,
    week: 7,
    month: 30
};

// Model capacity mapping
const CRS_CAPACITIES = {
    'EDA1100V_TRACE': 20,
    'EDA1100V': 20,
    'EDA1200': 20,
    'EDA4200': 100,
    'EDA6100V_TRACE': 200,
    'EDA6100V': 200,
    'EDA6200': 200,
    'EDA8200V': 500,
    'EDA8200': 500,
    'EDA9200': 750,
    'EDA9300': 750,
    'EDA10200': 1000,
    'EDA10300': 1000
};

// Update capacity input options based on selected period
function updateCapacityInputOptions() {
    const isMultiDay = crsState.selectedPeriod !== 'yesterday';
    const capacityInputSection = document.getElementById('capacityInputSection');
    
    if (isMultiDay) {
        // For multi-day periods, hide the button section entirely and force CSV mode
        capacityInputSection.style.display = 'none';
        crsState.inputMethod = 'csv';
        document.getElementById('manualCapacityInput').style.display = 'none';
        document.getElementById('csvCapacityInput').style.display = 'flex';
    } else {
        // For single day, show button section
        capacityInputSection.style.display = 'block';
        
        const manualBtn = document.querySelector('.capacity-input-btn[data-input="manual"]');
        const csvBtn = document.querySelector('.capacity-input-btn[data-input="csv"]');
        
        // Restore previous selection or default to manual
        if (crsState.inputMethod === 'manual') {
            manualBtn.classList.add('active');
            csvBtn.classList.remove('active');
            document.getElementById('manualCapacityInput').style.display = 'flex';
            document.getElementById('csvCapacityInput').style.display = 'none';
        } else {
            manualBtn.classList.remove('active');
            csvBtn.classList.add('active');
            document.getElementById('manualCapacityInput').style.display = 'none';
            document.getElementById('csvCapacityInput').style.display = 'flex';
        }
    }

    // Update environment-specific helper tips after adjusting visibility
    updateCapacityTips();
}

// Show environment-specific helper tips for RevealX 360
function updateCapacityTips() {
    const manualTip = document.getElementById('manualCapacityTip360');
    const csvTip = document.getElementById('csvCapacityTip360');

    if (!manualTip || !csvTip) return;

    const is360 = !!(window.state && window.state.apiConfig && window.state.apiConfig.type === '360');

    if (!is360) {
        manualTip.style.display = 'none';
        csvTip.style.display = 'none';
        return;
    }

    if (crsState.inputMethod === 'manual') {
        manualTip.style.display = 'block';
        csvTip.style.display = 'none';
    } else {
        manualTip.style.display = 'none';
        csvTip.style.display = 'block';
    }
}

// Helper functions
function bytesToGB(bytes) {
    if (!bytes || bytes <= 0) return 0;
    // Keep fractional GB so small non-zero values are not rounded down to 0
    return bytes / (1024 ** 3);
}

function formatGBWithUnits(valueGB) {
    if (!Number.isFinite(valueGB)) {
        return 'N/A';
    }
    if (valueGB <= 0) {
        return '0.00 GB';
    }

    const abs = Math.abs(valueGB);
    let unit = 'GB';
    let value = valueGB;

    if (abs >= 1024) {
        value = valueGB / 1024; // Convert GB to TB
        unit = 'TB';
    }

    return `${value.toFixed(2)} ${unit}`;
}

function parseCRSCalendarDate(dateStr) {
    const value = String(dateStr || '').trim();
    let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\b|T)/);
    let year;
    let month;
    let day;
    if (match) {
        [, year, month, day] = match;
    } else {
        match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\b|\s)/);
        if (!match) throw new Error(`Invalid Summary Date UTC value: ${value || '(blank)'}`);
        [, month, day, year] = match;
    }
    const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
    const parsed = new Date(timestamp);
    if (parsed.getUTCFullYear() !== Number(year)
        || parsed.getUTCMonth() !== Number(month) - 1
        || parsed.getUTCDate() !== Number(day)) {
        throw new Error(`Invalid Summary Date UTC value: ${value}`);
    }
    return parsed.toISOString().slice(0, 10);
}

function getDateUnixTimes(dateStr) {
    const isoDate = parseCRSCalendarDate(dateStr);
    const from = Date.parse(`${isoDate}T00:00:00.000Z`);
    return {
        from,
        until: from + CRS_DAY_MS
    };
}

function buildCRSReportWindow(period, nowMs = Date.now()) {
    const dayCount = CRS_PERIOD_DAYS[period];
    if (!dayCount) throw new Error(`Unsupported Records Report period: ${period}`);
    const now = new Date(nowMs);
    if (!Number.isFinite(now.getTime())) throw new Error('Unable to determine the Records Report time window');
    const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const untilMs = todayStartMs;
    const fromMs = untilMs - (dayCount * CRS_DAY_MS);
    const dates = Array.from({ length: dayCount }, (_, index) =>
        new Date(fromMs + (index * CRS_DAY_MS)).toISOString().slice(0, 10)
    );
    return {
        start: dates[0],
        end: dates[dates.length - 1],
        dates,
        dayCount,
        fromMs,
        untilMs,
        timezone: 'UTC',
        untilExclusive: true
    };
}

function getDateRange(period, nowMs = Date.now()) {
    return buildCRSReportWindow(period, nowMs);
}

// Parse CSV data
function parseCSV(csvText) {
    const rows = CsvUtils.parseRows(csvText, { skipEmptyRows: true });
    if (!rows.length) throw new Error('CSV file appears to be empty');
    const headers = rows[0].map(header => header.trim());
    
    const dateIdx = headers.findIndex(h => h.includes('Summary Date'));
    const utilizedIdx = headers.findIndex(h => h === 'Utilized');
    const reservedIdx = headers.findIndex(h => h === 'Reserved');
    
    if (dateIdx === -1 || utilizedIdx === -1 || reservedIdx === -1) {
        throw new Error('CSV must have "Summary Date UTC", "Utilized", and "Reserved" columns');
    }
    
    const data = [];
    for (let i = 1; i < rows.length; i++) {
        const values = rows[i].map(value => value.trim());
        if (values.length < 3) continue;
        
        const utilizedText = values[utilizedIdx] ?? '';
        const reservedText = values[reservedIdx] ?? '';
        const utilized = Number(utilizedText);
        const reserved = Number(reservedText);
        if (utilizedText === '' || reservedText === ''
            || !Number.isFinite(utilized) || utilized < 0 || !Number.isFinite(reserved) || reserved <= 0) {
            throw new Error(`Invalid Utilized or Reserved capacity on CSV row ${i + 1}`);
        }
        data.push({ date: parseCRSCalendarDate(values[dateIdx]), utilized, reserved });
    }
    if (!data.length) throw new Error('CSV does not contain any capacity rows');
    return data;
}

function selectCRSCapacityRows(csvData, reportWindow) {
    const rowsByDate = new Map();
    (csvData || []).forEach(row => {
        const date = parseCRSCalendarDate(row.date);
        if (!reportWindow.dates.includes(date)) return;
        if (rowsByDate.has(date)) {
            throw new Error(`CSV contains more than one capacity row for ${date}`);
        }
        rowsByDate.set(date, { ...row, date });
    });
    const missingDates = reportWindow.dates.filter(date => !rowsByDate.has(date));
    if (missingDates.length) {
        throw new Error(`CSV does not cover the selected UTC window; missing ${missingDates.join(', ')}`);
    }
    return reportWindow.dates.map(date => rowsByDate.get(date));
}

// Get capacity data based on input method
function getCapacityData(reportWindow = buildCRSReportWindow(crsState.selectedPeriod)) {
    if (crsState.inputMethod === 'manual') {
        const reserved = parseFloat(document.getElementById('reservedCapacity').value);
        const utilized = parseFloat(document.getElementById('utilizedCapacity').value);
        
        // Return null if neither value is provided (optional capacity data)
        if (!reserved && !utilized) {
            return null;
        }
        
        // If one is provided but not the other, that's an error
        if (!reserved || !utilized) {
            throw new Error('Please enter both reserved and utilized capacity values, or leave both blank');
        }
        
        return { reserved, utilized, dayCount: 1, aggregationMode: 'daily_manual' };
    } else {
        // CSV mode - capacity data is optional
        if (!crsState.csvData || crsState.csvData.length === 0) {
            return null; // No CSV = no capacity data, which is fine
        }
        
        const selectedRows = selectCRSCapacityRows(crsState.csvData, reportWindow);
        const sortedData = [...selectedRows].sort((a, b) => b.date.localeCompare(a.date));
        
        // Use reserved from most recent day (may have changed over time)
        // Use average utilized across the period
        const avgUtilized = selectedRows.reduce((sum, d) => sum + d.utilized, 0) / selectedRows.length;
        const mostRecentReserved = sortedData[0].reserved;
        
        return {
            reserved: mostRecentReserved,
            utilized: avgUtilized,
            isAveraged: true,
            dayCount: selectedRows.length,
            aggregationMode: 'daily_average',
            coveredDates: selectedRows.map(row => row.date)
        };
    }
}

// Fetch appliances and metrics
async function fetchCRSData(reportWindow) {
    const appliances = await window.apiClient.getAppliances();
    
    // Filter for all discover appliances (EDA, EFC, IDS, etc.)
    const discoverAppliances = appliances.filter(a => 
        a.platform === 'discover'
    );
    
    const appliancesById = Object.fromEntries(discoverAppliances.map(appliance => [String(appliance.id), appliance]));
    const eligibleAppliances = discoverAppliances.filter(appliance =>
        String(appliance.status_message || '').trim().toLowerCase() === 'online'
        && appliance.data_access !== false
    );
    const metricPayload = SystemHealthCollection.buildMetricRequest({
        cycle: 'auto',
        fromMs: reportWindow.fromMs,
        untilMs: reportWindow.untilMs,
        objectIds: eligibleAppliances.map(appliance => appliance.id),
        metricNames: ['record_bytes'],
        metricCategory: 'capture'
    });
    let rows = [];
    let coverage;
    if (!eligibleAppliances.length) {
        coverage = SystemHealthCollection.buildSensorCoverage(discoverAppliances, rows);
    } else {
        try {
            const collected = await SystemHealthCollection.collectMetricEndpoint(
                (path, options) => window.apiClient.request(path, options),
                '/metrics/totalbyobject',
                metricPayload
            );
            rows = SystemHealthCollection.normalizeAggregateChunks(
                collected.chunks,
                appliancesById,
                ['record_bytes']
            ).rows;
            coverage = SystemHealthCollection.buildSensorCoverage(discoverAppliances, rows, {
                sensorFailures: collected.sensor_failures
            });
        } catch (error) {
            console.error('Error fetching Records Report metrics:', error);
            coverage = SystemHealthCollection.buildSensorCoverage(discoverAppliances, rows, { error });
        }
    }
    const summary = SystemHealthCollection.summarizeAggregateRows(rows);
    return discoverAppliances.map(appliance => {
        const id = String(appliance.id);
        const recordBytes = Object.prototype.hasOwnProperty.call(summary.totals, id)
            ? summary.totals[id]
            : null;
        return {
            id,
            name: appliance.display_name,
            model: appliance.license_platform,
            recordBytes,
            recordBytesGB: recordBytes === null ? null : bytesToGB(recordBytes),
            capacity: CRS_CAPACITIES[appliance.license_platform] || 0,
            collectionStatus: coverage[id] || { status: 'empty', row_count: 0 },
            aggregationMode: 'total_by_object',
            reportFromMs: reportWindow.fromMs,
            reportUntilMs: reportWindow.untilMs
        };
    });
}

function buildCRSSummary(applianceData, capacityData, dayCount) {
    const rows = applianceData || [];
    const validDayCount = Number(dayCount) > 0 ? Number(dayCount) : null;
    const measuredAppliances = rows.filter(row => Number.isFinite(row.recordBytesGB));
    const collectionComplete = rows.length > 0 && measuredAppliances.length === rows.length;
    const measuredRecordBytesGB = measuredAppliances.reduce((sum, row) => sum + row.recordBytesGB, 0);
    const totalRecordBytesGB = collectionComplete ? measuredRecordBytesGB : null;
    const averageDailyRecordBytesGB = collectionComplete && validDayCount
        ? totalRecordBytesGB / validDayCount
        : null;
    const ratio = capacityData && averageDailyRecordBytesGB > 0 && capacityData.utilized > 0
        ? averageDailyRecordBytesGB / capacityData.utilized
        : null;
    return {
        totalRecordBytesGB,
        measuredRecordBytesGB,
        averageDailyRecordBytesGB,
        collectionComplete,
        compressionRatio: ratio,
        utilizationPercent: capacityData && capacityData.reserved > 0
            ? (capacityData.utilized / capacityData.reserved) * 100
            : null,
        applianceData: rows.map(row => ({
            ...row,
            averageDailyRecordBytesGB: Number.isFinite(row.recordBytesGB) && validDayCount
                ? row.recordBytesGB / validDayCount
                : null,
            compressedGB: ratio && Number.isFinite(row.recordBytesGB) && validDayCount
                ? (row.recordBytesGB / validDayCount) / ratio
                : row.recordBytesGB
        }))
    };
}

// Generate report
async function generateCRSReport() {
    document.getElementById('crsLoading').style.display = 'block';
    document.getElementById('crsResults').style.display = 'none';
    
    try {
        const reportWindow = buildCRSReportWindow(crsState.selectedPeriod);
        const capacityData = getCapacityData(reportWindow);
        const applianceData = await fetchCRSData(reportWindow);
        const summary = buildCRSSummary(applianceData, capacityData, reportWindow.dayCount);
        const totalRecordBytesGB = summary.totalRecordBytesGB;
        const compressionRatio = summary.compressionRatio === null ? null : summary.compressionRatio.toFixed(2);
        const utilizationPercent = summary.utilizationPercent === null ? null : summary.utilizationPercent.toFixed(1);
        const compressedData = summary.applianceData;
        crsState.lastReport = { reportWindow, capacityData, ...summary };
        
        // Update KPIs
        if (compressionRatio !== null) {
            document.getElementById('compressionRatio').textContent = compressionRatio;
            document.getElementById('compressionRatioSubtext').textContent = '1 GB stored : ' + compressionRatio + ' GB ingested';
        } else {
            document.getElementById('compressionRatio').textContent = 'N/A';
            document.getElementById('compressionRatioSubtext').textContent = 'Add capacity data to calculate';
        }
        
        document.getElementById('totalRecordBytes').textContent = formatGBWithUnits(totalRecordBytesGB);
        
        if (utilizationPercent !== null) {
            document.getElementById('capacityUtilization').textContent = `${utilizationPercent}%`;
            const subtext = capacityData.isAveraged ? 'Of reserved (selected-window daily average)' : 'Of reserved capacity';
            document.getElementById('capacityUtilizationSubtext').textContent = subtext;
        } else {
            document.getElementById('capacityUtilization').textContent = 'N/A';
            document.getElementById('capacityUtilizationSubtext').textContent = 'Add capacity data to calculate';
        }
        
        // Update chart title based on whether we have capacity data
        const stackedChartTitle = document.getElementById('stackedChartTitle');
        const barChartTitle = document.getElementById('barChartTitle');
        if (compressionRatio !== null) {
            stackedChartTitle.textContent = 'Capacity Consumption by Sensor';
            barChartTitle.textContent = 'Utilization by Sensor';
        } else {
            stackedChartTitle.textContent = 'Record Bytes by Sensor';
            barChartTitle.textContent = 'Record Bytes by Sensor';
        }
        
        // Render charts
        renderStackedBarChart(compressedData, compressionRatio !== null ? capacityData.reserved : null);
        renderSensorBarChart(compressedData);
        renderDataTable(compressedData, compressionRatio);
        
        document.getElementById('crsLoading').style.display = 'none';
        document.getElementById('crsResults').style.display = 'flex';
        
    } catch (error) {
        alert(`Error generating report: ${error.message}`);
        document.getElementById('crsLoading').style.display = 'none';
    }
}

// Render stacked horizontal bar chart
function renderStackedBarChart(data, reservedCapacity) {
    const canvas = document.getElementById('stackedBarChart');
    const ctx = canvas.getContext('2d');
    
    // Destroy existing chart
    if (crsState.chartInstances.stacked) {
        crsState.chartInstances.stacked.destroy();
    }
    
    const consumed = data.reduce((sum, d) =>
        sum + (Number.isFinite(d.compressedGB) ? d.compressedGB : 0), 0
    );
    
    const datasets = data
        .filter(d => Number.isFinite(d.compressedGB) && d.compressedGB > 0)
        .map((d, i) => ({
            label: d.name,
            data: [d.compressedGB],
            backgroundColor: genericChartPaletteColor(i)
        }));
    
    // Only add remaining capacity if reservedCapacity is provided
    if (reservedCapacity !== null) {
        const remaining = Math.max(0, reservedCapacity - consumed);
        datasets.push({
            label: 'Remaining Capacity',
            data: [remaining],
            backgroundColor: appCssColor('--gray', '#898a8d')
        });
    }
    
    crsState.chartInstances.stacked = new Chart(ctx, {
        type: 'bar',
        data: { labels: ['Capacity'], datasets },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    stacked: true,
                    title: { display: true, text: reservedCapacity !== null ? 'Capacity (GB)' : 'Record Bytes (GB)' }
                },
                y: { stacked: true, display: false }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (context) => `${context.dataset.label}: ${context.parsed.x} GB`
                    }
                }
            }
        }
    });
}

// Render vertical bar chart
function renderSensorBarChart(data) {
    const canvas = document.getElementById('sensorBarChart');
    const ctx = canvas.getContext('2d');
    
    if (crsState.chartInstances.bar) {
        crsState.chartInstances.bar.destroy();
    }
    
    const sortedData = [...data].sort((a, b) =>
        (Number.isFinite(b.compressedGB) ? b.compressedGB : -1)
        - (Number.isFinite(a.compressedGB) ? a.compressedGB : -1)
    );
    const labels = sortedData.map(d => d.name);
    const values = sortedData.map(d => Number.isFinite(d.compressedGB) ? d.compressedGB : null);
    
    crsState.chartInstances.bar = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Utilization (GB)',
                data: values,
                backgroundColor: genericChartPrimaryColor()
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Capacity Utilization (GB)' }
                },
                x: {
                    ticks: {
                        autoSkip: false,
                        maxRotation: 45,
                        minRotation: 45
                    }
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
}

// Render data table
function renderDataTable(data, compressionRatio) {
    const tbody = document.getElementById('crsDataTableBody');
    tbody.innerHTML = '';
    
    // Update table header based on whether we have compression data
    const tableHeader = document.querySelector('#crsDataTable thead tr');
    const hasCompression = compressionRatio !== null;
    tableHeader.innerHTML = `
        <th>Sensor Name</th>
        <th>Platform</th>
        <th>Period Record Bytes (GB)</th>
        ${hasCompression ? '<th>Average Daily Stored (GB)</th>' : ''}
        <th>Collection Status</th>
    `;
    
    const sortedData = [...data].sort((a, b) =>
        (Number.isFinite(b.compressedGB) ? b.compressedGB : -1)
        - (Number.isFinite(a.compressedGB) ? a.compressedGB : -1)
    );
    
    sortedData.forEach(d => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${escapeHtml(d.name)}</td>
            <td>${escapeHtml(d.model)}</td>
            <td>${Number.isFinite(d.recordBytesGB) ? d.recordBytesGB.toFixed(2) : '&mdash;'}</td>
            ${hasCompression ? `<td>${Number.isFinite(d.compressedGB) ? d.compressedGB.toFixed(2) : '&mdash;'}</td>` : ''}
            <td>${escapeHtml(String(d.collectionStatus?.status || 'unknown').replaceAll('_', ' '))}</td>
        `;
        tbody.appendChild(row);
    });
    
    // Add totals row
    const totalRow = document.createElement('tr');
    totalRow.style.fontWeight = 'bold';
    totalRow.style.borderTop = '2px solid var(--border-color)';
    const totalRecordBytes = data.reduce((sum, d) => sum + (Number.isFinite(d.recordBytesGB) ? d.recordBytesGB : 0), 0).toFixed(2);
    const totalCompressed = data.reduce((sum, d) => sum + (Number.isFinite(d.compressedGB) ? d.compressedGB : 0), 0).toFixed(2);
    const totalLabel = data.every(d => Number.isFinite(d.recordBytesGB)) ? 'TOTAL' : 'MEASURED SUBTOTAL';
    totalRow.innerHTML = `
        <td colspan="2">${totalLabel}</td>
        <td>${totalRecordBytes}</td>
        ${hasCompression ? `<td>${totalCompressed}</td>` : ''}
        <td></td>
    `;
    tbody.appendChild(totalRow);
}

// Records Report module initialization function
function initCrsUsageModule() {
    console.log('Initializing Records Report module');
    
    // Set up event listeners specific to CRS module
    if (!document.getElementById('generateCrsReport').hasAttribute('data-listener-added')) {
        document.querySelectorAll('.crs-period-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.crs-period-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                crsState.selectedPeriod = btn.dataset.period;
                updateCapacityInputOptions();
            });
            btn.setAttribute('data-listener-added', 'true');
        });

        document.querySelectorAll('.capacity-input-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.capacity-input-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                crsState.inputMethod = btn.dataset.input;
                
                if (crsState.inputMethod === 'manual') {
                    document.getElementById('manualCapacityInput').style.display = 'flex';
                    document.getElementById('csvCapacityInput').style.display = 'none';
                } else {
                    document.getElementById('manualCapacityInput').style.display = 'none';
                    document.getElementById('csvCapacityInput').style.display = 'flex';
                }

                // Update helper tips when the input method changes
                updateCapacityTips();
            });
            btn.setAttribute('data-listener-added', 'true');
        });

        document.getElementById('csvFileInput').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    crsState.csvData = parseCSV(event.target.result);
                    
                    const summary = document.getElementById('csvSummary');
                    summary.innerHTML = `
                        <strong>${crsState.csvData.length} records loaded</strong><br>
                        Date range: ${escapeHtml(crsState.csvData[crsState.csvData.length - 1].date)} to ${escapeHtml(crsState.csvData[0].date)}<br>
                        Avg Utilized: ${(crsState.csvData.reduce((s, d) => s + d.utilized, 0) / crsState.csvData.length).toFixed(1)} GB<br>
                        Avg Reserved: ${(crsState.csvData.reduce((s, d) => s + d.reserved, 0) / crsState.csvData.length).toFixed(1)} GB
                    `;
                    document.getElementById('csvPreview').style.display = 'block';
                } catch (error) {
                    alert(`Error parsing CSV: ${error.message}`);
                }
            };
            reader.readAsText(file);
        });

        document.getElementById('generateCrsReport').addEventListener('click', generateCRSReport);
        
        // Mark that listeners have been added
        document.getElementById('generateCrsReport').setAttribute('data-listener-added', 'true');
    }
    
    // Initialize the UI state
    updateCapacityInputOptions();
}
