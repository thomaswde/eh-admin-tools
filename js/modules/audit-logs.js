// Audit Log Analysis Module

const AUDIT_LOG_MAX_PAGES = 200;
const AUDIT_LOG_MAX_ROWS = 100000;

const auditLogState = {
    rawData: [],
    filteredEntries: [],
    operations: {},
    dateRange: [],
    actualDateRange: [], // Actual dates that have data
    reportWindow: null,
    shouldStop: false,
    abortController: null,
    collectionStatus: 'idle',
    collectionDetail: '',
    charts: {
        eventTypes: null,
        loginPerDay: null,
        loginByUser: null,
        activityByUser: null
    }
};

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
    auditLogState.abortController?.abort(new DOMException('Superseded by a new audit log load.', 'AbortError'));
    const abortController = new AbortController();
    auditLogState.abortController = abortController;

    try {
        loadBtn.disabled = true;
        loadBtn.style.display = 'none';
        stopBtn.style.display = 'block';
        loadingStatus.style.display = 'block';
        auditLogState.shouldStop = false;
        auditLogState.collectionStatus = 'collecting';
        auditLogState.collectionDetail = '';
        auditLogState.rawData = [];
        auditLogState.filteredEntries = [];
        auditLogState.operations = {};
        document.getElementById('auditLogChartsContainer').style.display = 'none';
        document.getElementById('exportAuditLogSection').style.display = 'none';
        
        auditLogState.reportWindow = buildAuditLogWindow(lookbackDays);
        auditLogState.dateRange = auditLogState.reportWindow.dates;

        const collection = await fetchAuditLogPages({
            batchSize,
            signal: abortController.signal,
            onProgress: totalFetched => {
                loadingText.textContent = `Loading audit log entries... (${totalFetched} fetched)`;
            }
        });
        auditLogState.rawData = collection.entries;
        auditLogState.collectionStatus = collection.incomplete ? 'partial' : 'complete';
        auditLogState.collectionDetail = collection.detail;

        loadingText.textContent = 'Processing audit log data...';

        // Process the data
        processAuditLogData(auditLogState.reportWindow);

        // Populate operation type dropdown
        populateOperationTypeDropdown();

        // Generate charts
        loadingText.textContent = 'Generating charts...';
        generateAuditLogCharts();

        // Show status
        if (collection.incomplete) {
            showAuditLogStatus(
                `Partial audit log: ${collection.detail}. Loaded ${auditLogState.filteredEntries.length} entries in the selected window (${auditLogState.rawData.length} fetched).`,
                'warning'
            );
        } else {
            showAuditLogStatus(
                `Loaded ${auditLogState.filteredEntries.length} entries in the selected window (${auditLogState.rawData.length} fetched)`,
                'success'
            );
        }
        
        // Show charts and export
        document.getElementById('auditLogChartsContainer').style.display = 'flex';
        document.getElementById('exportAuditLogSection').style.display = 'block';

    } catch (error) {
        auditLogState.collectionStatus = 'failed';
        auditLogState.collectionDetail = error.message;
        showAuditLogStatus(`Error loading audit log: ${error.message}`, 'error');
    } finally {
        loadingStatus.style.display = 'none';
        loadBtn.disabled = false;
        loadBtn.style.display = 'block';
        stopBtn.style.display = 'none';
        auditLogState.shouldStop = false;
        if (auditLogState.abortController === abortController) {
            auditLogState.abortController = null;
        }
    }
}

function stopAuditLogLoad() {
    auditLogState.shouldStop = true;
    auditLogState.abortController?.abort(new DOMException('Audit log collection stopped by user.', 'AbortError'));
    showAuditLogStatus('Stopping audit log load...', 'warning');
}

