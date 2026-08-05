const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('environment content reset reloads the document', () => {
    let reloads = 0;
    const window = {
        location: {
            reload() {
                reloads++;
            }
        }
    };
    const context = vm.createContext({ window });

    vm.runInContext(source('js/utils/app-state.js'), context);
    window.clearEnvironmentBoundContent();

    assert.equal(reloads, 1);
});

test('successful manual connections reload before opening cached module content', async () => {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) {
            elements.set(id, {
                checked: false,
                disabled: false,
                textContent: '',
                value: '',
                style: {}
            });
        }
        return elements.get(id);
    };

    element('deploymentType').value = 'enterprise';
    element('enterpriseHost').value = 'sensor.example.test';
    element('enterpriseApiKey').value = 'secret';
    element('enterpriseAllowUntrustedTls').checked = false;

    let reloads = 0;
    let applianceOpens = 0;
    const stored = new Map();
    const state = { connected: false, apiConfig: null };
    const window = { apiClient: null };
    class ExtraHopAPI {
        constructor(config) {
            this.config = {
                type: config.type,
                host: config.host,
                verifyTls: config.verifyTls
            };
        }

        async authenticate() {}
    }
    const context = vm.createContext({
        console,
        document: { getElementById: element },
        ExtraHopAPI,
        state,
        window,
        sessionStorage: {
            setItem(key, value) {
                stored.set(key, value);
            },
            removeItem(key) {
                stored.delete(key);
            }
        },
        clearEnvironmentBoundContent() {
            reloads++;
        },
        openConnectedAppliances() {
            applianceOpens++;
        },
        showStatus() {},
        showConnectionError() {}
    });

    vm.runInContext(source('js/auth/auth-manager.js'), context);
    await vm.runInContext('handleConnect()', context);

    assert.equal(reloads, 1);
    assert.equal(applianceOpens, 0);
    assert.equal(state.connected, true);
    assert.equal(window.apiClient.config.host, 'sensor.example.test');
    assert.equal(
        stored.get('eh_config'),
        JSON.stringify({
            type: 'enterprise',
            host: 'sensor.example.test',
            verifyTls: true
        })
    );
});

test('local backend requests always bypass the browser HTTP cache', async () => {
    const calls = [];
    const context = vm.createContext({
        console,
        window: {},
        fetch: async (url, options) => {
            calls.push({ url, options });
            return { ok: true };
        }
    });

    vm.runInContext(source('js/api-client/extrahop-api.js'), context);
    const ExtraHopAPI = vm.runInContext('ExtraHopAPI', context);
    await ExtraHopAPI.backendFetch('/backend/extrahop/api/v1/appliances', {
        method: 'GET',
        cache: 'force-cache'
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.cache, 'no-store');
});

test('ExtraHop proxy requests have a browser deadline that aborts the fetch', async () => {
    let fetchSignal;
    const context = vm.createContext({
        console,
        window: {},
        AbortController,
        Error,
        setTimeout,
        clearTimeout,
        fetch: async (url, options) => {
            fetchSignal = options.signal;
            return await new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            });
        }
    });

    vm.runInContext(source('js/api-client/extrahop-api.js'), context);
    const ExtraHopAPI = vm.runInContext('ExtraHopAPI', context);
    const api = new ExtraHopAPI({});

    await assert.rejects(
        api.request('/metrics/next/198865', { timeoutMs: 5 }),
        error => error.status === 504
            && /timed out/.test(error.message)
            && error.details.status === 'Request Timeout'
    );
    assert.equal(fetchSignal.aborted, true);
});

test('report cache helpers use the connection-scoped local backend routes', async () => {
    const calls = [];
    const context = vm.createContext({
        console,
        window: {},
        fetch: async (url, options) => {
            calls.push({ url, options });
            return {
                status: 200,
                ok: true,
                text: async () => JSON.stringify({ cached: true })
            };
        }
    });
    vm.runInContext(source('js/api-client/extrahop-api.js'), context);
    const ExtraHopAPI = vm.runInContext('ExtraHopAPI', context);

    await ExtraHopAPI.getReportCache('system-health');
    await ExtraHopAPI.saveReportCache('system-health', { report: { source_type: 'api' } });

    assert.equal(calls[0].url, '/backend/report-cache/system-health');
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(calls[1].options.method, 'PUT');
    assert.deepEqual(JSON.parse(calls[1].options.body), { report: { source_type: 'api' } });
});
