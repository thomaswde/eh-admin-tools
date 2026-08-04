const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('System Health initialization does not fetch and concurrent catalog loads share one request', async () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'modules', 'system-health-report.js'),
        'utf8'
    );
    let definition;
    let fetchCalls = 0;
    let resolveFetch;
    const fetchPromise = new Promise(resolve => { resolveFetch = resolve; });
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        DOMException,
        document: {
            getElementById() { return null; },
            querySelectorAll() { return []; }
        },
        window: {
            addEventListener() {},
            initChartThemePanel() {}
        },
        featureRegistry: {
            register(name, hooks) {
                assert.equal(name, 'system-health');
                definition = hooks;
            }
        },
        fetch() {
            fetchCalls += 1;
            return fetchPromise;
        }
    });
    vm.runInContext(source, context);

    await definition.initialize();
    assert.equal(fetchCalls, 0);
    const first = definition.activate();
    const second = vm.runInContext('loadSystemHealthCatalog()', context);
    assert.equal(fetchCalls, 1);
    resolveFetch({
        ok: true,
        json: async () => ({ loaded: true, models: [] })
    });
    await Promise.all([first, second]);
    assert.equal(fetchCalls, 1);
});

test('offline System Health keeps import enabled and blocks live collection before proxy calls', async () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'modules', 'system-health-report.js'),
        'utf8'
    );
    let definition;
    let fetchCalls = 0;
    const elements = new Map();
    function element(id) {
        if (!elements.has(id)) {
            elements.set(id, {
                id,
                disabled: false,
                hidden: false,
                textContent: '',
                title: '',
                style: {},
                addEventListener() {},
                setAttribute() {},
                querySelector() { return null; },
                replaceChildren() {}
            });
        }
        return elements.get(id);
    }
    const window = {
        state: { connected: false, runtimeContext: 'offline', apiConfig: null },
        addEventListener() {},
        initChartThemePanel() {},
        apiClient: {
            async getAppliances() {
                throw new Error('upstream transport should not run');
            }
        }
    };
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        DOMException,
        window,
        document: {
            getElementById: element,
            querySelectorAll() { return []; }
        },
        runtimeContextForState: () => 'offline',
        runtimeSupportsAction(_runtime, actionName) {
            return ['systemHealth.import', 'systemHealth.exportLocal'].includes(actionName);
        },
        featureRegistry: {
            register(_name, hooks) { definition = hooks; }
        },
        fetch: async () => {
            fetchCalls += 1;
            return { ok: true, json: async () => ({ loaded: true, models: [] }) };
        }
    });
    vm.runInContext(source, context);

    await definition.initialize();
    await definition.activate();
    await vm.runInContext('generateSystemHealthReport()', context);

    assert.equal(element('runSystemHealthReport').disabled, true);
    assert.equal(element('systemHealthLoadCsvButton').disabled, false);
    assert.equal(element('systemHealthCollectCapabilityHint').hidden, false);
    assert.equal(fetchCalls, 1);
});

test('oversized CSV selection is rejected before File.text and preserves the current report', async () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'modules', 'system-health-report.js'),
        'utf8'
    );
    const status = { textContent: '', style: {} };
    const markerReport = { source_type: 'summary_csv', marker: true };
    let textCalls = 0;
    const context = vm.createContext({
        console,
        markerReport,
        window: {},
        document: {
            getElementById(id) { return id === 'systemHealthCsvStatus' ? status : null; }
        }
    });
    vm.runInContext(source, context);
    vm.runInContext('systemHealthState.currentReport = markerReport', context);
    const event = {
        target: {
            value: 'selected.csv',
            files: [{
                name: 'oversized.csv',
                size: (5 * 1024 * 1024) + 1,
                async text() { textCalls += 1; return ''; }
            }]
        }
    };

    context.testEvent = event;
    await vm.runInContext('loadSystemHealthCsvFiles(testEvent)', context);

    assert.equal(textCalls, 0);
    assert.equal(vm.runInContext('systemHealthState.currentReport === markerReport', context), true);
    assert.match(status.textContent, /byte limit/);
});

test('Nodemap initialization installs listeners without starting its activation request', async () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'modules', 'nodemap.js'),
        'utf8'
    );
    let definition;
    let applianceRequests = 0;
    const element = {
        style: {},
        addEventListener() {},
        getAttribute() { return null; },
        setAttribute() {},
        focus() {}
    };
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        state: { connected: true },
        document: {
            addEventListener() {},
            getElementById() { return element; },
            querySelectorAll() { return []; }
        },
        window: {
            apiClient: {
                async getAppliances() {
                    applianceRequests += 1;
                    return [];
                }
            }
        },
        genericChartPrimaryColor() { return '#000'; },
        genericChartPaletteColor() { return '#000'; },
        featureRegistry: {
            register(name, hooks) {
                assert.equal(name, 'nodemap');
                definition = hooks;
            }
        }
    });
    vm.runInContext(source, context);

    await definition.initialize();
    assert.equal(applianceRequests, 0);
});