async function fetchAuditLogPages({
    batchSize,
    signal,
    maxPages = AUDIT_LOG_MAX_PAGES,
    maxRows = AUDIT_LOG_MAX_ROWS,
    onProgress = () => {}
}) {
    const pageSize = Number(batchSize);
    if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('Audit log batch size must be a positive integer');
    if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error('Audit log page budget must be a positive integer');
    if (!Number.isInteger(maxRows) || maxRows < 1) throw new Error('Audit log row budget must be a positive integer');

    const entries = [];
    let offset = 0;
    let pagesFetched = 0;

    const partial = (reason, detail) => ({
        entries,
        pagesFetched,
        rowsFetched: entries.length,
        incomplete: true,
        reason,
        detail
    });

    while (true) {
        if (signal?.aborted || auditLogState.shouldStop) {
            return partial('cancelled', 'collection was stopped before every page was retrieved');
        }
        if (pagesFetched >= maxPages) {
            return partial('page_budget', `the ${maxPages.toLocaleString()}-page safety limit was reached`);
        }
        if (entries.length >= maxRows) {
            return partial('row_budget', `the ${maxRows.toLocaleString()}-row safety limit was reached`);
        }

        onProgress(entries.length);
        let batch;
        try {
            batch = await window.apiClient.getAuditLog(pageSize, offset, { signal });
        } catch (error) {
            if (signal?.aborted || auditLogState.shouldStop) {
                return partial('cancelled', 'collection was stopped before every page was retrieved');
            }
            if (entries.length > 0) {
                return partial('failed', `a later page failed after ${entries.length.toLocaleString()} rows: ${error.message}`);
            }
            throw error;
        }

        if (!Array.isArray(batch)) throw new Error('Audit log API returned an invalid page');
        const rows = batch;
        pagesFetched += 1;
        const remaining = maxRows - entries.length;
        entries.push(...rows.slice(0, remaining));

        if (rows.length > remaining) {
            return partial('row_budget', `the ${maxRows.toLocaleString()}-row safety limit was reached`);
        }
        if (rows.length < pageSize) {
            return {
                entries,
                pagesFetched,
                rowsFetched: entries.length,
                incomplete: false,
                reason: null,
                detail: 'complete'
            };
        }

        offset += pageSize;
    }
}

