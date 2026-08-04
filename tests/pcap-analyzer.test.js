const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'modules', 'pcap-analyzer.js'),
    'utf8'
);
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

class FakeClassList {
    constructor(owner) {
        this.owner = owner;
        this.values = new Set();
    }

    add(...names) { names.forEach(name => this.values.add(name)); }
    remove(...names) { names.forEach(name => this.values.delete(name)); }
    toggle(name, force) {
        const enabled = force === undefined ? !this.values.has(name) : force;
        if (enabled) this.values.add(name);
        else this.values.delete(name);
        return enabled;
    }
}

function fakeElement(id = '', tagName = 'div') {
    const listeners = {};
    const attributes = {};
    const node = {
        id,
        tagName: tagName.toUpperCase(),
        dataset: {},
        style: {},
        hidden: false,
        disabled: false,
        value: '',
        valueAsNumber: Number.NaN,
        files: [],
        className: '',
        textContent: '',
        children: [],
        attributes,
        addEventListener(name, handler) { listeners[name] = handler; },
        setAttribute(name, value) { attributes[name] = String(value); },
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); return child; },
        replaceChildren(...children) { this.children = [...children]; },
        querySelector() { return null; },
        click() { listeners.click?.({ currentTarget: this, target: this }); },
        remove() {},
        dispatch(name) { return listeners[name]?.({ currentTarget: this, target: this }); }
    };
    node.classList = new FakeClassList(node);
    return node;
}

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get() { return null; } },
        async json() { return body; },
        async blob() { return body; }
    };
}

function csvResponse(body, filename) {
    return {
        ok: true,
        status: 200,
        headers: {
            get(name) {
                return name.toLowerCase() === 'content-disposition'
                    ? `attachment; filename="${filename}"`
                    : null;
            }
        },
        async blob() { return body; }
    };
}

function resultRow(index = 1, overrides = {}) {
    return {
        flowKey: `10.0.0.${index}:1000 -> 10.0.1.${index}:443/tcp`,
        sourceAddress: `10.0.0.${index}`,
        sourcePort: 1000 + index,
        destinationAddress: `10.0.1.${index}`,
        destinationPort: 443,
        packetCount: 100 - index,
        capturedBytes: 1000 - index,
        firstTimestamp: 1_722_000_000 + index,
        lastTimestamp: 1_722_000_100 + index,
        connectionEpochs: 1,
        sequenceGapObservations: 2,
        sequenceGapBytes: 200 - index,
        findingKinds: ['reverse_not_observed'],
        ...overrides
    };
}

function dashboard(overrides = {}) {
    return {
        schemaVersion: 1,
        findingCounts: {
            affectedFlows: 2,
            reverseNotObservedFlows: 1,
            sequenceGapFlows: 1,
            sequenceGapObservations: 2,
            sequenceGapBytes: 199,
            truncatedFlows: 0
        },
        topReverse: [resultRow(1)],
        topSequenceGaps: [resultRow(1, { findingKinds: ['sequence_gap'] })],
        enrichment: {
            status: 'complete', addressesConsidered: 4, addressesMatched: 1,
            addressesAmbiguous: 0, addressesOmitted: 0, timeConstrained: true
        },
        ...overrides
    };
}

