class ApplianceMetrics {
    constructor() {
        this.state = {
            chartInstances: { stacked: null, bar: null },
            appliances: [],
            selectedPeriod: 1,
            isCapacity: true
        };
    }

    async loadData(dateRange) {
        const appliances = await window.apiClient.getAppliances();
        
        let totalBytes = 0;
        const applianceData = [];
        const isCapacity = this.state.isCapacity;

        const to = Math.floor(Date.now() / 1000);
        const from = to - (dateRange * 24 * 60 * 60);

        for (const appliance of appliances) {
            let metric = isCapacity ? 'node:disk_used_bytes' : 'node:compressed_rx_bytes';
            let totalMetric = 'appliance:system_record_bytes';

            if (appliance.record_type === 'ECA' || appliance.record_type === 'ExtraHop Command Appliance') {
                metric = isCapacity ? 'node:disk_used_bytes' : 'node:compressed_tx_bytes';
                totalMetric = 'appliance:system_record_bytes';
            }

            const metricRequest = {
                metric_category: 'node',
                metric_specs: [{ name: metric }],
                from: from * 1000,
                until: to * 1000,
                limit: 1,
                node_ids: [appliance.node_id]
            };

            try {
                const metricResponse = await window.apiClient.request('/metrics/total', {
                    method: 'POST',
                    body: JSON.stringify(metricRequest)
                });

                let bytesValue = 0;
                if (metricResponse.stats && metricResponse.stats.length > 0) {
                    bytesValue = metricResponse.stats[0].values.reduce((sum, val) => sum + val.value, 0);
                }

                applianceData.push({
                    name: appliance.display_name,
                    bytes: bytesValue,
                    type: appliance.record_type
                });

                totalBytes += bytesValue;
            } catch (error) {
                console.error(`Failed to fetch metrics for ${appliance.display_name}:`, error);
            }
        }

        return { applianceData, totalBytes };
    }

    async fetchCRSData(dateRange) {
        if (!window.auth.isConnected) {
            alert('Please connect to your ExtraHop instance first');
            return;
        }

        document.getElementById('crsLoading').style.display = 'block';
        document.getElementById('crsResults').style.display = 'none';

        try {
            const { applianceData, totalBytes } = await this.loadData(dateRange);
            
            // Calculate compression ratio and render charts
            const compressionRatio = totalBytes > 0 ? (totalBytes / 1000000).toFixed(2) : '0.00';
            
            this.renderCharts(applianceData);
            this.renderDataTable(applianceData, compressionRatio);
            
            document.getElementById('crsLoading').style.display = 'none';
            document.getElementById('crsResults').style.display = 'block';

        } catch (error) {
            alert('Error fetching data: ' + error.message);
            document.getElementById('crsLoading').style.display = 'none';
        }
    }

    renderCharts(data) {
        this.renderStackedBarChart(data);
        this.renderSensorBarChart(data);
    }

    renderStackedBarChart(data) {
        const canvas = document.getElementById('stackedBarChart');
        const ctx = canvas.getContext('2d');
        
        // Destroy existing chart
        if (this.state.chartInstances.stacked) {
            this.state.chartInstances.stacked.destroy();
        }

        const datasets = data.map((item, index) => ({
            label: item.name,
            data: [item.bytes],
            backgroundColor: `hsl(${(index * 360) / data.length}, 70%, 50%)`,
            borderColor: `hsl(${(index * 360) / data.length}, 70%, 40%)`,
            borderWidth: 1
        }));

        this.state.chartInstances.stacked = new Chart(ctx, {
            type: 'bar',
            data: { labels: ['Capacity'], datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { stacked: true },
                    y: { 
                        stacked: true,
                        beginAtZero: true,
                        ticks: {
                            callback: function(value) {
                                return (value / 1e9).toFixed(1) + ' GB';
                            }
                        }
                    }
                },
                plugins: {
                    legend: { position: 'top' }
                }
            }
        });
    }

    renderSensorBarChart(data) {
        const canvas = document.getElementById('sensorBarChart');
        const ctx = canvas.getContext('2d');
        
        if (this.state.chartInstances.bar) {
            this.state.chartInstances.bar.destroy();
        }

        const labels = data.map(item => item.name);
        const values = data.map(item => item.bytes);

        this.state.chartInstances.bar = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: this.state.isCapacity ? 'Capacity Used (GB)' : 'Record Bytes (GB)',
                    data: values,
                    backgroundColor: 'rgba(54, 162, 235, 0.6)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: function(value) {
                                return (value / 1e9).toFixed(1) + ' GB';
                            }
                        }
                    }
                },
                plugins: {
                    legend: { display: false }
                }
            }
        });
    }

    renderDataTable(data, compressionRatio) {
        const tableBody = document.getElementById('crsDataTableBody');
        tableBody.innerHTML = '';

        data.forEach(item => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td class="px-4 py-2">${item.name}</td>
                <td class="px-4 py-2">${item.type}</td>
                <td class="px-4 py-2">${(item.bytes / 1e9).toFixed(2)} GB</td>
            `;
            tableBody.appendChild(row);
        });

        document.getElementById('compressionRatio').textContent = compressionRatio + ' MB';
    }

    setupEventListeners() {
        // Period selection buttons
        document.querySelectorAll('.crs-period-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const period = parseInt(e.target.dataset.period);
                this.state.selectedPeriod = period;
                
                // Update button states
                document.querySelectorAll('.crs-period-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                
                // Fetch new data
                this.fetchCRSData(period);
            });
        });

        // Capacity input type buttons
        document.querySelectorAll('.capacity-input-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const isCapacity = e.target.dataset.type === 'capacity';
                this.state.isCapacity = isCapacity;
                
                // Update button states
                document.querySelectorAll('.capacity-input-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                
                // Update chart titles
                const stackedChartTitle = document.getElementById('stackedChartTitle');
                const barChartTitle = document.getElementById('barChartTitle');
                if (isCapacity) {
                    stackedChartTitle.textContent = 'Capacity Consumption by Sensor';
                    barChartTitle.textContent = 'Utilization by Sensor';
                } else {
                    stackedChartTitle.textContent = 'Record Bytes by Sensor';
                    barChartTitle.textContent = 'Record Bytes by Sensor';
                }
                
                // Fetch new data
                this.fetchCRSData(this.state.selectedPeriod);
            });
        });
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
                    
                    <!-- Input Method Toggle -->
                    <div class="mb-4">
                        <div class="flex gap-2">
                            <button id="manualInputBtn" class="capacity-input-btn flex-1 px-3 py-2 border rounded text-sm active">
                                Manual Input
                            </button>
                            <button id="csvInputBtn" class="capacity-input-btn flex-1 px-3 py-2 border rounded text-sm">
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
                                        <th>After Compression (GB)</th>
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
        document.getElementById('ribbonModuleTitle').textContent = 'Appliance Metrics';
        
        // Set default active states
        setTimeout(() => {
            const periodBtn = document.querySelector('.crs-period-btn[data-period="1"]');
            const capacityBtn = document.querySelector('.capacity-input-btn[data-type="capacity"]');
            if (periodBtn) periodBtn.classList.add('active');
            if (capacityBtn) capacityBtn.classList.add('active');
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