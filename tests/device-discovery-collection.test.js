const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ReportCacheValidation = require('../js/utils/report-cache-validation.js');

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
        genericChartPaletteColor: () => '#7655c8',
        stateIndicatorColor: () => '#f59e0b',
        escapeHtml: value => String(value),
        alert: overrides.alert || (() => {}),
        ReportCacheValidation
    });
    vm.runInContext(`${source}\nwindow.__deviceDiscoveryTest = { deviceDiscoveryState, getPeriodRange, fetchDevicesBatch, renderDeviceDiscoveryTable, buildDeviceDiscoveryResult, validateDeviceDiscoveryCachePayload, generateDeviceDiscoveryReport, stopDeviceDiscoveryLoad };`, context);
    return { api: window.__deviceDiscoveryTest, elements };
}

test('report generation reaches appliance collection and restores controls after an inventory failure', async () => {
    const elements = {
        deviceDiscoveryLoading: { style: {} },
        deviceDiscoveryResults: { style: {} },
        deviceNoDataMessage: { style: {} },
        generateDeviceReport: { style: {}, disabled: false },
        stopDeviceDiscoveryLoad: { style: {} },
        deviceLoadingText: { textContent: '' }
    };
    const alerts = [];
    let applianceRequests = 0;
    const { api } = loadDeviceDiscovery({
        elements,
        alert: message => alerts.push(message),
        apiClient: {
            async getAppliances() {
                applianceRequests += 1;
                throw new Error('inventory unavailable');
            }
        }
    });

    await api.generateDeviceDiscoveryReport();

    assert.equal(applianceRequests, 1);
    assert.equal(elements.deviceDiscoveryLoading.style.display, 'none');
    assert.equal(elements.deviceDiscoveryResults.style.display, 'none');
    assert.equal(elements.generateDeviceReport.disabled, false);
    assert.equal(elements.generateDeviceReport.style.display, 'block');
    assert.equal(elements.stopDeviceDiscoveryLoad.style.display, 'none');
    assert.match(alerts[0], /inventory unavailable/);
});

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

test('every device page reuses one absolute activity window', () => {
    const { api } = loadDeviceDiscovery();
    const nowMs = Date.parse('2026-07-26T19:30:00Z');
    const week = JSON.parse(JSON.stringify(api.getPeriodRange('week', nowMs)));
    const month = JSON.parse(JSON.stringify(api.getPeriodRange('month', nowMs)));
    const yesterday = JSON.parse(JSON.stringify(api.getPeriodRange('yesterday', nowMs)));

    assert.equal(week.activeUntil, nowMs);
    assert.equal(month.activeUntil, nowMs);
    assert.equal(yesterday.activeUntil - yesterday.activeFrom, 24 * 60 * 60 * 1000);
    assert.notEqual(yesterday.activeUntil, 0);
});

test('completed device cache payload keeps one window and the active connection filters', () => {
    const { api } = loadDeviceDiscovery();
    api.deviceDiscoveryState.includeEfc = false;
    api.deviceDiscoveryState.includeDiscovery = true;
    api.deviceDiscoveryState.appliances = [
        { id: 'sensor-1', display_name: 'Sensor', license_platform: 'EDA 9300' },
        { id: 'flow-1', display_name: 'Flow', license_platform: 'EFC VM' }
    ];
    api.deviceDiscoveryState.applianceMap = {
        'sensor-1': api.deviceDiscoveryState.appliances[0],
        'flow-1': api.deviceDiscoveryState.appliances[1]
    };
    const range = { label: 'Yesterday', displayRange: 'Aug 4, 2026', activeFrom: 1, activeUntil: 2 };
    const payload = api.buildDeviceDiscoveryResult({
        aggregate: {
            'sensor-1': { advanced: 2, standard: 0, discovery: 1, flow_log: 0, total: 3 },
            'flow-1': { advanced: 0, standard: 0, discovery: 0, flow_log: 5, total: 5 }
        },
        perLevelTotals: { advanced: 2, standard: 0, discovery: 1, flow_log: 5 },
        totalDevices: 8,
        incomplete: false,
        detail: 'complete'
    }, range);

    assert.equal(payload.range, range);
    assert.equal(payload.projectionVersion, 1);
    assert.equal(payload.totalDevices, undefined);
    assert.equal(payload.totals.totalDevices, 3);
    assert.deepEqual(Array.from(payload.sortedNodes, row => row.id), ['sensor-1']);
    assert.equal(payload.includeDiscovery, true);
    assert.equal(payload.incomplete, false);
    assert.equal(api.validateDeviceDiscoveryCachePayload(payload), payload);
});