function createHarness(responses = [], options = {}) {
    const ids = [
        'pcapUploadFields', 'pcapCollectFields', 'pcapStartButton', 'pcapCancelButton',
        'pcapConnectedCapabilityHint',
        'pcapFileInput', 'pcapLookbackMinutes', 'pcapStatusCard',
        'pcapProgressTrack', 'pcapProgressBar', 'pcapWarnings', 'pcapStateBadge', 'pcapStatusText',
        'pcapResults', 'pcapSummary', 'pcapFindingHeroes', 'pcapEnrichmentStatus', 'pcapExportStatus',
        'pcapDownloadAllFindingsCsv', 'pcapDownloadReverseCsv', 'pcapDownloadSequenceGapCsv',
        'pcapReverseChartEmpty', 'pcapReverseChartFrame', 'pcapReverseChart',
        'pcapSequenceGapChartEmpty', 'pcapSequenceGapChartFrame', 'pcapSequenceGapChart',
        'pcapReverseResultsBody', 'pcapReverseResultsEmpty', 'pcapReverseResultsTable',
        'pcapSequenceGapResultsBody', 'pcapSequenceGapResultsEmpty', 'pcapSequenceGapResultsTable'
    ];
    const elements = Object.fromEntries(ids.map(id => [id, fakeElement(id)]));
    const progressTrack = elements.pcapProgressTrack;
    elements.pcapLookbackMinutes.valueAsNumber = 5;
    const modeButtons = [fakeElement('local', 'button'), fakeElement('connected', 'button')];
    modeButtons[0].dataset.pcapMode = 'upload';
    modeButtons[1].dataset.pcapMode = 'collect';
    elements.pcapLocalMode = modeButtons[0];
    elements.pcapConnectedMode = modeButtons[1];
    const calls = [];
    const charts = [];
    const anchors = [];
    const timers = new Map();
    let timerId = 0;
    let definition;
    class FixedDate extends Date {
        static now() { return Date.parse('2026-08-03T15:00:00.000Z'); }
    }
    const window = {
        innerWidth: 1200,
        addEventListener() {},
        state: options.appState || { connected: true, apiConfig: { type: 'enterprise' } }
    };
    if (options.withChartTheme !== false) {
        window.chartThemeResolvedColors = () => ({
            bg: '#fff', text: '#111', muted: '#666', grid: '#ddd',
            low: '#00a', mid: '#fa0', high: '#e00'
        });
    }
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        Date: FixedDate,
        Number,
        Object,
        String,
        Set,
        URLSearchParams,
        URL: {
            createObjectURL() { return 'blob:test'; },
            revokeObjectURL() {}
        },
        AbortController,
        encodeURIComponent,
        window,
        runtimeContextForState() {
            return options.runtimeContext || 'enterprise';
        },
        runtimeSupportsAction(runtimeContext, actionName) {
            return typeof options.actionSupport === 'function'
                ? options.actionSupport(runtimeContext, actionName)
                : true;
        },
        getComputedStyle() {
            const colors = {
                '--raised': '#1e1d27',
                '--ink': '#ececf2',
                '--gray': '#9b9ba6',
                '--hairline': '#2e2d3a'
            };
            return { getPropertyValue(property) { return colors[property] || ''; } };
        },
        Chart: class FakeChart {
            constructor(target, config) {
                this.target = target;
                this.config = config;
                this.destroyed = false;
                charts.push(this);
            }
            destroy() { this.destroyed = true; }
        },
        setTimeout(callback) {
            timerId += 1;
            timers.set(timerId, callback);
            return timerId;
        },
        clearTimeout(id) { timers.delete(id); },
        document: {
            body: fakeElement('body', 'body'),
            documentElement: fakeElement('html', 'html'),
            getElementById(id) { return elements[id] || null; },
            querySelectorAll(selector) {
                if (selector === '[data-pcap-mode]') return modeButtons;
                assert.fail(`Unexpected selector: ${selector}`);
            },
            createElement(tagName) {
                const node = fakeElement('', tagName);
                if (String(tagName).toLowerCase() === 'a') {
                    node.click = () => { node.clicked = true; };
                    anchors.push(node);
                }
                return node;
            }
        },
        async fetch(url, options = {}) {
            calls.push({ url, options });
            const next = responses.shift();
            if (!next) throw new Error(`Unexpected request to ${url}`);
            return typeof next === 'function' ? next(url, options) : next;
        },
        featureRegistry: {
            register(name, hooks) {
                assert.equal(name, 'pcap-analyzer');
                definition = hooks;
            }
        }
    });
    vm.runInContext(source, context, { filename: 'pcap-analyzer.js' });
    return {
        context, definition, elements, modeButtons, calls, charts,
        anchors, timers, progressTrack
    };
}

