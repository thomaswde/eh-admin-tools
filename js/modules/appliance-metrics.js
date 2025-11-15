class ApplianceMetrics {
    constructor() {
        this.state = {
            selectedPeriod: 'yesterday',
            inputMethod: 'manual',
            csvData: null,
            chartInstances: {}
        };
        
        // Model capacity mapping
        this.CRS_CAPACITIES = {
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
        this.EH_COLORS = ['#ec0089', '#00aaef', '#f05918', '#dae343', '#7f2854', '#261f63'];
    }

    // Update capacity input options based on selected period
    updateCapacityInputOptions() {
        const isMultiDay = this.state.selectedPeriod !== 'yesterday';
        const capacityInputSection = document.getElementById('capacityInputSection');
        
        if (isMultiDay) {
            // For multi-day periods, hide the button section entirely and force CSV mode
            capacityInputSection.style.display = 'none';
            this.state.inputMethod = 'csv';
            document.getElementById('manualCapacityInput').style.display = 'none';
            document.getElementById('csvCapacityInput').style.display = 'block';
        } else {
            // For single day, show button section
            capacityInputSection.style.display = 'block';
            
            const manualBtn = document.querySelector('.capacity-input-btn[data-input="manual"]');
            const csvBtn = document.querySelector('.capacity-input-btn[data-input="csv"]');
            
            // Restore previous selection or default to manual
            if (this.state.inputMethod === 'manual') {
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
    }

    bytesToGB(bytes) {
        return Math.round(bytes / (1024 ** 3));
    }

    getDateUnixTimes(dateStr) {
        const date = new Date(dateStr);
        const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
        const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
        return {
            from: Math.floor(startOfDay.getTime()),
            until: Math.floor(endOfDay.getTime())
        };
    }

    getYesterday() {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        return yesterday.toISOString().split('T')[0];
    }

    getDateRange(period) {
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
    parseCSV(csvText) {
        const lines = csvText.trim().split('\n');
        const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
        
        // Find column indices
        const dateIdx = headers.findIndex(h => h.includes('Date') || h.includes('date'));
        const utilizedIdx = headers.findIndex(h => h.includes('Utilized') || h.includes('utilized'));
        const reservedIdx = headers.findIndex(h => h.includes('Reserved') || h.includes('reserved'));
        
        if (dateIdx === -1 || utilizedIdx === -1 || reservedIdx === -1) {
            throw new Error('CSV must contain "Date", "Utilized", and "Reserved" columns');
        }
        
        const data = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const values = line.split(',').map(v => v.replace(/"/g, '').trim());
            data.push({
                date: values[dateIdx],
                utilized: parseFloat(values[utilizedIdx]),
                reserved: parseFloat(values[reservedIdx])
            });
        }
        
        return data;
    }

    // Get capacity data based on input method
    getCapacityData() {
        if (this.state.inputMethod === 'manual') {
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
            if (!this.state.csvData || this.state.csvData.length === 0) {
                return null; // No CSV = no capacity data, which is fine
            }
            
            // Sort by date to get most recent
            const sortedData = [...this.state.csvData].sort((a, b) => 
                new Date(b.date) - new Date(a.date)
            );
            
            // Use reserved from most recent day (may have changed over time)
            // Use average utilized across the period
            const avgUtilized = this.state.csvData.reduce((sum, d) => sum + d.utilized, 0) / this.state.csvData.length;
            const mostRecentReserved = sortedData[0].reserved;
            
            return {
                reserved: mostRecentReserved,
                utilized: avgUtilized,
                isAveraged: true // Flag to show in UI
            };
        }
    }

    // Fetch appliances and metrics
    async fetchCRSData(dateRange) {
        const appliances = await window.apiClient.getAppliances();
        
        // Filter for EDA discover appliances only
        const edaAppliances = appliances.filter(a => 
            a.platform === 'discover' && 
            a.license_platform && 
            a.license_platform.includes('EDA')
        );
        
        const results = [];
        
        for (const appliance of edaAppliances) {
            try {
                const times = this.getDateUnixTimes(dateRange.end); // Use end date for single day query
                const metricPayload = {
                    cycle: 'auto',
                    from: times.from,
                    until: times.until,
                    metric_category: 'capture',
                    metric_specs: [{ name: 'record_bytes' }],
                    object_ids: [appliance.id],
                    object_type: 'system'
                };
                
                const metricResponse = await window.apiClient.request('/metrics/total', {
                    method: 'POST',
                    body: JSON.stringify(metricPayload)
                });
                const recordBytes = metricResponse.stats?.[0]?.values?.[0] || 0;
                
                results.push({
                    name: appliance.display_name,
                    model: appliance.license_platform,
                    recordBytes: recordBytes,
                    recordBytesGB: this.bytesToGB(recordBytes),
                    capacity: this.CRS_CAPACITIES[appliance.license_platform] || 0
                });
            } catch (error) {
                console.error(`Error fetching metrics for ${appliance.display_name}:`, error);
                results.push({
                    name: appliance.display_name,
                    model: appliance.license_platform,
                    recordBytes: 0,
                    recordBytesGB: 0,
                    capacity: this.CRS_CAPACITIES[appliance.license_platform] || 0
                });
            }
        }
        
        return results;
    }

    // Generate report
    async generateCRSReport() {
        document.getElementById('crsLoading').style.display = 'block';
        document.getElementById('crsResults').style.display = 'none';
        
        try {
            const dateRange = this.getDateRange(this.state.selectedPeriod);
            const capacityData = this.getCapacityData(); // Can be null
            const applianceData = await this.fetchCRSData(dateRange);
            
            // Calculate totals
            const totalRecordBytesGB = applianceData.reduce((sum, a) => sum + a.recordBytesGB, 0);
            
            let compressionRatio = null;
            let utilizationPercent = null;
            let compressedData = applianceData;
            
            if (capacityData) {
                compressionRatio = totalRecordBytesGB > 0 ? (totalRecordBytesGB / capacityData.utilized).toFixed(2) : 'N/A';
                utilizationPercent = ((capacityData.utilized / capacityData.reserved) * 100).toFixed(1);
                
                // Calculate compressed values
                compressedData = applianceData.map(a => ({
                    ...a,
                    compressedGB: totalRecordBytesGB > 0 ? (a.recordBytesGB / compressionRatio).toFixed(2) : 0
                }));
            } else {
                // No capacity data - show raw record bytes
                compressedData = applianceData.map(a => ({
                    ...a,
                    compressedGB: a.recordBytesGB.toFixed(2)
                }));
            }
            
            // Update KPIs
            document.getElementById('compressionRatio').textContent = compressionRatio || 'N/A';
            document.getElementById('totalRecordBytes').textContent = totalRecordBytesGB.toFixed(1) + ' GB';
            document.getElementById('capacityUtilization').textContent = utilizationPercent ? utilizationPercent + '%' : 'N/A';
            
            // Update KPI subtexts
            if (compressionRatio) {
                document.getElementById('compressionRatioSubtext').textContent = 
                    capacityData && capacityData.isAveraged 
                        ? `1 GB stored : ${compressionRatio} GB ingested (avg)` 
                        : `1 GB stored : ${compressionRatio} GB ingested`;
            }
            
            if (utilizationPercent) {
                document.getElementById('capacityUtilizationSubtext').textContent = 
                    capacityData && capacityData.isAveraged 
                        ? `Of reserved capacity (avg)` 
                        : `Of reserved capacity`;
            }
            
            // Generate charts
            this.renderStackedBarChart(compressedData, capacityData ? capacityData.reserved : null);
            this.renderSensorBarChart(compressedData);
            this.renderDataTable(compressedData, capacityData !== null);
            
            document.getElementById('crsLoading').style.display = 'none';
            document.getElementById('crsResults').style.display = 'block';
            
        } catch (error) {
            alert('Error generating report: ' + error.message);
            document.getElementById('crsLoading').style.display = 'none';
        }
    }

    // Render stacked horizontal bar chart
    renderStackedBarChart(data, reservedCapacity) {
        const canvas = document.getElementById('stackedBarChart');
        const ctx = canvas.getContext('2d');
        
        // Destroy existing chart
        if (this.state.chartInstances.stacked) {
            this.state.chartInstances.stacked.destroy();
        }
        
        const consumed = data.reduce((sum, d) => sum + parseFloat(d.compressedGB), 0);
        
        const datasets = data
            .filter(d => parseFloat(d.compressedGB) > 0)
            .map((d, i) => ({
                label: d.name,
                data: [parseFloat(d.compressedGB)],
                backgroundColor: this.EH_COLORS[i % this.EH_COLORS.length]
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
        
        this.state.chartInstances.stacked = new Chart(ctx, {
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
                    y: { 
                        stacked: true,
                        display: false
                    }
                },
                plugins: {
                    legend: { position: 'bottom' }
                }
            }
        });
    }

    // Render vertical bar chart
    renderSensorBarChart(data) {
        const canvas = document.getElementById('sensorBarChart');
        const ctx = canvas.getContext('2d');
        
        if (this.state.chartInstances.bar) {
            this.state.chartInstances.bar.destroy();
        }
        
        const sortedData = [...data].sort((a, b) => parseFloat(b.compressedGB) - parseFloat(a.compressedGB));
        const labels = sortedData.map(d => d.name);
        const values = sortedData.map(d => parseFloat(d.compressedGB));
        
        this.state.chartInstances.bar = new Chart(ctx, {
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
                        title: { display: true, text: 'Utilization (GB)' }
                    }
                },
                plugins: {
                    legend: { display: false }
                }
            }
        });
    }

    // Render data table
    renderDataTable(data, hasCompression) {
        const tbody = document.getElementById('crsDataTableBody');
        tbody.innerHTML = '';
        
        // Add column header if needed
        const thead = document.getElementById('crsDataTable').querySelector('thead tr');
        const existingHeaders = thead.children.length;
        if (hasCompression && existingHeaders === 3) {
            const th = document.createElement('th');
            th.textContent = 'After Compression (GB)';
            thead.appendChild(th);
        } else if (!hasCompression && existingHeaders === 4) {
            thead.removeChild(thead.lastElementChild);
        }
        
        data.forEach(item => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${item.name}</td>
                <td>${item.model}</td>
                <td>${item.recordBytesGB}</td>
                ${hasCompression ? `<td>${item.compressedGB}</td>` : ''}
            `;
            tbody.appendChild(row);
        });
        
        // Add total row
        const totalRow = document.createElement('tr');
        totalRow.style.fontWeight = 'bold';
        totalRow.style.borderTop = '2px solid var(--border-color)';
        const totalRecordBytes = data.reduce((sum, d) => sum + d.recordBytesGB, 0);
        const totalCompressed = data.reduce((sum, d) => sum + parseFloat(d.compressedGB), 0).toFixed(2);
        totalRow.innerHTML = `
            <td colspan="2">TOTAL</td>
            <td>${totalRecordBytes}</td>
            ${hasCompression ? `<td>${totalCompressed}</td>` : ''}
        `;
        tbody.appendChild(totalRow);
    }

    setupEventListeners() {
        // Period selection buttons
        document.querySelectorAll('.crs-period-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.crs-period-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.state.selectedPeriod = btn.dataset.period;
                this.updateCapacityInputOptions();
            });
        });

        // Capacity input method buttons
        document.querySelectorAll('.capacity-input-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.capacity-input-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.state.inputMethod = btn.dataset.input;
                
                if (this.state.inputMethod === 'manual') {
                    document.getElementById('manualCapacityInput').style.display = 'block';
                    document.getElementById('csvCapacityInput').style.display = 'none';
                } else {
                    document.getElementById('manualCapacityInput').style.display = 'none';
                    document.getElementById('csvCapacityInput').style.display = 'block';
                }
            });
        });

        // CSV file upload
        document.getElementById('csvFileInput').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    this.state.csvData = this.parseCSV(event.target.result);
                    
                    const summary = document.getElementById('csvSummary');
                    summary.innerHTML = `
                        <strong>${this.state.csvData.length} records loaded</strong><br>
                        Date range: ${this.state.csvData[this.state.csvData.length - 1].date} to ${this.state.csvData[0].date}<br>
                        Avg Utilized: ${(this.state.csvData.reduce((s, d) => s + d.utilized, 0) / this.state.csvData.length).toFixed(1)} GB<br>
                        Avg Reserved: ${(this.state.csvData.reduce((s, d) => s + d.reserved, 0) / this.state.csvData.length).toFixed(1)} GB
                    `;
                    document.getElementById('csvPreview').style.display = 'block';
                } catch (error) {
                    alert(`Error parsing CSV: ${error.message}`);
                }
            };
            reader.readAsText(file);
        });

        // Generate report button
        document.getElementById('generateCrsReport').addEventListener('click', () => this.generateCRSReport());
    }

    getTemplate() {
        return `
            <div class="mb-6">
                <h2 class="text-2xl font-bold" style="color: var(--sapphire);">Records Report</h2>
                <p class="mt-2" style="color: var(--text-muted);">Analyze record storage capacity and compression ratios</p>
            </div>

            <!-- Configuration Section -->
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                <!-- Time Period Selection -->
                <div class="p-6 rounded-lg" style="background-color: var(--bg-card); border: 1px solid var(--border-color);">
                    <h3 class="text-lg font-semibold mb-4" style="color: var(--text-primary);">Time Period</h3>
                    <div class="space-y-3">
                        <button class="crs-period-btn w-full text-left px-4 py-3 rounded border active" data-period="yesterday">
                            <div class="font-semibold">Yesterday</div>
                            <div class="text-xs" style="color: var(--text-muted);">Previous day's data</div>
                        </button>
                        <button class="crs-period-btn w-full text-left px-4 py-3 rounded border" data-period="week">
                            <div class="font-semibold">Last 7 Days</div>
                            <div class="text-xs" style="color: var(--text-muted);">Weekly trend analysis</div>
                        </button>
                        <button class="crs-period-btn w-full text-left px-4 py-3 rounded border" data-period="month">
                            <div class="font-semibold">Last 30 Days</div>
                            <div class="text-xs" style="color: var(--text-muted);">Monthly overview</div>
                        </button>
                    </div>
                </div>

                <!-- Capacity Data Input -->
                <div class="p-6 rounded-lg" style="background-color: var(--bg-card); border: 1px solid var(--border-color);">
                    <h3 class="text-lg font-semibold mb-4" style="color: var(--text-primary);">Capacity Data (Optional)</h3>
                    <p class="text-sm mb-4" style="color: var(--text-muted);">Provide capacity data to calculate compression ratios. Leave blank to view raw record bytes only.</p>
                    
                    <!-- Input Method Selection -->
                    <div id="capacityInputSection" class="mb-4">
                        <div class="flex gap-3 mb-4">
                            <button class="capacity-input-btn flex-1 px-4 py-2 rounded border active" data-input="manual">
                                Manual Entry
                            </button>
                            <button class="capacity-input-btn flex-1 px-4 py-2 rounded border" data-input="csv">
                                CSV Upload
                            </button>
                        </div>
                    </div>

                    <!-- Manual Input Fields -->
                    <div id="manualCapacityInput" class="space-y-3">
                        <div>
                            <label class="block text-sm font-medium mb-2" style="color: var(--text-secondary);">Reserved Capacity (GB)</label>
                            <input type="number" id="reservedCapacity" placeholder="e.g., 1500" class="w-full px-3 py-2 rounded border">
                        </div>
                        <div>
                            <label class="block text-sm font-medium mb-2" style="color: var(--text-secondary);">Utilized Capacity (GB)</label>
                            <input type="number" id="utilizedCapacity" placeholder="e.g., 817" class="w-full px-3 py-2 rounded border">
                            <p class="text-xs mt-1" style="color: var(--text-muted);">From your data lake (BigQuery/LogScale/Elastic)</p>
                        </div>
                    </div>

                    <!-- CSV Upload Fields -->
                    <div id="csvCapacityInput" class="space-y-3" style="display: none;">
                        <div>
                            <label class="block text-sm font-medium mb-2" style="color: var(--text-secondary);">Upload Usage CSV</label>
                            <input type="file" id="csvFileInput" accept=".csv" class="w-full px-3 py-2 rounded border">
                            <p class="text-xs mt-1" style="color: var(--text-muted);">CSV with "Summary Date UTC", "Utilized", and "Reserved" columns</p>
                        </div>
                        <div id="csvPreview" style="display: none;">
                            <p class="text-sm font-medium mb-2" style="color: var(--text-secondary);">Parsed Data:</p>
                            <div class="p-3 rounded text-xs" style="background-color: var(--bg-subtle);">
                                <div id="csvSummary"></div>
                            </div>
                        </div>
                    </div>

                    <!-- CRS Trend Analysis Tool Link -->
                    <div class="mt-4 pt-4" style="border-top: 1px solid var(--border-color);">
                        <a href="https://thomaswde.github.io/crs-report/" target="_blank" rel="noopener noreferrer" class="btn-primary w-full px-4 py-2 rounded font-semibold flex items-center justify-center gap-2" style="display: flex;">
                            <span>Open CRS Trend Analysis Tool</span>
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                        </a>
                    </div>
                </div>
            </div>

            <!-- Generate Report Button -->
            <div class="mb-6">
                <button id="generateCrsReport" class="btn-primary px-8 py-3 rounded font-semibold text-lg">
                    Generate Report
                </button>
            </div>

            <!-- Loading State -->
            <div id="crsLoading" class="text-center py-20" style="display: none;">
                <div class="spinner mx-auto mb-4"></div>
                <p style="color: var(--text-muted);">Fetching appliance data and calculating metrics...</p>
            </div>

            <!-- Results Section -->
            <div id="crsResults" style="display: none;">
                <!-- KPI Cards -->
                <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
                    <div class="p-6 rounded-lg text-center" style="background-color: var(--bg-card); border: 2px solid var(--cyan);">
                        <div class="text-sm font-medium mb-2" style="color: var(--text-muted);">Compression Ratio</div>
                        <div id="compressionRatio" class="text-4xl font-bold" style="color: var(--cyan);">-</div>
                        <div id="compressionRatioSubtext" class="text-xs mt-2" style="color: var(--text-muted);">1 GB stored : X GB ingested</div>
                    </div>
                    <div class="p-6 rounded-lg text-center" style="background-color: var(--bg-card); border: 2px solid var(--magenta);">
                        <div class="text-sm font-medium mb-2" style="color: var(--text-muted);">Total Record Bytes</div>
                        <div id="totalRecordBytes" class="text-4xl font-bold" style="color: var(--magenta);">-</div>
                        <div class="text-xs mt-2" style="color: var(--text-muted);">From all EDA appliances</div>
                    </div>
                    <div class="p-6 rounded-lg text-center" style="background-color: var(--bg-card); border: 2px solid var(--tangerine);">
                        <div class="text-sm font-medium mb-2" style="color: var(--text-muted);">Capacity Utilization</div>
                        <div id="capacityUtilization" class="text-4xl font-bold" style="color: var(--tangerine);">-</div>
                        <div id="capacityUtilizationSubtext" class="text-xs mt-2" style="color: var(--text-muted);">Of reserved capacity</div>
                    </div>
                </div>

                <!-- Charts -->
                <div class="space-y-6">
                    <!-- Stacked Bar Chart -->
                    <div class="p-6 rounded-lg" style="background-color: var(--bg-card); border: 1px solid var(--border-color);">
                        <h3 id="stackedChartTitle" class="text-lg font-semibold mb-4" style="color: var(--text-primary);">Capacity Consumption by Sensor</h3>
                        <div style="position: relative; height: 150px;">
                            <canvas id="stackedBarChart"></canvas>
                        </div>
                    </div>

                    <!-- Bar Chart -->
                    <div class="p-6 rounded-lg" style="background-color: var(--bg-card); border: 1px solid var(--border-color);">
                        <h3 id="barChartTitle" class="text-lg font-semibold mb-4" style="color: var(--text-primary);">Utilization by Sensor</h3>
                        <div style="position: relative; height: 400px;">
                            <canvas id="sensorBarChart"></canvas>
                        </div>
                    </div>

                    <!-- Data Table -->
                    <div class="p-6 rounded-lg" style="background-color: var(--bg-card); border: 1px solid var(--border-color);">
                        <h3 class="text-lg font-semibold mb-4" style="color: var(--text-primary);">Detailed Breakdown</h3>
                        <div class="table-container rounded-lg overflow-hidden">
                            <table id="crsDataTable">
                                <thead>
                                    <tr>
                                        <th>Sensor Name</th>
                                        <th>Platform</th>
                                        <th>Record Bytes (GB)</th>
                                    </tr>
                                </thead>
                                <tbody id="crsDataTableBody">
                                    <!-- Populated dynamically -->
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    activate() {
        // Setup event listeners when module is activated
        this.setupEventListeners();
        
        // Set module title
        document.getElementById('ribbonModuleTitle').textContent = 'Records Report';
        
        // Set default active states
        setTimeout(() => {
            const periodBtn = document.querySelector('.crs-period-btn[data-period="yesterday"]');
            const capacityBtn = document.querySelector('.capacity-input-btn[data-input="manual"]');
            if (periodBtn) periodBtn.classList.add('active');
            if (capacityBtn) capacityBtn.classList.add('active');
            
            // Initialize capacity input options
            this.updateCapacityInputOptions();
        }, 100);
    }

    deactivate() {
        // Clean up charts when switching modules
        if (this.state.chartInstances.stacked) {
            this.state.chartInstances.stacked.destroy();
            this.state.chartInstances.stacked = null;
        }
        if (this.state.chartInstances.bar) {
            this.state.chartInstances.bar.destroy();
            this.state.chartInstances.bar = null;
        }
    }
}

// Export for global use
window.ApplianceMetrics = ApplianceMetrics;