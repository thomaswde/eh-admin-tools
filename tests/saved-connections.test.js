const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('HopCloud proxy-token fields explain how to copy only the cookie value', () => {
    const markup = source('index.html');

    assert.match(markup, /cookie named <code>token<\/code>/);
    assert.match(markup, /Do not include <code>token=<\/code> or the full Cookie header/);
    assert.match(markup, /id="savedEnterpriseProxyToken"/);
    assert.match(markup, /id="enterpriseProxyToken"/);
});

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

test('WSL secure-storage recovery renders an actionable copy workflow', async () => {
    const elements = {
        secureStorageRecovery: { hidden: true },
        secureStorageSetupCommand: { hidden: true, textContent: '' },
        copySecureStorageSetupCommand: { hidden: true, textContent: '' },
        secureStorageRecoveryInstruction: { textContent: '' },
        secureStorageRecoveryStatus: { textContent: '' }
    };
    const copied = [];
    const context = vm.createContext({
        console,
        document: {
            getElementById(id) {
                return elements[id] || null;
            }
        },
        navigator: {
            clipboard: {
                async writeText(value) {
                    copied.push(value);
                }
            }
        }
    });
    vm.runInContext(source('js/auth/auth-manager.js'), context);

    vm.runInContext(`renderSecureStorageRecovery({
        available: false,
        code: 'wsl-secret-service-unavailable',
        recovery: {
            kind: 'wsl-secret-service',
            command: 'sudo apt install gnome-keyring'
        }
    })`, context);

    assert.equal(elements.secureStorageRecovery.hidden, false);
    assert.equal(elements.secureStorageSetupCommand.hidden, false);
    assert.equal(
        elements.secureStorageSetupCommand.textContent,
        'sudo apt install gnome-keyring'
    );
    assert.match(elements.secureStorageRecoveryInstruction.textContent, /WSL terminal/);

    await vm.runInContext('copySecureStorageSetupCommand()', context);

    assert.deepEqual(copied, ['sudo apt install gnome-keyring']);
    assert.equal(elements.copySecureStorageSetupCommand.textContent, 'Copied');
    assert.match(elements.secureStorageRecoveryStatus.textContent, /check again/i);

    vm.runInContext('renderSecureStorageRecovery({ available: true })', context);
    assert.equal(elements.secureStorageRecovery.hidden, true);
});

test('structured WSL recovery replaces only its duplicate status warning', () => {
    const context = vm.createContext({ console });
    vm.runInContext(source('js/auth/auth-manager.js'), context);

    const warnings = vm.runInContext(`visibleSavedConnectionWarnings({
        secureStorage: {
            available: false,
            message: 'Secure saved connections are not set up in WSL.',
            recovery: { kind: 'wsl-secret-service' }
        },
        warnings: [
            'Secure saved connections are not set up in WSL.',
            'Skipped 1 example connection with placeholder values.',
            'Skipped 1 example connection with placeholder values.'
        ]
    })`, context);

    assert.deepEqual(
        Array.from(warnings),
        ['Skipped 1 example connection with placeholder values.']
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

test('secure-storage recheck asks the backend to refresh keyring discovery', async () => {
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
                        connections: [],
                        secureStorage: { available: true, connectionCount: 0 }
                    });
                }
            };
        }
    });
    vm.runInContext(source('js/api-client/extrahop-api.js'), context);

    const result = await vm.runInContext('ExtraHopAPI.recheckSecureStorage()', context);

    assert.equal(result.secureStorage.available, true);
    assert.equal(calls[0].url, '/backend/connections/secure-storage/recheck');
    assert.equal(calls[0].options.method, 'POST');
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
