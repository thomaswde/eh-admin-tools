const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'modules', 'audit-logs.js'),
    'utf8'
);
const CsvUtils = require('../js/utils/csv.js');

function loadAudit(overrides = {}) {
    const context = vm.createContext({
        console, Date, Number, Object, String, Set, Map, CsvUtils,
        AbortController, DOMException,
        ...overrides
    });
    vm.runInContext(source, context, { filename: 'audit-logs.js' });
    return {
        context,
        api: vm.runInContext(`({
            buildAuditLogWindow,
            processAuditLogData,
            formatDate,
            buildAuditLogCsv,
            selectAuditLogEntriesForExport,
            fetchAuditLogPages,
            stopAuditLogLoad,
            auditLogState
        })`, context)
    };
}

test('filters audit entries by epoch across a year boundary and groups with ISO dates', () => {
    const { context, api } = loadAudit();
    const nowMs = Date.parse('2026-01-02T12:00:00.000Z');
    const window = api.buildAuditLogWindow(3, nowMs);
    assert.equal(window.fromMs, Date.parse('2025-12-31T00:00:00.000Z'));
    assert.deepEqual(Array.from(window.dates), ['2025-12-31', '2026-01-01', '2026-01-02']);

    context.__rows = [
        { id: 1, occur_time: Date.parse('2025-12-30T23:59:59Z'), body: { operation: 'Too Old', user: 'old' } },
        { id: 2, occur_time: Date.parse('2025-12-31T23:59:59Z'), body: { operation: 'Login', user: 'alice' } },
        { id: 3, occur_time: Date.parse('2026-01-01T01:00:00Z'), body: { operation: 'Enable node sensor', user: 'bob' } },
        { id: 4, occur_time: Date.parse('2026-01-02T11:59:59Z'), body: { operation: 'Login', user: 'alice' } },
        { id: 5, occur_time: Date.parse('2026-01-02T12:00:01Z'), body: { operation: 'Future', user: 'future' } }
    ];
    vm.runInContext('auditLogState.rawData = __rows', context);
    api.processAuditLogData(window);
    const state = JSON.parse(JSON.stringify(vm.runInContext('auditLogState', context)));

    assert.deepEqual(state.filteredEntries.map(entry => entry.id), [2, 3, 4]);
    assert.deepEqual(state.actualDateRange, ['2025-12-31', '2026-01-01', '2026-01-02']);
    assert.equal(state.operations.Login.length, 2);
    assert.equal(state.operations['Enable Node'].length, 1);
});

test('all-operation export selects only the canonical filtered collection', () => {
    const { context, api } = loadAudit();
    const window = api.buildAuditLogWindow(1, Date.parse('2026-01-02T12:00:00Z'));
    context.__rows = [
        { id: 10, occur_time: Date.parse('2025-12-31T12:00:00Z'), body: { operation: 'Outside', user: 'old' } },
        { id: 11, occur_time: Date.parse('2026-01-02T10:00:00Z'), body: { operation: 'Login', user: 'alice' } }
    ];
    vm.runInContext('auditLogState.rawData = __rows', context);
    api.processAuditLogData(window);

    const selected = api.selectAuditLogEntriesForExport('all');
    assert.deepEqual(Array.from(selected, entry => entry.id), [11]);
    const csv = api.buildAuditLogCsv(selected);
    assert.match(csv, /2026-01-02 10:00:00 UTC/);
    assert.match(csv, /Login/);
    assert.doesNotMatch(csv, /Outside|old/);
});

test('audit CSV neutralizes operation and user formula prefixes while retaining numeric IDs', () => {
    const { api } = loadAudit();
    const csv = api.buildAuditLogCsv([{
        id: -7,
        datetime: '2026-01-02 10:00:00 UTC',
        operation: '=HYPERLINK("https://example.invalid")',
        user: '+attacker'
    }]);
    const rows = CsvUtils.parseRows(csv);
    assert.equal(rows[1][0], '-7');
    assert.equal(rows[1][2], "'=HYPERLINK(\"https://example.invalid\")");
    assert.equal(rows[1][3], "'+attacker");
});

test('Audit Stop aborts the active request and returns explicit partial state', async () => {
    const controller = new AbortController();
    const { context, api } = loadAudit({
        window: {
            apiClient: {
                getAuditLog(_limit, _offset, options) {
                    return new Promise((_resolve, reject) => {
                        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                    });
                }
            }
        }
    });
    vm.runInContext('showAuditLogStatus = () => {};', context);
    api.auditLogState.abortController = controller;

    const pending = api.fetchAuditLogPages({ batchSize: 100, signal: controller.signal });
    api.stopAuditLogLoad();
    const result = await pending;

    assert.equal(controller.signal.aborted, true);
    assert.equal(result.incomplete, true);
    assert.equal(result.reason, 'cancelled');
    assert.equal(result.rowsFetched, 0);
});

test('audit pagination enforces row and page budgets and carries partial state into CSV', async () => {
    const calls = [];
    const { api } = loadAudit({
        window: {
            apiClient: {
                async getAuditLog(limit, offset, options) {
                    calls.push({ limit, offset, signal: options.signal });
                    return Array.from({ length: limit }, (_, index) => ({ id: `${offset + index}` }));
                }
            }
        }
    });
    const controller = new AbortController();
    const rowLimited = await api.fetchAuditLogPages({
        batchSize: 3,
        signal: controller.signal,
        maxPages: 10,
        maxRows: 5
    });
    assert.equal(rowLimited.reason, 'row_budget');
    assert.equal(rowLimited.entries.length, 5);
    assert.deepEqual(calls.map(call => call.offset), [0, 3]);
    assert.ok(calls.every(call => call.signal === controller.signal));

    const pageLimited = await api.fetchAuditLogPages({
        batchSize: 2,
        signal: controller.signal,
        maxPages: 1,
        maxRows: 10
    });
    assert.equal(pageLimited.reason, 'page_budget');
    assert.equal(pageLimited.pagesFetched, 1);

    const csv = api.buildAuditLogCsv([{
        id: '1', datetime: '2026-01-02 10:00:00 UTC', operation: 'Login', user: 'alice'
    }], {
        status: 'partial',
        detail: rowLimited.detail,
        fromMs: Date.parse('2026-01-01T00:00:00Z'),
        untilMs: Date.parse('2026-01-02T00:00:00Z')
    });
    const rows = CsvUtils.parseRows(csv);
    assert.equal(rows[1][5], 'partial');
    assert.match(rows[1][6], /row safety limit/);
    assert.equal(rows[1][7], '2026-01-01T00:00:00.000Z');
});

test('audit pagination preserves prior pages when a later page fails', async () => {
    let calls = 0;
    const { api } = loadAudit({
        window: {
            apiClient: {
                async getAuditLog(limit) {
                    calls += 1;
                    if (calls === 2) throw new Error('upstream unavailable');
                    return Array.from({ length: limit }, (_, index) => ({ id: `${index}` }));
                }
            }
        }
    });

    const result = await api.fetchAuditLogPages({ batchSize: 2, signal: new AbortController().signal });
    assert.equal(result.incomplete, true);
    assert.equal(result.reason, 'failed');
    assert.equal(result.rowsFetched, 2);
    assert.match(result.detail, /later page failed.*upstream unavailable/);
});