test('presents the feature as Datafeed Analysis', () => {
    assert.match(html, /data-module="pcap-analyzer"[\s\S]*?<span class="nav-title">Datafeed Analysis<\/span>/);
    assert.match(html, /id="pcap-analyzerModule"[\s\S]*?<h1 class="page-title">Datafeed Analysis<\/h1>/);
    assert.doesNotMatch(html, /id="pcapFindingFilter"|id="pcapPager"/);
    assert.match(html, /id="pcapFindingHeroes"/);
    assert.doesNotMatch(html, /Reverse visibility|Affected flows by finding|Counts describe the entire bounded analysis result/);
    assert.match(html, /A packetstore does not necessarily receive the exact same datafeed as a Packet Sensor/);
    assert.doesNotMatch(html, /pcapWindowSeconds|data-pcap-chart-mode/);
    assert.match(html, /class="pcap-chart-grid"/);
    assert.match(html, /dropped, filtered, or sliced capture data.*do not by themselves prove network packet loss/);
});

test('registers Datafeed Analysis and uploads the selected File as the raw request body', async () => {
    const file = { name: 'capture.pcap', marker: 'raw-file-body' };
    const harness = createHarness([
        jsonResponse({ id: 'job-upload', state: 'queued' }, 202),
        jsonResponse({
            id: 'job-upload',
            state: 'completed',
            completeness: 'complete',
            progress: 100,
            summary: { packetCount: 12, flowCount: 2 },
            dashboard: dashboard(),
            warnings: []
        })
    ]);
    harness.elements.pcapFileInput.files = [file];

    harness.definition.initialize();
    await harness.definition.activate();
    await vm.runInContext('window.PcapAnalyzer.start()', harness.context);

    assert.equal(harness.calls[0].url, '/backend/pcap-analyzer/upload');
    assert.equal(harness.calls[0].options.method, 'POST');
    assert.equal(harness.calls[0].options.body, file);
    assert.equal(harness.calls[0].options.headers['Content-Type'], 'application/vnd.tcpdump.pcap');
    assert.equal(harness.elements.pcapStateBadge.textContent, 'Completed');
    assert.equal(harness.elements.pcapStatusText.hidden, true);
    assert.equal(harness.elements.pcapStatusText.textContent, '');
    assert.equal(harness.progressTrack.hidden, true);
    assert.equal(harness.elements.pcapResults.hidden, false);
    assert.equal(harness.calls.length, 2);
    assert.equal(harness.elements.pcapReverseResultsBody.children.length, 1);
    assert.equal(harness.elements.pcapSequenceGapResultsBody.children.length, 1);
    assert.equal(
        harness.elements.pcapReverseResultsBody.children[0].children[0].children[0].textContent,
        '10.0.0.1:1001'
    );
    assert.equal(harness.elements.pcapSummary.children.length, 4);
    assert.equal(harness.elements.pcapSummary.children[3].children[0].textContent, 'Captured bytes');
    assert.equal(harness.elements.pcapFindingHeroes.children.length, 3);
    assert.equal(harness.elements.pcapFindingHeroes.children[0].children[0].textContent, 'Unidirectional flows');
    assert.equal(harness.elements.pcapFindingHeroes.children[0].children[1].textContent, '50%');
    assert.equal(harness.elements.pcapFindingHeroes.children[0].children[2].textContent, '1 of 2 directional flows');
});

test('renders completed analysis with app CSS colors when the chart theme export is unavailable', async () => {
    const harness = createHarness([
        jsonResponse({ id: 'job-theme-fallback', state: 'queued' }, 202),
        jsonResponse({
            id: 'job-theme-fallback', state: 'completed', completeness: 'complete', progress: 100,
            summary: { packetCount: 12, flowCount: 2 }, dashboard: dashboard()
        })
    ], { withChartTheme: false });
    harness.definition.initialize();
    await harness.definition.activate();
    harness.elements.pcapFileInput.files = [{ name: 'capture.pcap' }];

    await vm.runInContext('window.PcapAnalyzer.start()', harness.context);

    assert.equal(harness.elements.pcapStateBadge.textContent, 'Completed');
    assert.equal(harness.charts.length, 2);
    assert.equal(harness.charts[0].config.options.scales.y.ticks.color, '#ececf2');
    assert.equal(harness.charts[0].config.options.scales.x.grid.color, '#2e2d3a');
    assert.equal(harness.charts[0].config.data.datasets[0].backgroundColor, '#00aaef');
});