function buildAuditLogWindow(lookbackDays, nowMs = Date.now()) {
    const days = Number(lookbackDays);
    if (!Number.isInteger(days) || days < 1) throw new Error('Audit log lookback must be at least one day');
    const now = new Date(nowMs);
    if (!Number.isFinite(now.getTime())) throw new Error('Unable to determine the audit log time window');
    const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const fromMs = todayStartMs - ((days - 1) * 24 * 60 * 60 * 1000);
    const dates = Array.from({ length: days }, (_, index) =>
        new Date(fromMs + (index * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10)
    );
    return { fromMs, untilMs: now.getTime(), dates, timezone: 'UTC' };
}

function processAuditLogData(reportWindow) {
    auditLogState.operations = {};
    auditLogState.filteredEntries = [];
    const datesWithData = new Set();

    for (const item of auditLogState.rawData) {
        const entry = { ...(item.body || {}) };
        entry.id = item.id;
        entry.time = item.occur_time;
        entry.timeMs = Number(item.occur_time);
        if (!Number.isFinite(entry.timeMs)
            || entry.timeMs < reportWindow.fromMs
            || entry.timeMs > reportWindow.untilMs) continue;

        const dateObj = new Date(entry.timeMs);
        const dateStr = formatDate(dateObj);
        entry.date = dateStr;
        entry.datetime = formatDateTime(dateObj);

        // Track dates that have data
        datesWithData.add(dateStr);

        // Normalize operation names
        let operation = String(entry.operation || 'Unknown');
        if (operation.startsWith('Remove fngr-')) {
            operation = 'Remove Node';
        } else if (operation.startsWith('Disable node')) {
            operation = 'Disable Node';
        } else if (operation.startsWith('Enable node')) {
            operation = 'Enable Node';
        }
        entry.normalizedOperation = operation;
        auditLogState.filteredEntries.push(entry);

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
                backgroundColor: genericChartPrimaryColor(),
                borderColor: genericChartPrimaryColor(),
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
        const dateStr = log.date;
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
                backgroundColor: genericChartPrimaryColor(),
                borderColor: genericChartPrimaryColor(),
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
                backgroundColor: genericChartPrimaryColor(),
                borderColor: genericChartPrimaryColor(),
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
            const dateStr = log.date;
            
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
            backgroundColor: genericChartPaletteColor(colorIndex),
            borderColor: genericChartPaletteColor(colorIndex),
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
    return date.toISOString().slice(0, 10);
}

function formatDateTime(date) {
    return date.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function showAuditLogStatus(message, type = 'success') {
    const statusDiv = document.getElementById('auditLogStatus');
    const statusText = document.getElementById('auditLogStatusText');
    
    statusDiv.style.display = 'block';
    statusText.textContent = message;
    
    const colors = {
        success: { bg: 'var(--ok-bg)', border: 'var(--ok-border)', text: 'var(--ok-text)' },
        warning: { bg: 'var(--warn-bg)', border: 'var(--warn-border)', text: 'var(--warn)' },
        error: { bg: 'var(--danger-bg)', border: 'var(--danger-border)', text: 'var(--danger-text)' }
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
    if (auditLogState.filteredEntries.length === 0) {
        alert('No audit log data to export');
        return;
    }

    const operationType = document.getElementById('exportOperationType').value;
    const dataToExport = selectAuditLogEntriesForExport(operationType);
    if (dataToExport.length === 0) {
        if (operationType !== 'all') {
            alert(`No entries found for operation type: ${operationType}`);
        }
        return;
    }

    const csvContent = buildAuditLogCsv(dataToExport, {
        status: auditLogState.collectionStatus,
        detail: auditLogState.collectionDetail,
        fromMs: auditLogState.reportWindow?.fromMs,
        untilMs: auditLogState.reportWindow?.untilMs
    });

    // Download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    const partialSuffix = auditLogState.collectionStatus === 'partial' ? '_partial' : '';
    const filename = operationType === 'all' 
        ? `audit_log_all${partialSuffix}_${formatDate(new Date())}.csv`
        : `audit_log_${operationType.replace(/\s+/g, '_')}${partialSuffix}_${formatDate(new Date())}.csv`;
    
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    const statusMsg = operationType === 'all' 
        ? `CSV export completed (${dataToExport.length} entries)`
        : `CSV export completed for ${operationType} (${dataToExport.length} entries)`;
    showAuditLogStatus(
        auditLogState.collectionStatus === 'partial' ? `${statusMsg}; export contains partial collection results` : statusMsg,
        auditLogState.collectionStatus === 'partial' ? 'warning' : 'success'
    );
}

function selectAuditLogEntriesForExport(operationType) {
    if (operationType === 'all') return auditLogState.filteredEntries;
    return auditLogState.operations[operationType] || [];
}

function buildAuditLogCsv(entries, collection = {}) {
    const status = collection.status || 'complete';
    const detail = collection.detail || '';
    const fromIso = Number.isFinite(Number(collection.fromMs)) ? new Date(Number(collection.fromMs)).toISOString() : '';
    const untilIso = Number.isFinite(Number(collection.untilMs)) ? new Date(Number(collection.untilMs)).toISOString() : '';
    const rows = [[
        'ID', 'Date/Time', 'Operation', 'User', 'Details',
        'Collection Status', 'Collection Detail', 'Report From UTC', 'Report Until UTC'
    ]];
    (entries || []).forEach(entry => {
        rows.push([
            entry.id,
            entry.datetime || formatDateTime(new Date(entry.timeMs ?? entry.time)),
            entry.operation || '',
            entry.user || 'unknown',
            JSON.stringify(entry),
            status,
            detail,
            fromIso,
            untilIso
        ]);
    });
    return CsvUtils.stringifyRows(rows, { numericColumns: [0], finalNewline: false });
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

function cancelAuditLogsModule() {
    if (auditLogState.abortController) stopAuditLogLoad();
}

if (typeof featureRegistry !== 'undefined') {
    featureRegistry.register('audit-logs', {
        initialize: initAuditLogsModule,
        cancel: cancelAuditLogsModule
    });
}
