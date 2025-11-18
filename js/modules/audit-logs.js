// Audit Log Analysis Module

const auditLogState = {
    rawData: [],
    operations: {},
    dateRange: [],
    actualDateRange: [], // Actual dates that have data
    shouldStop: false,
    charts: {
        eventTypes: null,
        loginPerDay: null,
        loginByUser: null,
        activityByUser: null
    }
};

const ehColors = ['#7f2854', '#261f63', '#ec0089', '#00aaef', '#f05918', '#dae343'];

async function loadAuditLog() {
    if (!state.connected) {
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
        loadBtn.disabled = true;
        loadBtn.style.display = 'none';
        stopBtn.style.display = 'block';
        loadingStatus.style.display = 'block';
        auditLogState.shouldStop = false;
        
        // Build date range
        auditLogState.dateRange = [];
        const today = new Date();
        for (let i = 0; i < lookbackDays; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            auditLogState.dateRange.push(formatDate(date));
        }
        auditLogState.dateRange.reverse();

        const cutoffDate = auditLogState.dateRange[0];

        // Fetch audit log in batches
        auditLogState.rawData = [];
        let offset = 0;
        let hasMore = true;
        let totalFetched = 0;

        while (hasMore && !auditLogState.shouldStop) {
            loadingText.textContent = `Loading audit log entries... (${totalFetched} fetched)`;
            
            const batch = await window.apiClient.getAuditLog(batchSize, offset);
            
            if (!batch || batch.length === 0) {
                hasMore = false;
                break;
            }

            auditLogState.rawData.push(...batch);
            totalFetched += batch.length;
            
            if (batch.length < batchSize) {
                hasMore = false;
            }
            
            offset += batchSize;
        }

        if (auditLogState.shouldStop) {
            showAuditLogStatus(`Loading stopped by user. Loaded ${auditLogState.rawData.length} entries.`, 'warning');
        }

        loadingText.textContent = 'Processing audit log data...';

        // Process the data
        processAuditLogData(cutoffDate);

        // Populate operation type dropdown
        populateOperationTypeDropdown();

        // Generate charts
        loadingText.textContent = 'Generating charts...';
        generateAuditLogCharts();

        // Show status
        if (!auditLogState.shouldStop) {
            showAuditLogStatus(`Successfully loaded ${auditLogState.rawData.length} audit log entries`, 'success');
        }
        
        // Show charts and export
        document.getElementById('auditLogChartsContainer').style.display = 'block';
        document.getElementById('exportAuditLogSection').style.display = 'block';

    } catch (error) {
        showAuditLogStatus(`Error loading audit log: ${error.message}`, 'error');
    } finally {
        loadingStatus.style.display = 'none';
        loadBtn.disabled = false;
        loadBtn.style.display = 'block';
        stopBtn.style.display = 'none';
    }
}

function stopAuditLogLoad() {
    auditLogState.shouldStop = true;
    showAuditLogStatus('Stopping audit log load...', 'warning');
}

function processAuditLogData(cutoffDate) {
    auditLogState.operations = {};
    const datesWithData = new Set();

    for (const item of auditLogState.rawData) {
        const entry = { ...item.body };
        entry.id = item.id;
        entry.time = item.occur_time;
        
        const dateObj = new Date(entry.time);
        const dateStr = formatDate(dateObj);
        entry.datetime = formatDateTime(dateObj);
        
        // Filter by date range
        if (dateStr < cutoffDate) continue;

        // Track dates that have data
        datesWithData.add(dateStr);

        // Normalize operation names
        let operation = entry.operation;
        if (operation.startsWith('Remove fngr-')) {
            operation = 'Remove Node';
        } else if (operation.startsWith('Disable node')) {
            operation = 'Disable Node';
        } else if (operation.startsWith('Enable node')) {
            operation = 'Enable Node';
        }

        if (!auditLogState.operations[operation]) {
            auditLogState.operations[operation] = [];
        }
        auditLogState.operations[operation].push(entry);
    }

    // Build actual date range (only dates with data)
    auditLogState.actualDateRange = Array.from(datesWithData).sort();
}