test('renders at most 25 canonical rows with IP primary and useful device name secondary', async () => {
    const reverseRows = Array.from({ length: 30 }, (_, index) => resultRow(index + 1));
    reverseRows[0].sourceDevice = { displayName: 'web-prod-07', matchStatus: 'unique', matchCount: 1 };
    reverseRows[0].destinationDevice = { matchStatus: 'ambiguous', matchCount: 2 };
    const harness = createHarness([
        jsonResponse({ id: 'job-top', state: 'queued' }, 202),
        jsonResponse({
            id: 'job-top', state: 'completed', completeness: 'complete', progress: 100,
            summary: { packetCount: 500, flowCount: 30 },
            dashboard: dashboard({
                findingCounts: {
                    affectedFlows: 30, reverseNotObservedFlows: 30, sequenceGapFlows: 1,
                    sequenceGapObservations: 2, sequenceGapBytes: 199, truncatedFlows: 0
                },
                topReverse: reverseRows
            })
        })
    ]);
    harness.definition.initialize();
    await harness.definition.activate();
    harness.elements.pcapFileInput.files = [{ name: 'capture.pcap' }];

    await vm.runInContext('window.PcapAnalyzer.start()', harness.context);

    assert.equal(harness.elements.pcapReverseResultsBody.children.length, 25);
    const sourceCell = harness.elements.pcapReverseResultsBody.children[0].children[0];
    const destinationCell = harness.elements.pcapReverseResultsBody.children[0].children[1];
    assert.equal(sourceCell.children[0].textContent, '10.0.0.1:1001');
    assert.equal(sourceCell.children[1].textContent, 'web-prod-07');
    assert.equal(destinationCell.children[0].textContent, '10.0.1.1:443');
    assert.equal(destinationCell.children.length, 1);
    assert.equal(harness.charts[0].config.data.labels.length, 15);
});

test('renders unidirectional and sequence-gap charts together with independent metrics', async () => {
    const harness = createHarness([
        jsonResponse({ id: 'job-mode', state: 'queued' }, 202),
        jsonResponse({
            id: 'job-mode', state: 'completed', completeness: 'partial', progress: 100,
            summary: { packetCount: 12, flowCount: 2 }, dashboard: dashboard()
        })
    ]);
    harness.definition.initialize();
    await harness.definition.activate();
    harness.elements.pcapFileInput.files = [{ name: 'capture.pcap' }];
    await vm.runInContext('window.PcapAnalyzer.start()', harness.context);
    assert.equal(harness.charts.length, 2);
    const [reverseChart, sequenceChart] = harness.charts;
    assert.equal(reverseChart.config.data.datasets[0].label, 'Packets');
    assert.equal(reverseChart.config.data.datasets[0].data[0], 99);
    assert.equal(sequenceChart.config.data.datasets[0].label, 'Observed gap bytes');
    assert.equal(sequenceChart.config.data.datasets[0].data[0], 199);
    assert.match(
        sequenceChart.config.options.plugins.tooltip.callbacks.label({ dataIndex: 0 }),
        /199 observed gap bytes.*2 gaps/
    );
});

test('empty states and export availability are independent by finding category', async () => {
    const harness = createHarness([
        jsonResponse({ id: 'job-empty', state: 'queued' }, 202),
        jsonResponse({
            id: 'job-empty', state: 'completed', completeness: 'complete', progress: 100,
            summary: { packetCount: 12, flowCount: 1 },
            dashboard: dashboard({
                findingCounts: {
                    affectedFlows: 1, reverseNotObservedFlows: 0, sequenceGapFlows: 1,
                    sequenceGapObservations: 2, sequenceGapBytes: 199, truncatedFlows: 0
                },
                topReverse: []
            })
        })
    ]);
    harness.definition.initialize();
    await harness.definition.activate();
    harness.elements.pcapFileInput.files = [{ name: 'capture.pcap' }];
    await vm.runInContext('window.PcapAnalyzer.start()', harness.context);

    assert.equal(harness.elements.pcapReverseResultsEmpty.hidden, false);
    assert.equal(harness.elements.pcapSequenceGapResultsEmpty.hidden, true);
    assert.equal(harness.elements.pcapDownloadAllFindingsCsv.disabled, false);
    assert.equal(harness.elements.pcapDownloadReverseCsv.disabled, true);
    assert.equal(harness.elements.pcapDownloadSequenceGapCsv.disabled, false);
    assert.equal(harness.elements.pcapReverseChartEmpty.hidden, false);
    assert.equal(harness.elements.pcapSequenceGapChartEmpty.hidden, true);
    assert.equal(harness.charts.length, 1);
    assert.equal(harness.charts[0].target, harness.elements.pcapSequenceGapChart);
});

