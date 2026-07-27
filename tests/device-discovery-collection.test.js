const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadDeviceDiscovery(overrides = {}) {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'modules', 'device-discovery.js'),
        'utf8'
    );
    const elements = overrides.elements || {};
    const document = {
        getElementById(id) {
            return elements[id] || null;
        },
        querySelectorAll() {
            return [];
        },
        createElement() {
            return { innerHTML: '', style: {} };
        }
    };
    const window = {
        apiClient: overrides.apiClient || {},
        document
    };
    const context = vm.createContext({
        window,
        document,
        console,
        AbortController,
        DOMException,
        Chart: function Chart() {},
        genericChartPrimaryColor: () => '#00a4e4',
        genericChartPaletteColor: () => '#7655c8',
        stateIndicatorColor: () => '#f59e0b',
        escapeHtml: value => String(value)
    });
    vm.runInContext(`${source}\nwindow.__deviceDiscoveryTest = { deviceDiscoveryState, fetchDevicesBatch, renderDeviceDiscoveryTable, stopDeviceDiscoveryLoad };`, context);
    return { api: window.__deviceDiscoveryTest, elements };
}

test('device pagination deduplicates IDs before counts and totals are accumulated', async () => {
    const firstPage = Array.from({ length: 5000 }, (_, index) => ({
        id: String(index + 1),
        node_id: 'sensor-1',
        analysis: 'advanced'
    }));
    const responses = [
        firstPage,
        [
            { id: '5000', node_id: 'sensor-1', analysis: 'advanced' },
            { id: '5001', node_id: 'sensor-1', analysis: 'flow_log' }
        ]
    ];
    const requestSignals = [];
    const { api } = loadDeviceDiscovery({
        apiClient: {
            async request(_endpoint, options) {
                requestSignals.push(options.signal);
                return responses.shift();
            }
        }
    });
    const controller = new AbortController();

    const result = await api.fetchDevicesBatch({ activeFrom: 1, activeUntil: 2 }, controller.signal);

    assert.equal(result.totalDevices, 5001);
    assert.equal(result.aggregate['sensor-1'].advanced, 5000);
    assert.equal(result.aggregate['sensor-1'].flow_log, 1);
    assert.equal(result.perLevelTotals.flow_log, 1);
    assert.deepEqual(requestSignals, [controller.signal, controller.signal]);
});

test('an aborted active page returns explicit partial results', async () => {
    const controller = new AbortController();
    const { api } = loadDeviceDiscovery({
        apiClient: {
            request(_endpoint, options) {
                return new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                });
            }
        }
    });

    const pending = api.fetchDevicesBatch({ activeFrom: 1, activeUntil: 2 }, controller.signal);
    controller.abort(new DOMException('Stopped', 'AbortError'));
    const result = await pending;

    assert.equal(result.incomplete, true);
    assert.equal(result.totalDevices, 0);
});

test('the detail table exposes flow-log counts that contribute to total devices', () => {
    const rows = [];
    const tbody = { innerHTML: '', appendChild: row => rows.push(row) };
    const emptyState = { style: {} };
    const { api } = loadDeviceDiscovery({
        elements: {
            deviceDetailsBody: tbody,
            deviceTableEmpty: emptyState
        }
    });

    api.renderDeviceDiscoveryTable([
        {
            id: 'sensor-1',
            label: 'Sensor 1',
            counts: { advanced: 1, standard: 2, discovery: 3, flow_log: 4, total: 10 }
        }
    ], {});

    assert.equal(rows.length, 2);
    assert.match(rows[0].innerHTML, /<td>4<\/td>\s*<td>10<\/td>/);
    assert.match(rows[1].innerHTML, /<td>4<\/td>\s*<td>10<\/td>/);
});