function populateOperationTypeDropdown() {
    const select = document.getElementById('exportOperationType');
    select.innerHTML = '<option value="all">All Operations</option>';
    
    // Sort operations alphabetically
    const sortedOps = Object.keys(auditLogState.operations).sort();
    
    sortedOps.forEach(op => {
        const count = auditLogState.operations[op].length;
        const option = document.createElement('option');
        option.value = op;
        option.textContent = `${op} (${count} entries)`;
        select.appendChild(option);
    });
}

function generateAuditLogCharts() {
    // Destroy existing charts
    Object.keys(auditLogState.charts).forEach(key => {
        if (auditLogState.charts[key]) {
            auditLogState.charts[key].destroy();
            auditLogState.charts[key] = null;
        }
    });

    // Chart 1: Logs per Event Type
    generateEventTypesChart();

    // Chart 2, 3, 4: Login-specific charts (only if Login events exist)
    if (auditLogState.operations['Login']) {
        generateLoginPerDayChart();
        generateLoginByUserChart();
        document.getElementById('chartLoginPerDayContainer').style.display = 'block';
        document.getElementById('chartLoginByUserContainer').style.display = 'block';
    } else {
        document.getElementById('chartLoginPerDayContainer').style.display = 'none';
        document.getElementById('chartLoginByUserContainer').style.display = 'none';
    }

    // Chart 5: All Activity per Day by User
    generateActivityByUserChart();
    document.getElementById('chartActivityByUserContainer').style.display = 'block';
}

function generateEventTypesChart() {
    const ctx = document.getElementById('chartEventTypes');
    
    // Sort operations by count
    const sortedOps = Object.entries(auditLogState.operations)
        .map(([name, entries]) => ({ name, count: entries.length }))
        .sort((a, b) => a.count - b.count);

    const labels = sortedOps.map(op => op.name);
    const data = sortedOps.map(op => op.count);

    auditLogState.charts.eventTypes = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Number of Log Entries',
                data: data,
                backgroundColor: ehColors[0],
                borderColor: ehColors[0],
                borderWidth: 1
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                title: {
                    display: false
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Number of Events'
                    }
                }
            }
        }
    });
}

function generateLoginPerDayChart() {
    const ctx = document.getElementById('chartLoginPerDay');
    
    const loginsByDay = {};
    auditLogState.actualDateRange.forEach(date => {
        loginsByDay[date] = 0;
    });

    auditLogState.operations['Login'].forEach(log => {
        const dateObj = new Date(log.time);
        const dateStr = formatDate(dateObj);
        if (dateStr in loginsByDay) {
            loginsByDay[dateStr]++;
        }
    });

    const labels = Object.keys(loginsByDay);
    const data = Object.values(loginsByDay);

    auditLogState.charts.loginPerDay = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Login Events',
                data: data,
                backgroundColor: ehColors[0],
                borderColor: ehColors[0],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Number of Logins'
                    }
                },
                x: {
                    ticks: {
                        maxRotation: 45,
                        minRotation: 45
                    }
                }
            }
        }
    });
}

function generateLoginByUserChart() {
    const ctx = document.getElementById('chartLoginByUser');
    
    const loginsByUser = {};
    auditLogState.operations['Login'].forEach(log => {
        const user = log.user || 'unknown';
        loginsByUser[user] = (loginsByUser[user] || 0) + 1;
    });

    // Sort by count
    const sortedUsers = Object.entries(loginsByUser)
        .map(([user, count]) => ({ user, count }))
        .sort((a, b) => a.count - b.count);

    const labels = sortedUsers.map(u => u.user === 'unknown' ? 'API' : u.user);
    const data = sortedUsers.map(u => u.count);

    auditLogState.charts.loginByUser = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Login Count',
                data: data,
                backgroundColor: ehColors.slice(0, data.length),
                borderColor: ehColors.slice(0, data.length),
                borderWidth: 1
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Number of Logins'
                    }
                }
            }
        }
    });
}