test('scoped CSV controls use server filenames and never export visible top rows locally', async () => {
    const harness = createHarness([
        jsonResponse({ id: 'job-export', state: 'queued' }, 202),
        jsonResponse({
            id: 'job-export', state: 'completed', completeness: 'complete', progress: 100,
            summary: { packetCount: 12, flowCount: 2 }, dashboard: dashboard()
        }),
        csvResponse('all', 'datafeed-analysis-all-findings-job-export.csv'),
        csvResponse('reverse', 'datafeed-analysis-unidirectional-flows-job-export.csv'),
        csvResponse('sequence', 'datafeed-analysis-sequence-gaps-job-export.csv')
    ]);
    harness.definition.initialize();
    await harness.definition.activate();
    harness.elements.pcapFileInput.files = [{ name: 'capture.pcap' }];
    await vm.runInContext('window.PcapAnalyzer.start()', harness.context);

    await harness.elements.pcapDownloadAllFindingsCsv.dispatch('click');
    await harness.elements.pcapDownloadReverseCsv.dispatch('click');
    await harness.elements.pcapDownloadSequenceGapCsv.dispatch('click');

    assert.deepEqual(harness.calls.slice(2).map(call => call.url), [
        '/backend/pcap-analyzer/jobs/job-export/csv?scope=all_findings',
        '/backend/pcap-analyzer/jobs/job-export/csv?scope=reverse_not_observed',
        '/backend/pcap-analyzer/jobs/job-export/csv?scope=sequence_gap'
    ]);
    assert.deepEqual(harness.anchors.map(anchor => anchor.download), [
        'datafeed-analysis-all-findings-job-export.csv',
        'datafeed-analysis-unidirectional-flows-job-export.csv',
        'datafeed-analysis-sequence-gaps-job-export.csv'
    ]);
    assert.match(harness.elements.pcapExportStatus.textContent, /sequence-gaps-job-export\.csv/);
});

test('chart instances are destroyed on deactivation and recreated on activation', async () => {
    const harness = createHarness([
        jsonResponse({ id: 'job-life', state: 'queued' }, 202),
        jsonResponse({
            id: 'job-life', state: 'completed', completeness: 'complete', progress: 100,
            summary: { packetCount: 12, flowCount: 2 }, dashboard: dashboard()
        })
    ]);
    harness.definition.initialize();
    await harness.definition.activate();
    harness.elements.pcapFileInput.files = [{ name: 'capture.pcap' }];
    await vm.runInContext('window.PcapAnalyzer.start()', harness.context);
    const initialCharts = harness.charts.slice();

    await harness.definition.deactivate();
    assert.equal(initialCharts.every(chart => chart.destroyed), true);
    await harness.definition.activate();
    assert.equal(harness.charts.length, initialCharts.length + 2);
});

test('connected collection computes one absolute window and sends the same bounds together', async () => {
    const harness = createHarness([
        jsonResponse({ id: 'job-collect', state: 'queued' }, 202),
        jsonResponse({ id: 'job-collect', state: 'queued', progress: { completed: 1, total: 3 } })
    ]);
    harness.definition.initialize();
    await harness.definition.activate();
    harness.modeButtons[1].click();

    await vm.runInContext('window.PcapAnalyzer.start()', harness.context);

    assert.equal(harness.calls[0].url, '/backend/pcap-analyzer/collect');
    assert.deepEqual(JSON.parse(harness.calls[0].options.body), {
        fromMs: Date.parse('2026-08-03T14:55:00.000Z'),
        untilMs: Date.parse('2026-08-03T15:00:00.000Z')
    });
    assert.equal(harness.progressTrack.attributes['aria-valuenow'], '33');
    assert.equal(harness.timers.size, 1);
});