test('device cache validation rejects nested count corruption before rendering', () => {
    const { api } = loadDeviceDiscovery();
    const payload = {
        projectionVersion: 1,
        selectedPeriod: 'yesterday',
        includeEfc: false,
        includeDiscovery: false,
        appliances: [{ id: '1', display_name: 'Sensor' }],
        range: { label: 'Yesterday', displayRange: 'Aug 4, 2026', activeFrom: 1, activeUntil: 2 },
        totals: {
            aggregate: { '1': { advanced: 1, standard: 0, discovery: 0, flow_log: 0, total: 1 } },
            perLevelTotals: { advanced: 1, standard: 0, discovery: 0, flow_log: 0 },
            totalDevices: 1
        },
        sortedNodes: [{
            id: '1',
            label: 'Sensor',
            counts: { advanced: 1, standard: 0, discovery: 0, flow_log: 0, total: 2 }
        }],
        incomplete: false,
        detail: ''
    };

    assert.throws(() => api.validateDeviceDiscoveryCachePayload(payload), /does not match/);
});

test('device pagination enforces row and page budgets with explicit partial reasons', async () => {
    const requests = [];
    const { api } = loadDeviceDiscovery({
        apiClient: {
            async request(_endpoint, options) {
                requests.push(JSON.parse(options.body));
                return Array.from({ length: 5000 }, (_, index) => ({
                    id: `${requests.length}:${index}`,
                    node_id: 'sensor-1',
                    analysis: 'advanced'
                }));
            }
        }
    });
    const range = { activeFrom: 100, activeUntil: 200 };
    const rowLimited = await api.fetchDevicesBatch(range, new AbortController().signal, {
        maxPages: 5,
        maxRows: 6000
    });
    assert.equal(rowLimited.incomplete, true);
    assert.equal(rowLimited.reason, 'row_budget');
    assert.equal(rowLimited.rowsFetched, 6000);
    assert.equal(rowLimited.totalDevices, 6000);
    assert.ok(requests.every(request => request.active_from === 100 && request.active_until === 200));

    requests.length = 0;
    const pageLimited = await api.fetchDevicesBatch(range, new AbortController().signal, {
        maxPages: 1,
        maxRows: 10000
    });
    assert.equal(pageLimited.incomplete, true);
    assert.equal(pageLimited.reason, 'page_budget');
    assert.equal(pageLimited.pagesFetched, 1);
});

test('device pagination preserves prior pages when a later page fails', async () => {
    let calls = 0;
    const { api } = loadDeviceDiscovery({
        apiClient: {
            async request() {
                calls += 1;
                if (calls === 2) throw new Error('upstream unavailable');
                return Array.from({ length: 5000 }, (_, index) => ({
                    id: `${index}`,
                    node_id: 'sensor-1',
                    analysis: 'standard'
                }));
            }
        }
    });

    const result = await api.fetchDevicesBatch(
        { activeFrom: 100, activeUntil: 200 },
        new AbortController().signal
    );
    assert.equal(result.incomplete, true);
    assert.equal(result.reason, 'failed');
    assert.equal(result.rowsFetched, 5000);
    assert.equal(result.totalDevices, 5000);
    assert.match(result.detail, /later page failed.*upstream unavailable/);
});
