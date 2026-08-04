const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'modules', 'pcap-analyzer.js'),
    'utf8'
);

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
        async json() { return body; },
        async blob() { return body; }
    };
}

function createHarness(responses = []) {
    const ids = [
        'pcapUploadFields', 'pcapCollectFields', 'pcapStartButton', 'pcapCancelButton',
        'pcapFileInput', 'pcapLookbackMinutes', 'pcapWindowSeconds', 'pcapStatusCard',
        'pcapProgressBar', 'pcapWarnings', 'pcapStateBadge', 'pcapStatusText',
        'pcapResults', 'pcapDownloadCsv', 'pcapSummary', 'pcapFindingFilter',
        'pcapResultsBody', 'pcapResultsEmpty', 'pcapResultsTable', 'pcapPager',
        'pcapPagerInfo', 'pcapPreviousPage', 'pcapNextPage'
    ];
    const elements = Object.fromEntries(ids.map(id => [id, fakeElement(id)]));
    const progressTrack = fakeElement('progress');
    elements.pcapStatusCard.querySelector = selector => {
        assert.equal(selector, '[role="progressbar"]');
        return progressTrack;
    };
    elements.pcapLookbackMinutes.valueAsNumber = 5;
    elements.pcapWindowSeconds.valueAsNumber = 60;
    const modeButtons = [fakeElement('local', 'button'), fakeElement('connected', 'button')];
    modeButtons[0].dataset.pcapMode = 'upload';
    modeButtons[1].dataset.pcapMode = 'collect';

    const calls = [];
    const timers = new Map();
    let timerId = 0;
    let definition;
    class FixedDate extends Date {
        static now() { return Date.parse('2026-08-03T15:00:00.000Z'); }
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
        window: {},
        setTimeout(callback) {
            timerId += 1;
            timers.set(timerId, callback);
            return timerId;
        },
        clearTimeout(id) { timers.delete(id); },
        document: {
            body: fakeElement('body', 'body'),
            getElementById(id) { return elements[id] || null; },
            querySelectorAll(selector) {
                assert.equal(selector, '[data-pcap-mode]');
                return modeButtons;
            },
            createElement(tagName) { return fakeElement('', tagName); }
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
    return { context, definition, elements, modeButtons, calls, timers, progressTrack };
}

test('registers the PCAP Analyzer and uploads the selected File as the raw request body', async () => {
    const file = { name: 'capture.pcap', marker: 'raw-file-body' };
    const harness = createHarness([
        jsonResponse({ id: 'job-upload', state: 'queued' }, 202),
        jsonResponse({
            id: 'job-upload',
            state: 'completed',
            completeness: 'complete',
            progress: 100,
            summary: { packet_count: 12, flow_count: 2, finding_count: 1 },
            warnings: []
        }),
        jsonResponse({
            items: [{
                findingKinds: ['reverse_not_observed'],
                source: { ip: '10.0.0.1', port: 12345 },
                destination: { ip: '10.0.0.2', port: 443 },
                packets: 12,
                detail: 'Only one direction was present in the capture.'
            }],
            total: 1,
            offset: 0,
            limit: 100
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
    assert.equal(harness.elements.pcapResults.hidden, false);
    assert.equal(harness.elements.pcapResultsBody.children.length, 1);
    assert.equal(
        harness.elements.pcapResultsBody.children[0].children[0].textContent,
        'Reverse direction not observed'
    );
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
        untilMs: Date.parse('2026-08-03T15:00:00.000Z'),
        windowSeconds: 60
    });
    assert.equal(harness.progressTrack.attributes['aria-valuenow'], '33');
    assert.equal(harness.timers.size, 1);
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
    assert.match(harness.elements.pcapStatusText.textContent, /Indeterminate result/);
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

test('collection window rejects unbounded lookback and packet-search windows', () => {
    const harness = createHarness();
    const api = vm.runInContext('window.PcapAnalyzer.buildCollectionWindow', harness.context);
    assert.throws(() => api(11, 60, 1000), /Lookback/);
    assert.throws(() => api(5, 301, 1000), /Search window/);
});
