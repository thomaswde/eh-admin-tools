/* exported buildPcapCollectionWindow, startPcapAnalysis, cancelPcapAnalysis, pollPcapJob */
(function registerPcapAnalyzerFeature() {
    'use strict';

    const API_ROOT = '/backend/pcap-analyzer';
    const RESULT_PAGE_LIMIT = 100;
    const POLL_INTERVAL_MS = 750;
    const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
    const FINDING_LABELS = Object.freeze({
        reverse_not_observed: 'Reverse direction not observed',
        reverse_direction_not_observed: 'Reverse direction not observed',
        capture_truncated_sliced: 'Capture truncated/sliced',
        capture_truncated: 'Capture truncated/sliced',
        suspected_uniform_slicing: 'Capture truncated/sliced',
        observed_tcp_sequence_gap: 'Observed TCP sequence gap',
        sequence_gap: 'Observed TCP sequence gap'
    });

    const pcapState = {
        initialized: false,
        active: false,
        mode: 'upload',
        jobId: null,
        jobState: null,
        resultOffset: 0,
        resultTotal: 0,
        pollTimer: null,
        pollController: null,
        startController: null
    };

    function element(id) {
        return document.getElementById(id);
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
        pcapState.mode = mode === 'collect' ? 'collect' : 'upload';
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
    }

    function setBusy(busy) {
        element('pcapStartButton').disabled = busy;
        element('pcapCancelButton').disabled = !busy;
        element('pcapFileInput').disabled = busy;
        element('pcapLookbackMinutes').disabled = busy;
        element('pcapWindowSeconds').disabled = busy;
        document.querySelectorAll('[data-pcap-mode]').forEach(button => {
            button.disabled = busy;
        });
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
        const container = element('pcapSummary');
        container.replaceChildren();
        appendSummaryStat(container, 'Packets examined', summaryValue(summary, ['packets', 'packetCount', 'packet_count', 'recordsSeen']));
        appendSummaryStat(container, 'Directional flows', summaryValue(summary, ['flows', 'flowCount', 'flow_count']));
        const findingObservations = summaryValue(summary, ['findings', 'findingCount', 'finding_count'], null)
            ?? (
                Number(summary.reverseNotObservedFlows || 0)
                + Number(summary.truncatedRecords || 0)
                + Number(summary.sequenceGapObservations || 0)
            );
        appendSummaryStat(container, 'Finding observations', findingObservations);
        appendSummaryStat(
            container,
            'Completeness',
            stateLabel(job.completeness || 'indeterminate'),
            'Execution status and analytical completeness are reported separately.'
        );
    }

    function findingKey(item) {
        return String(item.finding || item.findingType || item.finding_type || item.type || '');
    }

    function findingLabel(item) {
        if (Array.isArray(item.findingKinds) && item.findingKinds.length) {
            return item.findingKinds.map(kind => FINDING_LABELS[kind] || stateLabel(kind)).join('; ');
        }
        const key = findingKey(item);
        return FINDING_LABELS[key] || stateLabel(key || 'finding');
    }

    function endpointLabel(item, side) {
        const direct = item[side];
        if (typeof direct === 'string' || typeof direct === 'number') return String(direct);
        if (direct && typeof direct === 'object') {
            const host = direct.ip || direct.address || direct.host || direct.name || '';
            const port = direct.port;
            return port === undefined || port === null || port === '' ? String(host) : `${host}:${port}`;
        }
        const prefix = side === 'source' ? 'src' : 'dst';
        const longPrefix = side === 'source' ? 'source' : 'destination';
        const host = item[`${prefix}Ip`] ?? item[`${prefix}_ip`] ?? item[`${longPrefix}Address`] ?? '';
        const port = item[`${prefix}Port`] ?? item[`${prefix}_port`] ?? item[`${longPrefix}Port`];
        return port === undefined || port === null || port === '' ? String(host) : `${host}:${port}`;
    }

    function findingDetail(item) {
        if (item.detail || item.description || item.message) {
            return item.detail || item.description || item.message;
        }
        const details = [];
        if (Number(item.truncatedPackets) > 0) {
            details.push(`${item.truncatedPackets} captured packet${Number(item.truncatedPackets) === 1 ? '' : 's'} shorter than original length`);
        }
        if (Number(item.sequenceGapObservations) > 0) {
            details.push(`${item.sequenceGapObservations} observed uncovered TCP sequence range${Number(item.sequenceGapObservations) === 1 ? '' : 's'}`);
        }
        if (item.reverseObserved === false) details.push('Reverse direction not present in this capture');
        return details.join('; ');
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
    }

    function renderResultRows(payload) {
        const items = Array.isArray(payload.items) ? payload.items.slice(0, RESULT_PAGE_LIMIT) : [];
        const body = element('pcapResultsBody');
        body.replaceChildren();
        for (const item of items) {
            const row = document.createElement('tr');
            appendCell(row, findingLabel(item), 'primary-cell');
            appendCell(row, endpointLabel(item, 'source'), 'mono');
            appendCell(row, endpointLabel(item, 'destination'), 'mono');
            appendCell(row, item.protocol || item.transport || 'TCP');
            appendCell(row, item.packets ?? item.packetCount ?? item.packet_count, 'num');
            appendCell(row, timeLabel(item.firstObserved ?? item.first_observed ?? item.firstTimestamp ?? item.first_timestamp));
            appendCell(row, timeLabel(item.lastObserved ?? item.last_observed ?? item.lastTimestamp ?? item.last_timestamp));
            appendCell(row, findingDetail(item));
            body.appendChild(row);
        }

        pcapState.resultTotal = Number(payload.total) || 0;
        pcapState.resultOffset = Number(payload.offset) || 0;
        element('pcapResultsEmpty').hidden = items.length > 0;
        element('pcapResultsTable').hidden = items.length === 0;
        element('pcapPager').hidden = pcapState.resultTotal <= RESULT_PAGE_LIMIT;
        const first = pcapState.resultTotal === 0 ? 0 : pcapState.resultOffset + 1;
        const last = Math.min(pcapState.resultOffset + items.length, pcapState.resultTotal);
        element('pcapPagerInfo').textContent = `${first}–${last} of ${pcapState.resultTotal}`;
        element('pcapPreviousPage').disabled = pcapState.resultOffset <= 0;
        element('pcapNextPage').disabled = pcapState.resultOffset + items.length >= pcapState.resultTotal;
    }

    async function loadPcapResults(offset = 0) {
        if (!pcapState.jobId) return;
        const filter = element('pcapFindingFilter').value;
        const params = new URLSearchParams({
            offset: String(Math.max(0, offset)),
            limit: String(RESULT_PAGE_LIMIT)
        });
        if (filter) params.set('finding', filter);
        const payload = await pcapRequest(`/jobs/${encodeURIComponent(pcapState.jobId)}/results?${params}`);
        renderResultRows(payload);
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
                renderSummary(job);
                element('pcapResults').hidden = false;
                element('pcapDownloadCsv').disabled = false;
                await loadPcapResults(0);
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
        element('pcapStatusText').textContent = error?.message || 'The PCAP Analyzer request failed.';
    }

    async function startPcapAnalysis() {
        stopPcapPolling();
        pcapState.jobId = null;
        pcapState.jobState = null;
        const startController = new AbortController();
        pcapState.startController = startController;
        element('pcapResults').hidden = true;
        element('pcapDownloadCsv').disabled = true;
        element('pcapWarnings').replaceChildren();
        pcapState.resultOffset = 0;
        pcapState.resultTotal = 0;
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
            if (!jobId) throw new Error('The PCAP Analyzer did not return a job identifier.');
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

    async function downloadPcapCsv() {
        if (!pcapState.jobId) return;
        try {
            const response = await fetch(`${API_ROOT}/jobs/${encodeURIComponent(pcapState.jobId)}/csv`, {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            if (!response.ok) throw new Error(`CSV download failed with HTTP ${response.status}.`);
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'pcap-analysis.csv';
            link.rel = 'noopener';
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error) {
            handlePcapError(error);
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
        element('pcapFindingFilter').addEventListener('change', () => {
            loadPcapResults(0).catch(handlePcapError);
        });
        element('pcapPreviousPage').addEventListener('click', () => {
            loadPcapResults(Math.max(0, pcapState.resultOffset - RESULT_PAGE_LIMIT)).catch(handlePcapError);
        });
        element('pcapNextPage').addEventListener('click', () => {
            loadPcapResults(pcapState.resultOffset + RESULT_PAGE_LIMIT).catch(handlePcapError);
        });
        element('pcapDownloadCsv').addEventListener('click', downloadPcapCsv);
        setMode('upload');
        pcapState.initialized = true;
    }

    window.PcapAnalyzer = Object.freeze({
        buildCollectionWindow: buildPcapCollectionWindow,
        start: startPcapAnalysis,
        cancel: cancelPcapAnalysis,
        poll: pollPcapJob
    });

    featureRegistry.register('pcap-analyzer', {
        initialize: initializePcapAnalyzer,
        activate() {
            pcapState.active = true;
            if (pcapState.jobId && !TERMINAL_STATES.has(pcapState.jobState)) {
                schedulePcapPoll(pcapState.jobId);
            }
        },
        cancel() {
            return cancelPcapAnalysis({ remote: true });
        },
        deactivate() {
            pcapState.active = false;
            stopPcapPolling();
        }
    });
})();
