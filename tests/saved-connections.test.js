const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('mixed saved connections are grouped with 360 before Enterprise', () => {
    const context = vm.createContext({ console });
    vm.runInContext(source('js/auth/auth-manager.js'), context);

    const groups = vm.runInContext(`groupSavedConnections([
        { id: 'e-b', type: 'enterprise', label: 'sensor-b' },
        { id: 'c-z', type: '360', label: 'zulu' },
        { id: 'c-a', type: '360', label: 'alpha' },
        { id: 'e-a', type: 'enterprise', label: 'sensor-a' }
    ])`, context);

    assert.deepEqual(
        JSON.parse(JSON.stringify(groups)),
        [
            {
                label: 'RevealX 360',
                connections: [
                    { id: 'c-a', type: '360', label: 'alpha' },
                    { id: 'c-z', type: '360', label: 'zulu' }
                ]
            },
            {
                label: 'RevealX Enterprise',
                connections: [
                    { id: 'e-a', type: 'enterprise', label: 'sensor-a' },
                    { id: 'e-b', type: 'enterprise', label: 'sensor-b' }
                ]
            }
        ]
    );
});

test('single-deployment saved connections are sorted without a group heading', () => {
    const context = vm.createContext({ console });
    vm.runInContext(source('js/auth/auth-manager.js'), context);

    const groups = vm.runInContext(`groupSavedConnections([
        { id: 'e-z', type: 'enterprise', label: 'zulu' },
        { id: 'e-a', type: 'enterprise', label: 'alpha' }
    ])`, context);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].label, null);
    assert.deepEqual(
        Array.from(groups[0].connections, item => item.label),
        ['alpha', 'zulu']
    );
});

test('active connection matching selects the loaded Enterprise connection, not the first option', () => {
    const context = vm.createContext({ console });
    vm.runInContext(source('js/auth/auth-manager.js'), context);

    const selectedId = vm.runInContext(`findActiveSavedConnectionId(
        [
            {
                id: 'cloud-first',
                type: '360',
                label: 'extrahop-se',
                tenant: 'extrahop-se'
            },
            {
                id: 'enterprise-active',
                type: 'enterprise',
                label: 'extrahop.thomassmith.co',
                host: 'extrahop.thomassmith.co'
            }
        ],
        {
            type: 'enterprise',
            host: 'extrahop.thomassmith.co'
        }
    )`, context);

    assert.equal(selectedId, 'enterprise-active');
});

test('saved connection picker synchronizes to the active connection and clears unrelated defaults', () => {
    const select = { value: 'cloud-first' };
    const connectButton = { disabled: false };
    let refreshes = 0;
    const state = {
        connected: true,
        apiConfig: {
            type: 'enterprise',
            host: 'extrahop.thomassmith.co'
        }
    };
    const context = vm.createContext({
        console,
        state,
        document: {
            getElementById(id) {
                if (id === 'savedConnectionSelect') return select;
                if (id === 'connectSavedBtn') return connectButton;
                return null;
            }
        },
        window: {
            refreshCustomSelect() {
                refreshes++;
            }
        }
    });
    vm.runInContext(source('js/auth/auth-manager.js'), context);

    vm.runInContext(`
        savedConnectionCatalog = [
            {
                id: 'cloud-first',
                type: '360',
                label: 'extrahop-se',
                tenant: 'extrahop-se'
            },
            {
                id: 'enterprise-active',
                type: 'enterprise',
                label: 'extrahop.thomassmith.co',
                host: 'extrahop.thomassmith.co'
            }
        ];
        syncSavedConnectionSelection();
    `, context);

    assert.equal(select.value, 'enterprise-active');
    assert.equal(connectButton.disabled, false);

    state.apiConfig.host = 'sensor.example.test';
    vm.runInContext('syncSavedConnectionSelection()', context);

    assert.equal(select.value, '');
    assert.equal(connectButton.disabled, true);
    assert.equal(refreshes, 2);
});

test('saved connection authentication sends only the opaque id', async () => {
    const calls = [];
    const context = vm.createContext({
        console,
        window: {},
        fetch: async (url, options) => {
            calls.push({ url, options });
            return {
                ok: true,
                status: 200,
                async text() {
                    return JSON.stringify({
                        connected: true,
                        config: { type: '360', tenant: 'tenant' }
                    });
                }
            };
        }
    });
    vm.runInContext(source('js/api-client/extrahop-api.js'), context);

    const result = await vm.runInContext(`
        (async () => {
            const api = new ExtraHopAPI({ connectionId: '360-saved/id' });
            await api.authenticate();
            return api.config;
        })()
    `, context);

    assert.deepEqual(
        JSON.parse(JSON.stringify(result)),
        { type: '360', tenant: 'tenant' }
    );
    assert.equal(calls[0].url, '/backend/connections/360-saved%2Fid/session');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal('body' in calls[0].options, false);
});

test('saved Enterprise authentication sends a transient proxy token without durable credentials', async () => {
    const calls = [];
    const context = vm.createContext({
        console,
        window: {},
        fetch: async (url, options) => {
            calls.push({ url, options });
            return {
                ok: true,
                status: 200,
                async text() {
                    return JSON.stringify({
                        connected: true,
                        config: { type: 'enterprise', host: 'sensor.lab.local' }
                    });
                }
            };
        }
    });
    vm.runInContext(source('js/api-client/extrahop-api.js'), context);

    await vm.runInContext(`
        (async () => {
            const api = new ExtraHopAPI({
                connectionId: 'enterprise-saved',
                proxyToken: 'single-use-token'
            });
            await api.authenticate();
        })()
    `, context);

    assert.equal(calls[0].url, '/backend/connections/enterprise-saved/session');
    assert.deepEqual(
        JSON.parse(calls[0].options.body),
        { proxyToken: 'single-use-token' }
    );
});

test('saved connection edits send only changed fields', async () => {
    const calls = [];
    const context = vm.createContext({
        console,
        window: {},
        fetch: async (url, options) => {
            calls.push({ url, options });
            return {
                ok: true,
                status: 200,
                async text() {
                    return JSON.stringify({
                        connected: true,
                        config: { type: '360', tenant: 'renamed' }
                    });
                }
            };
        }
    });
    vm.runInContext(source('js/api-client/extrahop-api.js'), context);

    await vm.runInContext(`
        (async () => {
            const api = new ExtraHopAPI({
                connectionId: '360-saved',
                updates: {
                    tenant: 'renamed',
                    apiSecret: 'replacement-secret'
                }
            });
            await api.authenticate();
        })()
    `, context);

    assert.deepEqual(
        JSON.parse(calls[0].options.body),
        {
            updates: {
                tenant: 'renamed',
                apiSecret: 'replacement-secret'
            }
        }
    );
});
