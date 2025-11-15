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

    activate() {
        // Setup event listeners when module is activated
        this.setupEventListeners();
        
        // Set module title
        document.getElementById('ribbonModuleTitle').textContent = 'Appliance Metrics';
        
        // Set default active states
        document.querySelector('.crs-period-btn[data-period="1"]').classList.add('active');
        document.querySelector('.capacity-input-btn[data-type="capacity"]').classList.add('active');
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