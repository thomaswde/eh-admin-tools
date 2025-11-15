class AuditLog {
    constructor() {
        this.state = {
            rawData: [],
            operations: {},
            charts: {},
            shouldStop: false,
            actualDateRange: []
        };
    }

    async load() {
        if (!window.auth.isConnected) {
            alert('Please connect to your ExtraHop instance first');
            return;
        }

        const loadBtn = document.getElementById('loadAuditLog');
        const stopBtn = document.getElementById('stopAuditLogLoad');
        const loadingStatus = document.getElementById('auditLogLoadingStatus');
        const loadingText = document.getElementById('auditLogLoadingText');
        const batchSize = parseInt(document.getElementById('auditLogBatchSize').value);
        const lookbackDays = parseInt(document.getElementById('auditLogLookback').value);
        
        try {
            this.state.shouldStop = false;
            loadBtn.disabled = true;
            loadBtn.style.display = 'none';
            stopBtn.style.display = 'block';
            loadingStatus.style.display = 'block';
            
            document.getElementById('auditLogChartsContainer').style.display = 'none';

            // Clear previous data
            this.state.rawData = [];
            this.state.operations = {};
            
            // Calculate cutoff date
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);
            cutoffDate.setHours(0, 0, 0, 0);
            
            // Fetch audit log data in batches
            let offset = 0;
            let hasMore = true;
            let totalFetched = 0;

            while (hasMore && !this.state.shouldStop) {
                loadingText.textContent = `Loading audit log entries... (${totalFetched} fetched)`;
                
                const batch = await window.apiClient.getAuditLog(batchSize, offset);
                
                if (!batch || batch.length === 0) {
                    hasMore = false;
                    break;
                }

                // Filter by date
                for (const item of batch) {
                    const itemDate = new Date(item.occur_time);
                    if (itemDate >= cutoffDate) {
                        this.state.rawData.push(item);
                    }
                }

                totalFetched += batch.length;
                offset += batchSize;

                if (batch.length < batchSize) {
                    hasMore = false;
                }

                // Small delay to prevent overwhelming
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            if (this.state.shouldStop) {
                this.showStatus(`Loading stopped by user. Loaded ${this.state.rawData.length} entries.`, 'warning');
            }

            loadingText.textContent = 'Processing audit log data...';

            // Process the data
            this.processData();
            this.generateCharts();
            
            if (!this.state.shouldStop) {
                document.getElementById('auditLogChartsContainer').style.display = 'block';
                document.getElementById('exportAuditLogSection').style.display = 'block';
                this.showStatus(`Successfully loaded ${this.state.rawData.length} audit log entries`, 'success');
            }

        } catch (error) {
            this.showStatus('Error loading audit log: ' + error.message, 'error');
        } finally {
            loadBtn.disabled = false;
            loadBtn.style.display = 'block';
            stopBtn.style.display = 'none';
            loadingStatus.style.display = 'none';
        }
    }


    processData() {
        // Group entries by operation type
        this.state.operations = {};
        
        this.state.rawData.forEach(item => {
            const entry = item.body;
            const operation = entry.operation || 'Unknown';
            
            if (!this.state.operations[operation]) {
                this.state.operations[operation] = [];
            }
            
            this.state.operations[operation].push({
                id: item.id,
                time: item.occur_time,
                user: entry.user || 'System',
                ...entry
            });
        });

        // Sort operations by count
        Object.keys(this.state.operations).forEach(op => {
            this.state.operations[op].sort((a, b) => b.time - a.time);
        });

        // Create actual date range for charts
        if (this.state.rawData.length > 0) {
            const times = this.state.rawData.map(item => item.occur_time);
            const minTime = Math.min(...times);
            const maxTime = Math.max(...times);
            
            this.state.actualDateRange = this.generateDateRange(minTime, maxTime);
        }
    }

    generateDateRange(startTime, endTime) {
        const range = [];
        const start = new Date(startTime);
        const end = new Date(endTime);
        
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            range.push(d.toISOString().split('T')[0]);
        }
        
        return range;
    }

    generateCharts() {
        // Destroy existing charts
        Object.keys(this.state.charts).forEach(key => {
            if (this.state.charts[key]) {
                this.state.charts[key].destroy();
                this.state.charts[key] = null;
            }
        });

        // Chart 1: Logs per Event Type
        this.generateEventTypesChart();

        // Chart 2, 3, 4: Login-specific charts (only if Login events exist)
        if (this.state.operations['Login']) {
            this.generateLoginPerDayChart();
            this.generateLoginByUserChart();
            document.getElementById('chartLoginPerDayContainer').style.display = 'block';
            document.getElementById('chartLoginByUserContainer').style.display = 'block';
        } else {
            document.getElementById('chartLoginPerDayContainer').style.display = 'none';
            document.getElementById('chartLoginByUserContainer').style.display = 'none';
        }

        // Chart 5: All Activity per Day by User
        this.generateActivityByUserChart();
        document.getElementById('chartActivityByUserContainer').style.display = 'block';
    }

    generateEventTypesChart() {
        const ctx = document.getElementById('chartEventTypes');
        
        // Sort operations by count
        const operationCounts = Object.keys(this.state.operations).map(op => ({
            operation: op,
            count: this.state.operations[op].length
        })).sort((a, b) => b.count - a.count);

        const labels = operationCounts.map(item => item.operation);
        const data = operationCounts.map(item => item.count);

        this.state.charts.eventTypes = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Number of Events',
                    data: data,
                    backgroundColor: 'rgba(54, 162, 235, 0.6)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true }
                },
                plugins: {
                    legend: { display: false }
                }
            }
        });
    }

    generateLoginPerDayChart() {
        const ctx = document.getElementById('chartLoginPerDay');
        
        const loginsByDay = {};
        this.state.operations['Login'].forEach(entry => {
            const date = new Date(entry.time).toISOString().split('T')[0];
            loginsByDay[date] = (loginsByDay[date] || 0) + 1;
        });

        const labels = this.state.actualDateRange;
        const data = labels.map(date => loginsByDay[date] || 0);

        this.state.charts.loginPerDay = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Login Events',
                    data: data,
                    backgroundColor: 'rgba(255, 99, 132, 0.6)',
                    borderColor: 'rgba(255, 99, 132, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true }
                },
                plugins: {
                    legend: { display: false }
                }
            }
        });
    }

    generateLoginByUserChart() {
        const ctx = document.getElementById('chartLoginByUser');
        
        const loginsByUser = {};
        this.state.operations['Login'].forEach(entry => {
            const user = entry.user || 'Unknown';
            loginsByUser[user] = (loginsByUser[user] || 0) + 1;
        });

        const labels = Object.keys(loginsByUser).sort((a, b) => loginsByUser[b] - loginsByUser[a]);
        const data = labels.map(user => loginsByUser[user]);

        this.state.charts.loginByUser = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Login Count',
                    data: data,
                    backgroundColor: 'rgba(75, 192, 192, 0.6)',
                    borderColor: 'rgba(75, 192, 192, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true }
                },
                plugins: {
                    legend: { display: false }
                }
            }
        });
    }

    generateActivityByUserChart() {
        const ctx = document.getElementById('chartActivityByUser');
        
        // Build user activity by day
        const userActivityByDay = {};
        
        Object.keys(this.state.operations).forEach(operation => {
            this.state.operations[operation].forEach(entry => {
                const user = entry.user || 'System';
                const date = new Date(entry.time).toISOString().split('T')[0];
                
                if (!userActivityByDay[user]) {
                    userActivityByDay[user] = {};
                }
                
                userActivityByDay[user][date] = (userActivityByDay[user][date] || 0) + 1;
            });
        });

        // Create datasets for each user
        const users = Object.keys(userActivityByDay).sort();
        const colors = [
            'rgba(255, 99, 132, 0.6)',
            'rgba(54, 162, 235, 0.6)',
            'rgba(255, 205, 86, 0.6)',
            'rgba(75, 192, 192, 0.6)',
            'rgba(153, 102, 255, 0.6)',
            'rgba(255, 159, 64, 0.6)'
        ];

        const datasets = users.map((user, index) => ({
            label: user,
            data: this.state.actualDateRange.map(date => userActivityByDay[user][date] || 0),
            backgroundColor: colors[index % colors.length],
            borderColor: colors[index % colors.length].replace('0.6', '1'),
            borderWidth: 1
        }));

        this.state.charts.activityByUser = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: this.state.actualDateRange,
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { stacked: true },
                    y: { 
                        stacked: true,
                        beginAtZero: true 
                    }
                },
                plugins: {
                    legend: { position: 'top' }
                }
            }
        });
    }

    exportCsv() {
        if (this.state.rawData.length === 0) {
            alert('No audit log data to export');
            return;
        }

        const operationType = document.getElementById('exportOperationType').value;
        let dataToExport = [];

        if (operationType === 'all') {
            dataToExport = this.state.rawData;
        } else {
            const operationEntries = this.state.operations[operationType];
            if (!operationEntries || operationEntries.length === 0) {
                alert(`No entries found for operation type: ${operationType}`);
                return;
            }
            
            dataToExport = operationEntries.map(entry => ({
                id: entry.id,
                occur_time: entry.time,
                body: entry
            }));
        }

        // Prepare CSV data
        const headers = ['ID', 'Date/Time', 'Operation', 'User', 'Details'];
        const rows = [headers];

        dataToExport.forEach(item => {
            const entry = item.body;
            const dateObj = new Date(item.occur_time);
            const dateTime = this.formatDateTime(dateObj);
            
            const details = JSON.stringify(entry).replace(/"/g, '""');
            
            rows.push([
                item.id,
                dateTime,
                entry.operation || '',
                entry.user || 'unknown',
                `"${details}"`
            ]);
        });

        // Convert to CSV string
        const csvContent = rows.map(row => row.join(',')).join('\n');

        // Download
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        
        const filename = operationType === 'all' 
            ? `audit_log_all_${this.formatDate(new Date())}.csv`
            : `audit_log_${operationType.replace(/\s+/g, '_')}_${this.formatDate(new Date())}.csv`;
        
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        const statusMsg = operationType === 'all' 
            ? `CSV export completed (${dataToExport.length} entries)`
            : `CSV export completed for ${operationType} (${dataToExport.length} entries)`;
        this.showStatus(statusMsg, 'success');
    }

    showStatus(message, type = 'success') {
        const statusDiv = document.getElementById('auditLogStatus');
        const statusText = document.getElementById('auditLogStatusText');
        
        statusDiv.style.display = 'block';
        statusText.textContent = message;
        
        const colors = {
            success: { bg: '#dcfce7', border: '#166534', text: '#166534' },
            warning: { bg: '#fef3c7', border: '#92400e', text: '#92400e' },
            error: { bg: '#fee2e2', border: '#dc2626', text: '#dc2626' }
        };
        
        const color = colors[type] || colors.success;
        statusDiv.querySelector('div').style.backgroundColor = color.bg;
        statusDiv.querySelector('div').style.borderColor = color.border;
        statusText.style.color = color.text;
        
        setTimeout(() => {
            statusDiv.style.display = 'none';
        }, 5000);
    }

    formatDate(date) {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const year = String(date.getFullYear()).slice(-2);
        return `${month}-${day}-${year}`;
    }

    formatDateTime(date) {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const year = String(date.getFullYear()).slice(-2);
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${month}-${day}-${year} ${hours}:${minutes}:${seconds}`;
    }

    stop() {
        this.state.shouldStop = true;
        document.getElementById('auditLogLoadingText').textContent = 'Stopping...';
    }

    setupEventListeners() {
        // Load button
        document.getElementById('loadAuditLog').addEventListener('click', () => this.load());
        
        // Stop button
        document.getElementById('stopAuditLogLoad').addEventListener('click', () => this.stop());
        
        // Export button
        document.getElementById('exportAuditLogCsv').addEventListener('click', () => this.exportCsv());
    }

    getTemplate() {
        return `
            <div class="mb-6">
                <h2 class="text-2xl font-bold" style="color: var(--sapphire);">Audit Log Analysis</h2>
                <p class="mt-2" style="color: var(--text-muted);">Analyze audit log entries, user activity, and operation trends</p>
            </div>

            <!-- Configuration Section -->
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                <!-- Settings -->
                <div class="p-6 rounded-lg" style="background-color: var(--bg-card); border: 1px solid var(--border-color);">
                    <h3 class="text-lg font-semibold mb-4" style="color: var(--text-primary);">Settings</h3>
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm font-semibold mb-2" style="color: var(--text-secondary);">Lookback Period (Days)</label>
                            <input type="number" id="auditLogLookback" value="90" min="1" max="90" 
                                class="w-full px-3 py-2 border rounded" style="background-color: var(--bg-input); border-color: var(--border-color);">
                            <p class="text-xs mt-1" style="color: var(--text-muted);">Maximum 90 days (ExtraHop audit log retention)</p>
                        </div>
                        <div>
                            <label class="block text-sm font-semibold mb-2" style="color: var(--text-secondary);">Batch Size</label>
                            <input type="number" id="auditLogBatchSize" value="100" min="10" max="1000" 
                                class="w-full px-3 py-2 border rounded" style="background-color: var(--bg-input); border-color: var(--border-color);">
                            <p class="text-xs mt-1" style="color: var(--text-muted);">Number of entries to fetch per request</p>
                        </div>
                    </div>
                </div>

                <!-- Actions -->
                <div class="p-6 rounded-lg" style="background-color: var(--bg-card); border: 1px solid var(--border-color);">
                    <h3 class="text-lg font-semibold mb-4" style="color: var(--text-primary);">Actions</h3>
                    <div class="space-y-3">
                        <button id="loadAuditLog" class="btn-primary w-full px-4 py-3 rounded font-semibold">
                            Load Audit Log
                        </button>
                        <button id="stopAuditLogLoad" class="btn-danger w-full px-4 py-3 rounded font-semibold" style="display: none;">
                            Stop Loading
                        </button>
                        <div id="exportAuditLogSection" style="display: none;">
                            <label class="block text-sm font-semibold mb-2" style="color: var(--text-secondary);">Export Operation Type</label>
                            <select id="exportOperationType" class="w-full px-3 py-2 border rounded mb-2" style="background-color: var(--bg-input); border-color: var(--border-color);">
                                <option value="all">All Operations</option>
                            </select>
                            <button id="exportAuditLogCsv" class="btn-secondary w-full px-4 py-3 rounded font-semibold">
                                Export to CSV
                            </button>
                        </div>
                    </div>
                    <div id="auditLogLoadingStatus" class="mt-4 text-sm" style="color: var(--text-muted); display: none;">
                        <div class="flex items-center">
                            <div class="animate-spin mr-2" style="width: 16px; height: 16px; border: 2px solid var(--cyan); border-top-color: transparent; border-radius: 50%;"></div>
                            <span id="auditLogLoadingText">Loading...</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Status Display -->
            <div id="auditLogStatus" style="display: none;" class="mb-6">
                <div class="p-4 rounded-lg" style="background-color: var(--bg-card); border: 1px solid var(--border-color);">
                    <div class="text-sm font-semibold" style="color: var(--text-primary);" id="auditLogStatusText"></div>
                </div>
            </div>

            <!-- Loading State -->
            <div id="auditLogLoading" class="text-center py-20" style="display: none;">
                <div class="spinner mx-auto mb-4"></div>
                <p style="color: var(--text-muted);">Loading audit log data...</p>
            </div>

            <!-- Charts Container -->
            <div id="auditLogChartsContainer" style="display: none;">
                
                <!-- Chart 1: Logs per Event Type -->
                <div class="mb-8 p-6 rounded-lg" style="background-color: var(--bg-card); border: 1px solid var(--border-color);">
                    <h3 class="text-xl font-semibold mb-4" style="color: var(--sapphire);">Logs per Event Type</h3>
                    <div style="position: relative; height: 500px;">
                        <canvas id="chartEventTypes"></canvas>
                    </div>
                </div>

                <!-- Chart 2: Login Events per Day -->
                <div id="chartLoginPerDayContainer" class="mb-8 p-6 rounded-lg" style="background-color: var(--bg-card); border: 1px solid var(--border-color); display: none;">
                    <h3 class="text-xl font-semibold mb-4" style="color: var(--sapphire);">Login Events per Day (All Users)</h3>
                    <div style="position: relative; height: 400px;">
                        <canvas id="chartLoginPerDay"></canvas>
                    </div>
                </div>

                <!-- Chart 3: Total Login Events by Username -->
                <div id="chartLoginByUserContainer" class="mb-8 p-6 rounded-lg" style="background-color: var(--bg-card); border: 1px solid var(--border-color); display: none;">
                    <h3 class="text-xl font-semibold mb-4" style="color: var(--sapphire);">Total Login Events by Username</h3>
                    <div style="position: relative; height: 500px;">
                        <canvas id="chartLoginByUser"></canvas>
                    </div>
                </div>

                <!-- Chart 4: All Activity per Day by User -->
                <div id="chartActivityByUserContainer" class="mb-8 p-6 rounded-lg" style="background-color: var(--bg-card); border: 1px solid var(--border-color); display: none;">
                    <h3 class="text-xl font-semibold mb-4" style="color: var(--sapphire);">All Activity per Day Broken Down by User</h3>
                    <div style="position: relative; height: 500px;">
                        <canvas id="chartActivityByUser"></canvas>
                    </div>
                </div>
            </div>
        `;
    }

    activate() {
        // Setup event listeners when module is activated
        this.setupEventListeners();
        
        // Set module title
        document.getElementById('ribbonModuleTitle').textContent = 'Audit Log Analyzer';
    }

    deactivate() {
        // Clean up charts when switching modules
        Object.keys(this.state.charts).forEach(key => {
            if (this.state.charts[key]) {
                this.state.charts[key].destroy();
                this.state.charts[key] = null;
            }
        });
        
        // Stop any ongoing loads
        this.state.shouldStop = true;
    }
}

// Export for global use
window.AuditLog = AuditLog;