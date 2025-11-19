// Records Report (CRS Usage) Module

const crsState = {
    selectedPeriod: 'yesterday',
    inputMethod: 'manual',
    csvData: null,
    chartInstances: {}
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

// ExtraHop brand colors for charts
const EH_COLORS = ['#ec0089', '#00aaef', '#f05918', '#dae343', '#7f2854', '#261f63'];

// Update capacity input options based on selected period
function updateCapacityInputOptions() {
    const isMultiDay = crsState.selectedPeriod !== 'yesterday';
    const capacityInputSection = document.getElementById('capacityInputSection');
    
    if (isMultiDay) {
        // For multi-day periods, hide the button section entirely and force CSV mode
        capacityInputSection.style.display = 'none';
        crsState.inputMethod = 'csv';
        document.getElementById('manualCapacityInput').style.display = 'none';
        document.getElementById('csvCapacityInput').style.display = 'block';
    } else {
        // For single day, show button section
        capacityInputSection.style.display = 'block';
        
        const manualBtn = document.querySelector('.capacity-input-btn[data-input="manual"]');
        const csvBtn = document.querySelector('.capacity-input-btn[data-input="csv"]');
        
        // Restore previous selection or default to manual
        if (crsState.inputMethod === 'manual') {
            manualBtn.classList.add('active');
            csvBtn.classList.remove('active');
            document.getElementById('manualCapacityInput').style.display = 'block';
            document.getElementById('csvCapacityInput').style.display = 'none';
        } else {
            manualBtn.classList.remove('active');
            csvBtn.classList.add('active');
            document.getElementById('manualCapacityInput').style.display = 'none';
            document.getElementById('csvCapacityInput').style.display = 'block';
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
    if (!valueGB || valueGB <= 0) {
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

function getDateUnixTimes(dateStr) {
    const date = new Date(dateStr);
    const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
    return {
        from: Math.floor(startOfDay.getTime()),
        until: Math.floor(endOfDay.getTime())
    };
}

function getYesterday() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.toISOString().split('T')[0];
}

function getDateRange(period) {
    const end = new Date();
    end.setDate(end.getDate() - 1); // Yesterday
    const start = new Date(end);
    
    if (period === 'week') {
        start.setDate(start.getDate() - 6);
    } else if (period === 'month') {
        start.setDate(start.getDate() - 29);
    }
    
    return {
        start: start.toISOString().split('T')[0],
        end: end.toISOString().split('T')[0]
    };
}

// Parse CSV data
function parseCSV(csvText) {
    const lines = csvText.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
    
    const dateIdx = headers.findIndex(h => h.includes('Summary Date'));
    const utilizedIdx = headers.findIndex(h => h === 'Utilized');
    const reservedIdx = headers.findIndex(h => h === 'Reserved');
    
    if (dateIdx === -1 || utilizedIdx === -1 || reservedIdx === -1) {
        throw new Error('CSV must have "Summary Date UTC", "Utilized", and "Reserved" columns');
    }
    
    const data = [];
    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.replace(/"/g, '').trim());
        if (values.length < 3) continue;
        
        data.push({
            date: values[dateIdx],
            utilized: parseFloat(values[utilizedIdx]),
            reserved: parseFloat(values[reservedIdx])
        });
    }
    
    return data;
}

// Get capacity data based on input method
function getCapacityData() {
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
        
        return { reserved, utilized };
    } else {
        // CSV mode - capacity data is optional
        if (!crsState.csvData || crsState.csvData.length === 0) {
            return null; // No CSV = no capacity data, which is fine
        }
        
        // Sort by date to get most recent
        const sortedData = [...crsState.csvData].sort((a, b) => 
            new Date(b.date) - new Date(a.date)
        );
        
        // Use reserved from most recent day (may have changed over time)
        // Use average utilized across the period
        const avgUtilized = crsState.csvData.reduce((sum, d) => sum + d.utilized, 0) / crsState.csvData.length;
        const mostRecentReserved = sortedData[0].reserved;
        
        return {
            reserved: mostRecentReserved,
            utilized: avgUtilized,
            isAveraged: true // Flag to show in UI
        };
    }
}

// Fetch appliances and metrics
async function fetchCRSData(dateRange) {
    const appliances = await window.apiClient.getAppliances();
    
    // Filter for all discover appliances (EDA, EFC, IDS, etc.)
    const discoverAppliances = appliances.filter(a => 
        a.platform === 'discover'
    );
    
    const results = [];
    
    // Use the full selected date range for the metrics query so that
    // multi-day periods (week/month) return aggregated record bytes
    const startTimes = getDateUnixTimes(dateRange.start);
    const endTimes = getDateUnixTimes(dateRange.end);
    
    for (const appliance of discoverAppliances) {
        const metricPayload = {
            cycle: 'auto',
            from: startTimes.from,
            until: endTimes.until,
            metric_category: 'capture',
            metric_specs: [{ name: 'record_bytes' }],
            object_ids: [appliance.id],
            object_type: 'system'
        };
        
        try {
            const metricResponse = await window.apiClient.request('/metrics/total', {
                method: 'POST',
                body: JSON.stringify(metricPayload)
            });
            
            const recordBytes = metricResponse.stats?.[0]?.values?.[0] || 0;
            
            results.push({
                name: appliance.display_name,
                model: appliance.license_platform,
                recordBytes: recordBytes,
                recordBytesGB: bytesToGB(recordBytes),
                capacity: CRS_CAPACITIES[appliance.license_platform] || 0
            });
        } catch (error) {
            console.error(`Error fetching metrics for ${appliance.display_name}:`, error);
            results.push({
                name: appliance.display_name,
                model: appliance.license_platform,
                recordBytes: 0,
                recordBytesGB: 0,
                capacity: CRS_CAPACITIES[appliance.license_platform] || 0
            });
        }
    }
    
    return results;
}

// Generate report
async function generateCRSReport() {
    document.getElementById('crsLoading').style.display = 'block';
    document.getElementById('crsResults').style.display = 'none';
    
    try {
        const dateRange = getDateRange(crsState.selectedPeriod);
        const capacityData = getCapacityData(); // Can be null
        const applianceData = await fetchCRSData(dateRange);
        
        // Calculate totals
        const totalRecordBytesGB = applianceData.reduce((sum, a) => sum + a.recordBytesGB, 0);
        
        let compressionRatio = null; // string for display (e.g., '3.21')
        let utilizationPercent = null;
        let compressedData = applianceData;
        
        if (capacityData) {
            const ratio = totalRecordBytesGB > 0 ? (totalRecordBytesGB / capacityData.utilized) : null;
            compressionRatio = ratio ? ratio.toFixed(2) : 'N/A';
            utilizationPercent = ((capacityData.utilized / capacityData.reserved) * 100).toFixed(1);
            
            // Calculate compressed values
            compressedData = applianceData.map(a => ({
                ...a,
                // Store numeric GB for charts; we'll format for display later
                compressedGB: ratio ? (a.recordBytesGB / ratio) : 0
            }));
        } else {
            // No capacity data - use raw record bytes
            compressedData = applianceData.map(a => ({
                ...a,
                // Keep numeric GB so charts can include small non-zero values
                compressedGB: a.recordBytesGB
            }));
        }
        
        // Update KPIs
        if (compressionRatio) {
            document.getElementById('compressionRatio').textContent = compressionRatio;
            document.getElementById('compressionRatioSubtext').textContent = '1 GB stored : ' + compressionRatio + ' GB ingested';
        } else {
            document.getElementById('compressionRatio').textContent = 'N/A';
            document.getElementById('compressionRatioSubtext').textContent = 'Add capacity data to calculate';
        }
        
        document.getElementById('totalRecordBytes').textContent = formatGBWithUnits(totalRecordBytesGB);
        
        if (utilizationPercent) {
            document.getElementById('capacityUtilization').textContent = `${utilizationPercent}%`;
            const subtext = capacityData.isAveraged ? 'Of reserved (avg utilized from CSV)' : 'Of reserved capacity';
            document.getElementById('capacityUtilizationSubtext').textContent = subtext;
        } else {
            document.getElementById('capacityUtilization').textContent = 'N/A';
            document.getElementById('capacityUtilizationSubtext').textContent = 'Add capacity data to calculate';
        }
        
        // Update chart title based on whether we have capacity data
        const stackedChartTitle = document.getElementById('stackedChartTitle');
        const barChartTitle = document.getElementById('barChartTitle');
        if (capacityData) {
            stackedChartTitle.textContent = 'Capacity Consumption by Sensor';
            barChartTitle.textContent = 'Utilization by Sensor';
        } else {
            stackedChartTitle.textContent = 'Record Bytes by Sensor';
            barChartTitle.textContent = 'Record Bytes by Sensor';
        }
        
        // Render charts
        renderStackedBarChart(compressedData, capacityData ? capacityData.reserved : null);
        renderSensorBarChart(compressedData);
        renderDataTable(compressedData, compressionRatio);
        
        document.getElementById('crsLoading').style.display = 'none';
        document.getElementById('crsResults').style.display = 'block';
        
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
    
    const consumed = data.reduce((sum, d) => sum + parseFloat(d.compressedGB), 0);
    
    const datasets = data
        .filter(d => parseFloat(d.compressedGB) > 0)
        .map((d, i) => ({
            label: d.name,
            data: [parseFloat(d.compressedGB)],
            backgroundColor: EH_COLORS[i % EH_COLORS.length]
        }));
    
    // Only add remaining capacity if reservedCapacity is provided
    if (reservedCapacity !== null) {
        const remaining = Math.max(0, reservedCapacity - consumed);
        datasets.push({
            label: 'Remaining Capacity',
            data: [remaining],
            backgroundColor: '#898a8d'
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
    
    const sortedData = [...data].sort((a, b) => parseFloat(b.compressedGB) - parseFloat(a.compressedGB));
    const labels = sortedData.map(d => d.name);
    const values = sortedData.map(d => parseFloat(d.compressedGB));
    
    crsState.chartInstances.bar = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Utilization (GB)',
                data: values,
                backgroundColor: '#7f2854'
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
        <th>Record Bytes (GB)</th>
        ${hasCompression ? '<th>After Compression (GB)</th>' : ''}
    `;
    
    const sortedData = [...data].sort((a, b) => parseFloat(b.compressedGB) - parseFloat(a.compressedGB));
    
    sortedData.forEach(d => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${d.name}</td>
            <td>${d.model}</td>
            <td>${d.recordBytesGB.toFixed(2)}</td>
            ${hasCompression ? `<td>${d.compressedGB.toFixed(2)}</td>` : ''}
        `;
        tbody.appendChild(row);
    });
    
    // Add totals row
    const totalRow = document.createElement('tr');
    totalRow.style.fontWeight = 'bold';
    totalRow.style.borderTop = '2px solid var(--border-color)';
    const totalRecordBytes = data.reduce((sum, d) => sum + d.recordBytesGB, 0).toFixed(2);
    const totalCompressed = data.reduce((sum, d) => sum + parseFloat(d.compressedGB), 0).toFixed(2);
    totalRow.innerHTML = `
        <td colspan="2">TOTAL</td>
        <td>${totalRecordBytes}</td>
        ${hasCompression ? `<td>${totalCompressed}</td>` : ''}
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
                    document.getElementById('manualCapacityInput').style.display = 'block';
                    document.getElementById('csvCapacityInput').style.display = 'none';
                } else {
                    document.getElementById('manualCapacityInput').style.display = 'none';
                    document.getElementById('csvCapacityInput').style.display = 'block';
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
                        Date range: ${crsState.csvData[crsState.csvData.length - 1].date} to ${crsState.csvData[0].date}<br>
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