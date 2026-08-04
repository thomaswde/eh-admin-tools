/* exported buildPcapCollectionWindow, startPcapAnalysis, cancelPcapAnalysis, pollPcapJob */
(function registerPcapAnalyzerFeature() {
    'use strict';

    const API_ROOT = '/backend/pcap-analyzer';
    const TOP_TABLE_LIMIT = 25;
    const POLL_INTERVAL_MS = 750;
    const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
    const EXPORT_SCOPES = Object.freeze({
        all_findings: {
            buttonId: 'pcapDownloadAllFindingsCsv',
            fallbackFilename: 'datafeed-analysis-all-findings.csv'
        },
        reverse_not_observed: {
            buttonId: 'pcapDownloadReverseCsv',
            fallbackFilename: 'datafeed-analysis-reverse-direction.csv'
        },
        sequence_gap: {
            buttonId: 'pcapDownloadSequenceGapCsv',
            fallbackFilename: 'datafeed-analysis-sequence-gaps.csv'
        }
    });

    const pcapState = {
        initialized: false,
        active: false,
        busy: false,
        mode: 'upload',
        jobId: null,
        jobState: null,
        completedJob: null,
        topConversationMode: 'reverse',
        charts: {
            findingCounts: null,
            topConversations: null
        },
        resizeTimer: null,
        pollTimer: null,
        pollController: null,
        startController: null
    };

    function element(id) {
        return document.getElementById(id);
    }

    function pcapRuntimeContext() {
        return typeof runtimeContextForState === 'function'
            ? runtimeContextForState(window.state)
            : window.state?.apiConfig?.type || 'offline';
    }

    function pcapSupportsAction(actionName) {
        return typeof runtimeSupportsAction === 'function'
            ? runtimeSupportsAction(pcapRuntimeContext(), actionName)
            : true;
    }

    function buildPcapCollectionWindow(lookbackMinutes, windowSeconds, nowMs = Date.now()) {
        const lookback = Number(lookbackMinutes);
        const windowSize = Number(windowSeconds);
        const untilMs = Number(nowMs);
        if (!Number.isInteger(lookback) || lookback < 1 || lookback > 10) {
            throw new Error('Lookback must be a whole number from 1 through 10 minutes.');
        }
        if (!Number.isInteger(windowSize) || windowSize < 10 || windowSize > 300) {
            throw new Error('Search window must be a whole number from 10 through 300 seconds.');
        }
        if (!Number.isFinite(untilMs)) throw new Error('Collection end time is invalid.');
        return {
            fromMs: untilMs - (lookback * 60_000),
            untilMs,
            windowSeconds: windowSize
        };
    }

    async function pcapRequest(path, options = {}) {
        const response = await fetch(`${API_ROOT}${path}`, {
            credentials: 'same-origin',
            cache: 'no-store',
            ...options
        });
        if (!response.ok) {
            let detail = `Request failed with HTTP ${response.status}.`;
            try {
                const body = await response.json();
                const responseDetail = body.detail || body.error;
                detail = typeof responseDetail === 'string'
                    ? responseDetail
                    : responseDetail?.message || responseDetail?.detail || detail;
            } catch {}
            const error = new Error(String(detail));
            error.status = response.status;
            throw error;
        }
        if (response.status === 204) return null;
        return response.json();
    }

    function setMode(mode) {
        const requestedMode = mode === 'collect' ? 'collect' : 'upload';
        if (
            requestedMode === 'collect'
            && !pcapSupportsAction('datafeed.collect')
        ) {
            pcapState.mode = 'upload';
        } else {
            pcapState.mode = requestedMode;
        }
        document.querySelectorAll('[data-pcap-mode]').forEach(button => {
            const selected = button.dataset.pcapMode === pcapState.mode;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
        element('pcapUploadFields').hidden = pcapState.mode !== 'upload';
        element('pcapCollectFields').hidden = pcapState.mode !== 'collect';
        element('pcapStartButton').textContent = pcapState.mode === 'upload'
            ? 'Analyze capture'
            : 'Retrieve and analyze';
        syncPcapCapabilities();
        return requestedMode === pcapState.mode;
    }

    function setBusy(busy) {
        pcapState.busy = busy;
        element('pcapStartButton').disabled = busy;
        element('pcapCancelButton').disabled = !busy;
        element('pcapFileInput').disabled = busy;
        element('pcapLookbackMinutes').disabled = busy;
        element('pcapWindowSeconds').disabled = busy;
        document.querySelectorAll('[data-pcap-mode]').forEach(button => {
            button.disabled = busy;
        });
        syncPcapCapabilities();
    }

    function syncPcapCapabilities() {
        const canUpload = pcapSupportsAction('datafeed.upload');
        const canCollect = pcapSupportsAction('datafeed.collect');
        const uploadButton = element('pcapLocalMode');
        const collectButton = element('pcapConnectedMode');
        const hint = element('pcapConnectedCapabilityHint');
        if (uploadButton) uploadButton.disabled = pcapState.busy || !canUpload;
        if (collectButton) {
            collectButton.disabled = pcapState.busy || !canCollect;
            collectButton.title = canCollect
                ? ''
                : 'Connect to an ExtraHop deployment to retrieve packets.';
            collectButton.setAttribute('aria-disabled', String(!canCollect));
        }
        if (hint) {
            hint.hidden = canCollect;
            hint.textContent = canCollect
                ? ''
                : 'Connect to an ExtraHop deployment to retrieve packets from Packetstore.';
        }
        if (!canCollect && pcapState.mode === 'collect') {
            pcapState.mode = 'upload';
            document.querySelectorAll('[data-pcap-mode]').forEach(button => {
                const selected = button.dataset.pcapMode === 'upload';
                button.classList.toggle('active', selected);
                button.setAttribute('aria-pressed', String(selected));
            });
            element('pcapUploadFields').hidden = false;
            element('pcapCollectFields').hidden = true;
            element('pcapStartButton').textContent = 'Analyze capture';
        }
    }

    function stateLabel(state) {
        return String(state || 'ready')
            .replaceAll('_', ' ')
            .replace(/\b\w/g, character => character.toUpperCase());
    }

    function normalizeProgress(job) {
        const progress = job?.progress;
        if (typeof progress === 'number' && Number.isFinite(progress)) {
            return Math.max(0, Math.min(100, progress));
        }
        if (progress && typeof progress === 'object') {
            const percent = Number(progress.percent ?? progress.percentage);
            if (Number.isFinite(percent)) return Math.max(0, Math.min(100, percent));
            const completed = Number(progress.completed ?? progress.current);
            const total = Number(progress.total);
            if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) {
                return Math.max(0, Math.min(100, (completed / total) * 100));
            }
            const windowsCompleted = Number(progress.windowsCompleted);
            const windowsTotal = Number(progress.windowsTotal);
            if (Number.isFinite(windowsCompleted) && Number.isFinite(windowsTotal) && windowsTotal > 0) {
                return Math.max(0, Math.min(100, (windowsCompleted / windowsTotal) * 100));
            }
        }
        return job?.state === 'completed' ? 100 : 0;
    }

    function normalizeWarning(warning) {
        if (typeof warning === 'string') return warning;
        if (!warning || typeof warning !== 'object') return '';
        return String(warning.message || warning.detail || warning.code || '');
    }

    function collectWarnings(job) {
        const warnings = Array.isArray(job?.warnings)
            ? job.warnings.map(normalizeWarning).filter(Boolean)
            : [];
        const summary = job?.summary || {};
        const suspectedSlicing = Boolean(
            summary.suspectedUniformSlicing
            || summary.suspected_uniform_slicing
            || summary.uniformSliceLength
            || summary.uniform_slice_length
            || job?.suspectedUniformSlicing
            || job?.suspected_uniform_slicing
        );
        if (suspectedSlicing && !warnings.some(message => /uniform|slic|truncat/i.test(message))) {
            warnings.push('Capture truncated/sliced: packets have a suspiciously uniform captured length. Packet privileges or the capture path might be returning packet slices.');
        }
        return [...new Set(warnings)];
    }

    function renderWarnings(job) {
        const container = element('pcapWarnings');
        container.replaceChildren();
        for (const warning of collectWarnings(job)) {
            const notice = document.createElement('div');
            notice.className = 'notice notice-warn';
            notice.textContent = warning;
            container.appendChild(notice);
        }
    }

    function renderJob(job) {
        pcapState.jobState = job.state;
        const progress = normalizeProgress(job);
        const progressTrack = element('pcapStatusCard').querySelector('[role="progressbar"]');
        element('pcapProgressBar').style.width = `${progress}%`;
        progressTrack.setAttribute('aria-valuenow', String(Math.round(progress)));

        const badge = element('pcapStateBadge');
        badge.textContent = stateLabel(job.state);
        badge.className = 'badge';
        if (job.state === 'completed') badge.classList.add('badge-success');
        if (job.state === 'failed') badge.classList.add('badge-danger');
        if (job.state === 'cancelled' || job.completeness === 'partial') badge.classList.add('badge-warning');

        const stage = job.stage || job.progress?.stage || job.state;
        let status = stateLabel(stage);
        if (Number.isFinite(Number(job.progress?.windowsTotal))) {
            status += ` · ${Number(job.progress?.windowsCompleted) || 0} of ${Number(job.progress.windowsTotal)} windows`;
        }
        if (job.completeness && job.completeness !== 'not_applicable') {
            status += ` · ${stateLabel(job.completeness)} result`;
        }
        if (job.error) status = `${status}: ${normalizeWarning(job.error) || String(job.error)}`;
        element('pcapStatusText').textContent = status;
        renderWarnings(job);
    }

    function summaryValue(summary, keys, fallback = 0) {
        for (const key of keys) {
            if (summary[key] !== undefined && summary[key] !== null) return summary[key];
        }
        return fallback;
    }

    function appendSummaryStat(container, label, value, subtext = '') {
        const stat = document.createElement('div');
        stat.className = 'stat';
        const labelElement = document.createElement('div');
        labelElement.className = 'stat-label';
        labelElement.textContent = label;
        const valueElement = document.createElement('div');
        valueElement.className = 'stat-value';
        valueElement.textContent = String(value);
        stat.append(labelElement, valueElement);
        if (subtext) {
            const sub = document.createElement('div');
            sub.className = 'stat-sub';
            sub.textContent = subtext;
            stat.appendChild(sub);
        }
        container.appendChild(stat);
    }

    function renderSummary(job) {
        const summary = job.summary || {};
        const counts = job.dashboard?.findingCounts || {};
        const container = element('pcapSummary');
        container.replaceChildren();
        appendSummaryStat(container, 'Packets examined', summaryValue(summary, ['packets', 'packetCount', 'packet_count', 'recordsSeen']));
        appendSummaryStat(container, 'Directional flows', summaryValue(summary, ['flows', 'flowCount', 'flow_count']));
        appendSummaryStat(container, 'Affected flows', summaryValue(counts, ['affectedFlows'], 0));
        appendSummaryStat(
            container,
            'Completeness',
            stateLabel(job.completeness || 'indeterminate'),
            job.completeness === 'complete'
                ? 'The bounded capture was analyzed completely.'
                : 'Counts describe the available capture and may be incomplete.'
        );
    }

    function dashboardFromJob(job) {
        const dashboard = job?.dashboard;
        if (dashboard && Number(dashboard.schemaVersion) === 1) return dashboard;
        return {
            schemaVersion: 1,
            findingCounts: {},
            topReverse: [],
            topSequenceGaps: [],
            enrichment: { status: 'skipped' }
        };
    }

    function finiteNumber(value, fallback = 0) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function formatNumber(value) {
        if (value === undefined || value === null || value === '') return '—';
        const number = Number(value);
        return Number.isFinite(number) ? number.toLocaleString() : String(value);
    }

    function endpointDetails(item, side) {
        const direct = item?.[side];
        const addressKey = side === 'source' ? 'sourceAddress' : 'destinationAddress';
        const portKey = side === 'source' ? 'sourcePort' : 'destinationPort';
        const deviceKey = side === 'source' ? 'sourceDevice' : 'destinationDevice';
        const address = direct && typeof direct === 'object'
            ? direct.address ?? direct.ip ?? ''
            : item?.[addressKey] ?? '';
        const port = direct && typeof direct === 'object' ? direct.port : item?.[portKey];
        const device = direct && typeof direct === 'object' && direct.device
            ? direct.device
            : item?.[deviceKey];
        const addressText = String(address);
        const formattedAddress = addressText.includes(':') && !addressText.startsWith('[')
            ? `[${addressText}]`
            : addressText;
        return {
            label: port === undefined || port === null || port === ''
                ? addressText
                : `${formattedAddress}:${port}`,
            deviceName: device?.displayName ? String(device.displayName) : ''
        };
    }

    function timeLabel(value) {
        if (value === undefined || value === null || value === '') return '—';
        const numeric = Number(value);
        const date = Number.isFinite(numeric)
            ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
            : new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    function appendCell(row, value, className = '') {
        const cell = document.createElement('td');
        cell.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
        if (className) cell.className = className;
        row.appendChild(cell);
        return cell;
    }

    function appendEndpointCell(row, item, side) {
        const endpoint = endpointDetails(item, side);
        const cell = document.createElement('td');
        cell.className = 'pcap-endpoint';
        const primary = document.createElement('span');
        primary.className = 'pcap-endpoint-primary mono';
        primary.textContent = endpoint.label || '—';
        cell.appendChild(primary);
        if (endpoint.deviceName) {
            const secondary = document.createElement('span');
            secondary.className = 'pcap-endpoint-device';
            secondary.textContent = endpoint.deviceName;
            cell.appendChild(secondary);
        }
        row.appendChild(cell);
    }

    function renderReverseRows(items) {
        const rows = Array.isArray(items) ? items.slice(0, TOP_TABLE_LIMIT) : [];
        const body = element('pcapReverseResultsBody');
        body.replaceChildren();
        for (const item of rows) {
            const row = document.createElement('tr');
            row.dataset.flowKey = String(item.flowKey || '');
            appendEndpointCell(row, item, 'source');
            appendEndpointCell(row, item, 'destination');
            appendCell(row, formatNumber(item.packetCount), 'num');
            appendCell(row, formatNumber(item.capturedBytes), 'num');
            appendCell(row, timeLabel(item.firstTimestamp));
            appendCell(row, timeLabel(item.lastTimestamp));
            body.appendChild(row);
        }
        element('pcapReverseResultsEmpty').hidden = rows.length > 0;
        element('pcapReverseResultsTable').hidden = rows.length === 0;
    }

    function renderSequenceGapRows(items) {
        const rows = Array.isArray(items) ? items.slice(0, TOP_TABLE_LIMIT) : [];
        const body = element('pcapSequenceGapResultsBody');
        body.replaceChildren();
        for (const item of rows) {
            const row = document.createElement('tr');
            row.dataset.flowKey = String(item.flowKey || '');
            appendEndpointCell(row, item, 'source');
            appendEndpointCell(row, item, 'destination');
            appendCell(row, formatNumber(item.sequenceGapObservations), 'num');
            appendCell(row, formatNumber(item.sequenceGapBytes), 'num');
            appendCell(row, formatNumber(item.packetCount), 'num');
            appendCell(row, formatNumber(item.connectionEpochs), 'num');
            appendCell(row, timeLabel(item.firstTimestamp));
            appendCell(row, timeLabel(item.lastTimestamp));
            body.appendChild(row);
        }
        element('pcapSequenceGapResultsEmpty').hidden = rows.length > 0;
        element('pcapSequenceGapResultsTable').hidden = rows.length === 0;
    }

    function chartColors() {
        if (typeof window.chartThemeResolvedColors === 'function') {
            return window.chartThemeResolvedColors();
        }

        // The theme module is loaded independently from this feature. If its
        // browser export is unavailable, keep the completed analysis usable
        // and resolve the app's active light/dark colors from CSS instead.
        const styles = typeof getComputedStyle === 'function'
            ? getComputedStyle(document.documentElement)
            : null;
        const cssColor = (property, fallback) => {
            const value = styles?.getPropertyValue(property)?.trim();
            return value || fallback;
        };
        return {
            bg: cssColor('--raised', '#ffffff'),
            text: cssColor('--ink', '#16151f'),
            muted: cssColor('--gray', '#6a6970'),
            grid: cssColor('--hairline', '#dadadb'),
            low: '#00aaef',
            mid: '#f59e0b',
            high: '#ef4444',
            transparent: false
        };
    }

    function destroyPcapChart(name) {
        if (!pcapState.charts[name]) return;
        pcapState.charts[name].destroy();
        pcapState.charts[name] = null;
    }

    function destroyPcapCharts() {
        destroyPcapChart('findingCounts');
        destroyPcapChart('topConversations');
    }

    function completenessSentence(job) {
        return job?.completeness === 'complete'
            ? 'The result is complete for the bounded capture.'
            : 'The result is incomplete; counts describe only the available capture.';
    }

    function renderFindingCountsChart(job, dashboard) {
        destroyPcapChart('findingCounts');
        const counts = dashboard.findingCounts || {};
        const definitions = [
            { key: 'reverseNotObservedFlows', label: 'Reverse direction not observed', color: 'low' },
            { key: 'sequenceGapFlows', label: 'Observed TCP sequence gap', color: 'mid' },
            { key: 'truncatedFlows', label: 'Capture truncated or sliced', color: 'high' }
        ];
        const values = definitions.map(item => finiteNumber(counts[item.key]));
        const hasFindings = values.some(value => value > 0);
        element('pcapFindingCountsEmpty').hidden = hasFindings;
        element('pcapFindingCountsChartFrame').hidden = !hasFindings;
        element('pcapFindingCountsDescription').textContent = `A directional flow can appear in more than one category, so these counts must not be added together. ${completenessSentence(job)}`;
        if (!hasFindings) {
            element('pcapFindingCountsEmpty').textContent = job.completeness === 'complete'
                ? 'No analyzed flows had these findings.'
                : 'No findings were observed in the available capture.';
            return;
        }
        const colors = chartColors();
        const totalFlows = finiteNumber(summaryValue(job.summary || {}, ['flows', 'flowCount', 'flow_count']));
        pcapState.charts.findingCounts = new Chart(element('pcapFindingCountsChart'), {
            type: 'bar',
            data: {
                labels: definitions.map(item => item.label),
                datasets: [{
                    label: 'Affected flows',
                    data: values,
                    backgroundColor: definitions.map(item => colors[item.color]),
                    borderWidth: 0
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label(context) {
                                const count = finiteNumber(context.raw);
                                const percent = totalFlows > 0 ? (count / totalFlows) * 100 : 0;
                                return `${formatNumber(count)} affected flows (${percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}% of directional flows)`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        beginAtZero: true,
                        ticks: { precision: 0, color: colors.muted },
                        grid: { color: colors.grid }
                    },
                    y: { ticks: { color: colors.text }, grid: { display: false } }
                }
            }
        });
    }

    function topChartLimit() {
        return finiteNumber(window.innerWidth, 1200) < 900 ? 10 : 15;
    }

    function renderTopConversationsChart(job, dashboard) {
        destroyPcapChart('topConversations');
        const sequenceMode = pcapState.topConversationMode === 'sequence_gap';
        const sourceRows = sequenceMode ? dashboard.topSequenceGaps : dashboard.topReverse;
        const rows = (Array.isArray(sourceRows) ? sourceRows : []).slice(0, topChartLimit());
        const title = sequenceMode ? 'Top conversations — Sequence gaps' : 'Top conversations — Reverse visibility';
        const description = sequenceMode
            ? `Ranked by observed TCP sequence-gap bytes. ${completenessSentence(job)}`
            : `Ranked by packet count where no reverse flow was observed. ${completenessSentence(job)}`;
        element('pcapTopConversationsHeading').textContent = title;
        element('pcapTopConversationsDescription').textContent = description;
        document.querySelectorAll('[data-pcap-chart-mode]').forEach(button => {
            const selected = button.dataset.pcapChartMode === pcapState.topConversationMode;
            button.classList.toggle('is-active', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
        element('pcapTopConversationsEmpty').hidden = rows.length > 0;
        element('pcapTopConversationsChartFrame').hidden = rows.length === 0;
        if (!rows.length) {
            element('pcapTopConversationsEmpty').textContent = sequenceMode
                ? 'No observed TCP sequence gaps were found.'
                : 'No reverse-direction observations were found.';
            return;
        }
        const colors = chartColors();
        const valueKey = sequenceMode ? 'sequenceGapBytes' : 'packetCount';
        const datasetLabel = sequenceMode ? 'Observed gap bytes' : 'Packets';
        const frame = element('pcapTopConversationsChartFrame');
        frame.style.height = `${Math.max(230, rows.length * 34 + 70)}px`;
        pcapState.charts.topConversations = new Chart(element('pcapTopConversationsChart'), {
            type: 'bar',
            data: {
                labels: rows.map(row => `${endpointDetails(row, 'source').label} → ${endpointDetails(row, 'destination').label}`),
                datasets: [{
                    label: datasetLabel,
                    data: rows.map(row => finiteNumber(row[valueKey])),
                    backgroundColor: sequenceMode ? colors.mid : colors.low,
                    borderWidth: 0,
                    rows
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title(contexts) {
                                const row = rows[contexts[0]?.dataIndex];
                                if (!row) return '';
                                return `${endpointDetails(row, 'source').label} → ${endpointDetails(row, 'destination').label}`;
                            },
                            label(context) {
                                const row = rows[context.dataIndex];
                                if (!row) return '';
                                return sequenceMode
                                    ? `${formatNumber(row.sequenceGapBytes)} observed gap bytes · ${formatNumber(row.sequenceGapObservations)} gaps`
                                    : `${formatNumber(row.packetCount)} packets · ${formatNumber(row.capturedBytes)} captured bytes`;
                            },
                            afterLabel(context) {
                                const row = rows[context.dataIndex];
                                if (!row) return '';
                                const sourceName = endpointDetails(row, 'source').deviceName;
                                const destinationName = endpointDetails(row, 'destination').deviceName;
                                return [sourceName && `Source: ${sourceName}`, destinationName && `Destination: ${destinationName}`]
                                    .filter(Boolean);
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        beginAtZero: true,
                        title: { display: true, text: datasetLabel, color: colors.muted },
                        ticks: { precision: 0, color: colors.muted },
                        grid: { color: colors.grid }
                    },
                    y: { ticks: { color: colors.text }, grid: { display: false } }
                }
            }
        });
    }

    function renderEnrichmentStatus(dashboard) {
        const status = dashboard.enrichment || {};
        const container = element('pcapEnrichmentStatus');
        const considered = finiteNumber(status.addressesConsidered);
        const matched = finiteNumber(status.addressesMatched);
        container.hidden = status.status === 'skipped' && considered === 0;
        if (container.hidden) {
            container.textContent = '';
            return;
        }
        let text = `ExtraHop names: ${formatNumber(matched)} of ${formatNumber(considered)} addresses enriched.`;
        if (finiteNumber(status.addressesAmbiguous) > 0) {
            text += ` ${formatNumber(status.addressesAmbiguous)} ambiguous.`;
        }
        if (finiteNumber(status.addressesOmitted) > 0) {
            text += ` ${formatNumber(status.addressesOmitted)} omitted by the enrichment limit.`;
        }
        if (!['complete', 'skipped'].includes(status.status)) text += ` Enrichment ${stateLabel(status.status)}.`;
        container.textContent = text;
    }

    function updateExportButtons(dashboard, busyScope = '') {
        const counts = dashboard.findingCounts || {};
        const enabled = {
            all_findings: finiteNumber(counts.affectedFlows) > 0,
            reverse_not_observed: finiteNumber(counts.reverseNotObservedFlows) > 0,
            sequence_gap: finiteNumber(counts.sequenceGapFlows) > 0
        };
        Object.entries(EXPORT_SCOPES).forEach(([scope, config]) => {
            element(config.buttonId).disabled = !enabled[scope] || busyScope === scope;
        });
    }

    function renderPcapDashboard(job) {
        const dashboard = dashboardFromJob(job);
        renderSummary(job);
        renderEnrichmentStatus(dashboard);
        renderReverseRows(dashboard.topReverse);
        renderSequenceGapRows(dashboard.topSequenceGaps);
        renderFindingCountsChart(job, dashboard);
        renderTopConversationsChart(job, dashboard);
        updateExportButtons(dashboard);
        element('pcapResults').hidden = false;
    }

    function stopPcapPolling() {
        if (pcapState.pollTimer !== null) {
            clearTimeout(pcapState.pollTimer);
            pcapState.pollTimer = null;
        }
        if (pcapState.pollController) {
            pcapState.pollController.abort();
            pcapState.pollController = null;
        }
        if (pcapState.startController) {
            pcapState.startController.abort();
            pcapState.startController = null;
        }
        if (pcapState.resizeTimer !== null) {
            clearTimeout(pcapState.resizeTimer);
            pcapState.resizeTimer = null;
        }
    }

    function schedulePcapPoll(jobId) {
        stopPcapPolling();
        if (!pcapState.active || pcapState.jobId !== jobId) return;
        pcapState.pollTimer = setTimeout(() => {
            pcapState.pollTimer = null;
            pollPcapJob(jobId).catch(handlePcapError);
        }, POLL_INTERVAL_MS);
    }

    async function pollPcapJob(jobId = pcapState.jobId) {
        if (!jobId || jobId !== pcapState.jobId) return null;
        const controller = new AbortController();
        pcapState.pollController = controller;
        let job;
        try {
            job = await pcapRequest(`/jobs/${encodeURIComponent(jobId)}`, { signal: controller.signal });
        } catch (error) {
            if (error.name === 'AbortError') return null;
            throw error;
        } finally {
            if (pcapState.pollController === controller) pcapState.pollController = null;
        }
        if (jobId !== pcapState.jobId) return job;
        renderJob(job);
        if (TERMINAL_STATES.has(job.state)) {
            setBusy(false);
            if (job.state === 'completed') {
                pcapState.completedJob = job;
                renderPcapDashboard(job);
            }
        } else {
            schedulePcapPoll(jobId);
        }
        return job;
    }

    function handlePcapError(error) {
        if (error?.name === 'AbortError') return;
        stopPcapPolling();
        setBusy(false);
        element('pcapStateBadge').textContent = 'Error';
        element('pcapStateBadge').className = 'badge badge-danger';
        element('pcapStatusText').textContent = error?.message || 'The Datafeed Analysis request failed.';
    }

    async function startPcapAnalysis() {
        const action = pcapState.mode === 'upload' ? 'datafeed.upload' : 'datafeed.collect';
        if (!pcapSupportsAction(action)) {
            const error = new Error(
                pcapState.mode === 'collect'
                    ? 'Connect to an ExtraHop deployment before retrieving packets.'
                    : 'Local PCAP upload is unavailable in the current runtime context.'
            );
            handlePcapError(error);
            throw error;
        }
        stopPcapPolling();
        pcapState.jobId = null;
        pcapState.jobState = null;
        pcapState.completedJob = null;
        pcapState.topConversationMode = 'reverse';
        destroyPcapCharts();
        const startController = new AbortController();
        pcapState.startController = startController;
        element('pcapResults').hidden = true;
        Object.values(EXPORT_SCOPES).forEach(config => {
            element(config.buttonId).disabled = true;
        });
        element('pcapExportStatus').textContent = '';
        element('pcapWarnings').replaceChildren();
        setBusy(true);
        element('pcapStateBadge').textContent = 'Starting';
        element('pcapStateBadge').className = 'badge';
        element('pcapStatusText').textContent = pcapState.mode === 'upload'
            ? 'Uploading capture…'
            : 'Starting bounded packet retrieval…';

        try {
            let job;
            if (pcapState.mode === 'upload') {
                const file = element('pcapFileInput').files?.[0];
                if (!file) throw new Error('Choose a PCAP file to analyze.');
                job = await pcapRequest('/upload', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/vnd.tcpdump.pcap' },
                    signal: startController.signal,
                    body: file
                });
            } else {
                const collectionWindow = buildPcapCollectionWindow(
                    element('pcapLookbackMinutes').valueAsNumber,
                    element('pcapWindowSeconds').valueAsNumber
                );
                job = await pcapRequest('/collect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: startController.signal,
                    body: JSON.stringify(collectionWindow)
                });
            }
            if (pcapState.startController === startController) pcapState.startController = null;
            const jobId = String(job.id || job.jobId || job.job_id || '');
            if (!jobId) throw new Error('Datafeed Analysis did not return a job identifier.');
            pcapState.jobId = jobId;
            pcapState.jobState = job.state || 'queued';
            renderJob({ state: 'queued', completeness: 'not_applicable', ...job });
            await pollPcapJob(jobId);
            return job;
        } catch (error) {
            if (pcapState.startController === startController) pcapState.startController = null;
            handlePcapError(error);
            throw error;
        }
    }

    async function cancelPcapAnalysis({ remote = true } = {}) {
        const jobId = pcapState.jobId;
        const wasStarting = Boolean(pcapState.startController);
        const shouldCancelRemote = remote && jobId && !TERMINAL_STATES.has(pcapState.jobState);
        stopPcapPolling();
        setBusy(false);
        if (shouldCancelRemote) {
            try {
                await pcapRequest(`/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
            } catch (error) {
                if (error.status !== 404 && error.status !== 409) throw error;
            }
        }
        if ((jobId && shouldCancelRemote) || (!jobId && wasStarting)) {
            pcapState.jobState = 'cancelled';
            renderJob({ state: 'cancelled', completeness: 'partial', warnings: [] });
        }
    }

    function filenameFromDisposition(disposition, fallback) {
        const encoded = /filename\*=UTF-8''([^;]+)/i.exec(String(disposition || ''));
        const quoted = /filename="([^"]+)"/i.exec(String(disposition || ''));
        const plain = /filename=([^;]+)/i.exec(String(disposition || ''));
        let filename = fallback;
        try {
            if (encoded) filename = decodeURIComponent(encoded[1].trim());
            else if (quoted) filename = quoted[1];
            else if (plain) filename = plain[1].trim();
        } catch {}
        return String(filename || fallback).split(/[\\/]/).pop();
    }

    function setPcapExportStatus(message, isError = false) {
        const status = element('pcapExportStatus');
        status.textContent = message;
        status.style.color = isError ? 'var(--danger-text)' : 'var(--gray)';
    }

    async function downloadPcapCsv(scope) {
        const config = EXPORT_SCOPES[scope];
        const jobId = pcapState.jobId;
        if (!jobId || !config || !pcapState.completedJob) return;
        updateExportButtons(dashboardFromJob(pcapState.completedJob), scope);
        try {
            const params = new URLSearchParams({ scope });
            const response = await fetch(`${API_ROOT}/jobs/${encodeURIComponent(jobId)}/csv?${params}`, {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            if (!response.ok) throw new Error(`CSV download failed with HTTP ${response.status}.`);
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filenameFromDisposition(response.headers?.get('content-disposition'), config.fallbackFilename);
            link.rel = 'noopener';
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            setPcapExportStatus(`Exported ${link.download}.`);
        } catch (error) {
            setPcapExportStatus(error?.message || 'CSV export failed.', true);
        } finally {
            if (jobId === pcapState.jobId && pcapState.completedJob) {
                updateExportButtons(dashboardFromJob(pcapState.completedJob));
            }
        }
    }

    function initializePcapAnalyzer() {
        if (pcapState.initialized) return;
        document.querySelectorAll('[data-pcap-mode]').forEach(button => {
            button.addEventListener('click', () => setMode(button.dataset.pcapMode));
        });
        element('pcapStartButton').addEventListener('click', () => {
            startPcapAnalysis().catch(() => {});
        });
        element('pcapCancelButton').addEventListener('click', () => {
            cancelPcapAnalysis().catch(handlePcapError);
        });
        document.querySelectorAll('[data-pcap-chart-mode]').forEach(button => {
            button.addEventListener('click', () => {
                pcapState.topConversationMode = button.dataset.pcapChartMode === 'sequence_gap'
                    ? 'sequence_gap'
                    : 'reverse';
                if (pcapState.completedJob) {
                    renderTopConversationsChart(
                        pcapState.completedJob,
                        dashboardFromJob(pcapState.completedJob)
                    );
                }
            });
        });
        Object.entries(EXPORT_SCOPES).forEach(([scope, config]) => {
            element(config.buttonId).addEventListener('click', () => downloadPcapCsv(scope));
        });
        window.addEventListener?.('resize', () => {
            if (!pcapState.active || !pcapState.completedJob) return;
            if (pcapState.resizeTimer !== null) clearTimeout(pcapState.resizeTimer);
            pcapState.resizeTimer = setTimeout(() => {
                pcapState.resizeTimer = null;
                if (pcapState.active && pcapState.completedJob) {
                    renderTopConversationsChart(
                        pcapState.completedJob,
                        dashboardFromJob(pcapState.completedJob)
                    );
                }
            }, 150);
        });
        setMode('upload');
        pcapState.initialized = true;
    }

    window.PcapAnalyzer = Object.freeze({
        buildCollectionWindow: buildPcapCollectionWindow,
        setMode,
        start: startPcapAnalysis,
        cancel: cancelPcapAnalysis,
        poll: pollPcapJob
    });

    featureRegistry.register('pcap-analyzer', {
        initialize: initializePcapAnalyzer,
        activate() {
            pcapState.active = true;
            syncPcapCapabilities();
            if (pcapState.jobId && !TERMINAL_STATES.has(pcapState.jobState)) {
                schedulePcapPoll(pcapState.jobId);
            } else if (pcapState.completedJob) {
                renderPcapDashboard(pcapState.completedJob);
            }
        },
        cancel() {
            return cancelPcapAnalysis({ remote: true });
        },
        deactivate() {
            pcapState.active = false;
            stopPcapPolling();
            destroyPcapCharts();
        }
    });
})();
