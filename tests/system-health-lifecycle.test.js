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