test('offline mode disables Packetstore retrieval and rejects programmatic collection before fetch', async () => {
    const harness = createHarness([], {
        runtimeContext: 'offline',
        actionSupport(runtimeContext, actionName) {
            assert.equal(runtimeContext, 'offline');
            return actionName !== 'datafeed.collect';
        }
    });
    harness.definition.initialize();
    await harness.definition.activate();

    assert.equal(harness.elements.pcapConnectedMode.disabled, true);
    assert.equal(harness.elements.pcapConnectedCapabilityHint.hidden, false);
    const selected = vm.runInContext("window.PcapAnalyzer.setMode('collect')", harness.context);
    assert.equal(selected, false);
    assert.equal(harness.calls.length, 0);
});

test('renders an explicit warning when uniform packet slicing is suspected', async () => {
    const harness = createHarness([
        jsonResponse({ id: 'job-sliced', state: 'queued' }, 202),
        jsonResponse({
            id: 'job-sliced',
            state: 'completed',
            completeness: 'indeterminate',
            summary: { packets: 30, flows: 1, findings: 0, suspected_uniform_slicing: true }
        }),
        jsonResponse({ items: [], total: 0, offset: 0, limit: 100 })
    ]);
    harness.definition.initialize();
    await harness.definition.activate();
    harness.elements.pcapFileInput.files = [{ name: 'slice.pcap' }];

    await vm.runInContext('window.PcapAnalyzer.start()', harness.context);

    assert.equal(harness.elements.pcapWarnings.children.length, 1);
    assert.match(harness.elements.pcapWarnings.children[0].textContent, /suspiciously uniform captured length/i);
    assert.equal(harness.elements.pcapStatusText.hidden, true);
    assert.equal(harness.elements.pcapStatusText.textContent, '');
    assert.equal(harness.progressTrack.hidden, true);
    assert.equal(harness.elements.pcapFindingHeroes.children.length, 3);
    assert.equal(harness.elements.pcapFindingHeroes.children[0].children[1].textContent, '0%');
    assert.equal(harness.elements.pcapDownloadAllFindingsCsv.disabled, true);
});

test('cancel stops polling and asks the backend to cancel a nonterminal job', async () => {
    const harness = createHarness([
        jsonResponse({ id: 'job-cancel', state: 'queued' }, 202),
        jsonResponse({ id: 'job-cancel', state: 'collecting', progress: 10 }),
        jsonResponse(null, 204)
    ]);
    harness.definition.initialize();
    await harness.definition.activate();
    harness.elements.pcapFileInput.files = [{ name: 'long.pcap' }];
    await vm.runInContext('window.PcapAnalyzer.start()', harness.context);
    assert.equal(harness.timers.size, 1);

    await vm.runInContext('window.PcapAnalyzer.cancel()', harness.context);

    assert.equal(harness.timers.size, 0);
    assert.equal(harness.calls[2].url, '/backend/pcap-analyzer/jobs/job-cancel');
    assert.equal(harness.calls[2].options.method, 'DELETE');
    assert.equal(harness.elements.pcapStateBadge.textContent, 'Cancelled');
});

test('cancel aborts an upload before a backend job identifier is available', async () => {
    const harness = createHarness([
        (_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
            });
        })
    ]);
    harness.definition.initialize();
    await harness.definition.activate();
    harness.elements.pcapFileInput.files = [{ name: 'large.pcap' }];
    const start = vm.runInContext('window.PcapAnalyzer.start()', harness.context);

    await vm.runInContext('window.PcapAnalyzer.cancel()', harness.context);
    await assert.rejects(start, error => error.name === 'AbortError');

    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].options.signal.aborted, true);
    assert.equal(harness.elements.pcapStateBadge.textContent, 'Cancelled');
});

test('collection window rejects unbounded lookback and invalid end time', () => {
    const harness = createHarness();
    const api = vm.runInContext('window.PcapAnalyzer.buildCollectionWindow', harness.context);
    assert.throws(() => api(11, 1000), /Lookback/);
    assert.throws(() => api(5, Number.POSITIVE_INFINITY), /end time/);
});