function generateActivityByUserChart() {
    const ctx = document.getElementById('chartActivityByUser');
    
    // Build user activity by day
    const userActivity = {};
    
    Object.values(auditLogState.operations).forEach(logs => {
        logs.forEach(log => {
            // Skip entries with no user or 'unknown' user for this chart
            if (!log.user || log.user === 'unknown') return;
            
            const user = log.user;
            const dateObj = new Date(log.time);
            const dateStr = formatDate(dateObj);
            
            if (!userActivity[user]) {
                userActivity[user] = {};
            }
            
            if (!userActivity[user][dateStr]) {
                userActivity[user][dateStr] = 0;
            }
            
            userActivity[user][dateStr]++;
        });
    });

    // Calculate total activity per user
    const userTotals = {};
    Object.entries(userActivity).forEach(([user, activity]) => {
        userTotals[user] = Object.values(activity).reduce((sum, count) => sum + count, 0);
    });

    // Sort users by total activity and take top 10
    const sortedUsers = Object.entries(userTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([user]) => user);

    // Aggregate remaining users into "Other"
    const topUserActivity = {};
    const otherActivity = {};
    
    Object.entries(userActivity).forEach(([user, activity]) => {
        if (sortedUsers.includes(user)) {
            topUserActivity[user] = activity;
        } else {
            Object.entries(activity).forEach(([date, count]) => {
                if (!otherActivity[date]) {
                    otherActivity[date] = 0;
                }
                otherActivity[date] += count;
            });
        }
    });

    // Add "Other" if there are users beyond top 10
    if (Object.keys(otherActivity).length > 0) {
        topUserActivity['Other'] = otherActivity;
    }

    // Fill in missing dates with 0 for all users
    Object.keys(topUserActivity).forEach(user => {
        auditLogState.actualDateRange.forEach(date => {
            if (!topUserActivity[user][date]) {
                topUserActivity[user][date] = 0;
            }
        });
    });

    // Create datasets for stacked bar chart
    const datasets = [];
    let colorIndex = 0;
    
    Object.entries(topUserActivity).forEach(([user, activity]) => {
        const data = auditLogState.actualDateRange.map(date => activity[date]);
        
        datasets.push({
            label: user,
            data: data,
            backgroundColor: ehColors[colorIndex % ehColors.length],
            borderColor: ehColors[colorIndex % ehColors.length],
            borderWidth: 1
        });
        
        colorIndex++;
    });

    auditLogState.charts.activityByUser = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: auditLogState.actualDateRange,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top'
                }
            },
            scales: {
                x: {
                    stacked: true,
                    ticks: {
                        maxRotation: 45,
                        minRotation: 45
                    }
                },
                y: {
                    stacked: true,
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Number of Events'
                    }
                }
            }
        }
    });
}

function formatDate(date) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const year = String(date.getFullYear()).slice(-2);
    return `${month}-${day}-${year}`;
}

function formatDateTime(date) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const year = String(date.getFullYear()).slice(-2);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${month}-${day}-${year} ${hours}:${minutes}:${seconds}`;
}

function showAuditLogStatus(message, type = 'success') {
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

function exportAuditLogCsv() {
    if (auditLogState.rawData.length === 0) {
        alert('No audit log data to export');
        return;
    }

    const operationType = document.getElementById('exportOperationType').value;
    let dataToExport = [];

    if (operationType === 'all') {
        dataToExport = auditLogState.rawData;
    } else {
        // Filter by operation type
        const operationEntries = auditLogState.operations[operationType];
        if (!operationEntries || operationEntries.length === 0) {
            alert(`No entries found for operation type: ${operationType}`);
            return;
        }
        
        // Map back to raw data format
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
        const dateTime = formatDateTime(dateObj);
        
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
        ? `audit_log_all_${formatDate(new Date())}.csv`
        : `audit_log_${operationType.replace(/\s+/g, '_')}_${formatDate(new Date())}.csv`;
    
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    const statusMsg = operationType === 'all' 
        ? `CSV export completed (${dataToExport.length} entries)`
        : `CSV export completed for ${operationType} (${dataToExport.length} entries)`;
    showAuditLogStatus(statusMsg, 'success');
}

// Audit Logs module initialization function
function initAuditLogsModule() {
    console.log('Initializing Audit Logs module');
    
    // Set up event listeners specific to audit logs module
    if (!document.getElementById('loadAuditLog').hasAttribute('data-listener-added')) {
        document.getElementById('loadAuditLog').addEventListener('click', loadAuditLog);
        document.getElementById('stopAuditLogLoad').addEventListener('click', stopAuditLogLoad);
        document.getElementById('exportAuditLogCsv').addEventListener('click', exportAuditLogCsv);
        
        document.getElementById('loadAuditLog').setAttribute('data-listener-added', 'true');
    }
}