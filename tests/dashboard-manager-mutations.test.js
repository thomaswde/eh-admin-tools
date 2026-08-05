const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'modules', 'dashboard-manager.js'),
    'utf8'
);

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function loadDashboardManager(apiClient, dashboards = [], elements = {}) {
    const state = {
        connected: true,
        dashboards,
        filteredDashboards: dashboards,
        selectedDashboards: new Set(),
        allUsers: [],
        currentPage: 1,
        itemsPerPage: 25
    };
    const genericHelpers = {
        applyFilters() {},
        updatePagination() {},
        updateBulkActions() {},
        syncSelectAllCheckbox() {}
    };
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        state,
        window: { apiClient },
        document: { getElementById: id => elements[id] || null },
        alert() {},
        escapeHtml: value => String(value),
        escapeAttribute: value => String(value),
        detailItem: () => '',
        showModal() {},
        hideModal() {},
        ...genericHelpers
    });

    vm.runInContext(source, context, { filename: 'dashboard-manager.js' });
    context.refreshCount = 0;
    vm.runInContext('loadDashboards = async () => { refreshCount++; return true; }', context);
    return { context, state, genericHelpers };
}

test('dashboard script leaves generic helpers in the shared classic-script namespace untouched', () => {
    const { context, genericHelpers } = loadDashboardManager({});

    Object.entries(genericHelpers).forEach(([name, helper]) => {
        assert.equal(context[name], helper);
    });
});

test('owner changes continue per dashboard and sharing writes merge complete state', async () => {
    const ownerCalls = [];
    const sharingWrites = [];
    const api = {
        async updateDashboard(id, payload) {
            ownerCalls.push([id, payload]);
            if (id === 'three') throw new Error('owner denied');
        },
        async getDashboardSharing(id) {
            if (id === 'two') throw new Error('sharing unavailable');
            return {
                anyone: 'viewer',
                users: { existing: 'viewer' },
                groups: { 'local.ops': 'editor' }
            };
        },
        async updateDashboardSharing(id, payload) {
            sharingWrites.push([id, plain(payload)]);
        }
    };
    const dashboards = [
        { id: 1, owner: 'alice' },
        { id: 'two', owner: 'bob' },
        { id: 'three', owner: 'carol' }
    ];
    const { context } = loadDashboardManager(api, dashboards);

    const results = await vm.runInContext(
        `performDashboardOwnerChanges(['1', 'two', 'three'], 'new-owner', true)`,
        context
    );

    assert.deepEqual(ownerCalls.map(([id]) => id), ['1', 'two', 'three']);
    assert.deepEqual(sharingWrites, [[
        '1',
        {
            anyone: 'viewer',
            users: { existing: 'viewer', alice: 'editor' },
            groups: { 'local.ops': 'editor' }
        }
    ]]);
    assert.equal(results.ownerChanges, 2);
    assert.equal(results.sharingChanges, 1);
    assert.equal(results.errors.length, 2);
    assert.deepEqual(
        plain(results.items.map(item => [item.id, item.owner.status, item.sharing.status])),
        [
            ['1', 'succeeded', 'succeeded'],
            ['two', 'succeeded', 'failed'],
            ['three', 'failed', 'skipped']
        ]
    );
    assert.equal(context.refreshCount, 1, 'partial server mutations force an authoritative reload');
});

test('bulk sharing reads every dashboard, preserves existing grants, and continues after failure', async () => {
    const reads = [];
    const writes = [];
    const api = {
        async getDashboardSharing(id) {
            reads.push(id);
            return id === 1
                ? { anyone: null, users: { first: 'viewer' }, groups: { 'remote.team': 'viewer' } }
                : { anyone: 'viewer', users: { second: 'editor' }, groups: {} };
        },
        async updateDashboardSharing(id, payload) {
            writes.push([id, plain(payload)]);
            if (id === 1) throw new Error('write failed');
        }
    };
    const { context } = loadDashboardManager(api);

    const results = await vm.runInContext(
        `performDashboardSharingChanges([1, 2], { users: { added: 'editor' } })`,
        context
    );

    assert.deepEqual(reads, [1, 2]);
    assert.deepEqual(writes, [
        [1, {
            anyone: null,
            users: { first: 'viewer', added: 'editor' },
            groups: { 'remote.team': 'viewer' }
        }],
        [2, {
            anyone: 'viewer',
            users: { second: 'editor', added: 'editor' },
            groups: {}
        }]
    ]);
    assert.equal(results.sharingChanges, 1);
    assert.equal(results.errors.length, 1);
    assert.deepEqual(
        plain(results.items.map(item => [item.id, item.sharing.status])),
        [[1, 'failed'], [2, 'succeeded']]
    );
    assert.equal(context.refreshCount, 1);
});

test('bulk deletion attempts every item and reloads after any confirmed deletion', async () => {
    const calls = [];
    const api = {
        async deleteDashboard(id) {
            calls.push(id);
            if (id === 1) throw new Error('denied');
            return id !== 3;
        }
    };
    const { context } = loadDashboardManager(api);

    const results = await vm.runInContext('performDashboardDeletes([1, 2, 3])', context);

    assert.deepEqual(calls, [1, 2, 3]);
    assert.equal(results.deletions, 1);
    assert.equal(results.errors.length, 2);
    assert.deepEqual(
        plain(results.items.map(item => [item.id, item.deletion.status])),
        [[1, 'failed'], [2, 'succeeded'], [3, 'failed']]
    );
    assert.equal(context.refreshCount, 1);
});

test('a second dashboard mutation submission cannot queue while the first is active', async () => {
    let deleteCalls = 0;
    let releaseDelete;
    const blockedDelete = new Promise(resolve => {
        releaseDelete = resolve;
    });
    const api = {
        async deleteDashboard() {
            deleteCalls++;
            await blockedDelete;
            return true;
        }
    };
    const { context } = loadDashboardManager(api);
    vm.runInContext('updateDashboardBulkActions = () => {}; syncDashboardSelectAllCheckbox = () => {};', context);

    const first = vm.runInContext(
        `runDashboardMutation('delete', ['one'], onProgress => performDashboardDeletes(['one'], onProgress))`,
        context
    );
    const duplicate = vm.runInContext(
        `runDashboardMutation('delete', ['one'], onProgress => performDashboardDeletes(['one'], onProgress))`,
        context
    );

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(deleteCalls, 1);
    assert.equal(await duplicate, null);

    releaseDelete();
    const results = await first;
    assert.equal(results.deletions, 1);
    assert.equal(deleteCalls, 1);
});

test('dashboard mutation progress reports per-item completion and the authoritative refresh phase', async () => {
    const progress = [];
    const api = {
        async deleteDashboard() {
            return true;
        }
    };
    const { context } = loadDashboardManager(api);
    context.captureProgress = value => progress.push(plain(value));

    await vm.runInContext(
        `performDashboardDeletes(['one', 'two'], captureProgress)`,
        context
    );

    assert.deepEqual(progress, [
        { completed: 1, total: 2, phase: 'mutating' },
        { completed: 2, total: 2, phase: 'mutating' },
        { completed: 2, total: 2, phase: 'refreshing' }
    ]);
});

test('sharing read failures remain unavailable instead of becoming empty sharing', async () => {
    const api = {
        async getDashboardSharing() {
            throw new Error('forbidden');
        }
    };
    const { context } = loadDashboardManager(api);
    const dashboard = { id: 'dashboard-1' };
    context.targetDashboard = dashboard;

    await vm.runInContext('loadDashboardSharing(targetDashboard)', context);
    const rendered = vm.runInContext('renderDashboardSharingSection(targetDashboard)', context);

    assert.equal(dashboard.sharing, undefined);
    assert.equal(dashboard._sharingError, 'forbidden');
    assert.match(rendered, /Sharing details unavailable/);
    assert.doesNotMatch(rendered, /No public access|None/);
});

test('reports an authoritative reload failure after a successful mutation', async () => {
    const { context } = loadDashboardManager({});
    vm.runInContext('loadDashboards = async () => { refreshCount++; return false; }', context);
    const results = vm.runInContext('newDashboardMutationResults()', context);
    results.mutations = 1;
    context.testResults = results;

    await vm.runInContext('refreshDashboardsAfterMutations(testResults)', context);

    assert.equal(context.refreshCount, 1);
    assert.deepEqual(plain(results.errors), [
        'Dashboard refresh failed: authoritative reload did not complete'
    ]);
});

test('dashboard usage attaches by opaque ID and inactivity filters include unrecorded dashboards', () => {
    const unsafeId = '90071992547409931234';
    const dashboards = [{ id: unsafeId }, { id: '-3' }, { id: 'unused' }];
    const { context } = loadDashboardManager({}, dashboards);
    context.testDashboards = dashboards;
    context.testUsage = {
        lastViewedByDashboardId: {
            [unsafeId]: {
                lastViewedBucketStartMs: 1_700_000_000_000,
                lastViewedBucketEndMs: 1_700_086_400_000,
                viewsInWindow: 4
            },
            '-3': {
                lastViewedBucketStartMs: 1_690_000_000_000,
                lastViewedBucketEndMs: 1_690_086_400_000,
                viewsInWindow: 1
            }
        }
    };

    vm.runInContext(`
        dashboardUsageState.status = 'complete';
        dashboardUsageState.lookbackDays = 365;
        dashboardUsageState.fromMs = 1_668_664_000_000;
        attachDashboardUsage(testDashboards, testUsage);
    `, context);

    assert.equal(dashboards[0]._usage.viewsInWindow, 4);
    assert.equal(dashboards[1]._usage.viewsInWindow, 1);
    assert.equal(dashboards[2]._usage, null);
    context.nowMs = 1_700_200_000_000;
    assert.equal(
        vm.runInContext(`dashboardMatchesUsageFilter(testDashboards[0], '30', nowMs)`, context),
        false
    );
    assert.equal(
        vm.runInContext(`dashboardMatchesUsageFilter(testDashboards[1], '30', nowMs)`, context),
        true
    );
    assert.equal(
        vm.runInContext(`dashboardMatchesUsageFilter(testDashboards[2], '30', nowMs)`, context),
        true
    );
});

test('dashboard inactivity filters do not claim results when usage collection is unavailable', () => {
    const { context } = loadDashboardManager({});
    const matches = vm.runInContext(`
        dashboardUsageState.status = 'unavailable';
        dashboardMatchesUsageFilter({ id: '1', _usage: null }, '90', 1700000000000);
    `, context);

    assert.equal(matches, false);
});

test('dashboard inactivity filters require enough collected history for unrecorded dashboards', () => {
    const { context } = loadDashboardManager({});
    const matches = vm.runInContext(`
        dashboardUsageState.status = 'complete';
        dashboardUsageState.fromMs = 1_695_000_000_000;
        dashboardMatchesUsageFilter({ id: '1', _usage: null }, '90', 1_700_000_000_000);
    `, context);

    assert.equal(matches, false);
});

test('dashboard inactivity filtering uses the appliance metric clock', () => {
    const { context } = loadDashboardManager({});
    const matches = vm.runInContext(`
        dashboardUsageState.status = 'complete';
        dashboardUsageState.untilMs = 1_700_200_000_000;
        dashboardMatchesUsageFilter({
            id: '1',
            _usage: { lastViewedBucketEndMs: 1_700_086_400_000 }
        }, '30');
    `, context);

    assert.equal(matches, false);
});

test('dashboard filter summary distinguishes no filters from applied filters', () => {
    const { context } = loadDashboardManager({});
    context.filterDescription = vm.runInContext(
        `describeDashboardFilters(' EDR ', ' stand@example.com ', '365', 'No view recorded in 365 days')`,
        context
    );

    assert.deepEqual(plain(context.filterDescription), [
        'Name contains “EDR”',
        'Owner contains “stand@example.com”',
        'No view recorded in 365 days'
    ]);
    assert.equal(
        vm.runInContext(`dashboardFilterCountText(5475, 5475, 0)`, context),
        'Showing all 5,475 dashboards'
    );
    assert.equal(
        vm.runInContext(`dashboardFilterCountText(5475, 5475, 1)`, context),
        '5,475 of 5,475 dashboards match 1 applied filter'
    );
});

test('dashboard name, owner, and activity filters combine in one result set', () => {
    const elements = {
        searchDashboards: { value: 'EDR Agent' },
        filterOwner: { value: 'stand@example.com' },
        filterDashboardActivity: { value: '90' }
    };
    const dashboards = [
        { id: 'match', name: 'EDR Agent Tracking', owner: 'stand@example.com', _usage: null },
        { id: 'owner-miss', name: 'EDR Agent Tracking', owner: 'guyr@example.com', _usage: null },
        { id: 'name-miss', name: 'Cloud Record Store Volume', owner: 'stand@example.com', _usage: null },
        {
            id: 'activity-miss',
            name: 'EDR Agent Tracking - Current',
            owner: 'stand@example.com',
            _usage: { lastViewedBucketEndMs: 1_699_990_000_000 }
        }
    ];
    const { context, state } = loadDashboardManager({}, dashboards, elements);

    vm.runInContext(`
        dashboardUsageState.status = 'complete';
        dashboardUsageState.fromMs = 1_690_000_000_000;
        dashboardUsageState.untilMs = 1_700_000_000_000;
        applyDashboardFilters();
    `, context);

    assert.deepEqual(state.filteredDashboards.map(dashboard => dashboard.id), ['match']);
});

test('dashboard activity filter survives the loading phase of refresh', () => {
    const elements = {
        dashboardUsageStatus: { textContent: '' },
        filterDashboardActivity: { value: '365', disabled: false }
    };
    const { context } = loadDashboardManager({}, [], elements);

    vm.runInContext(`dashboardUsageState.status = 'loading'; renderDashboardUsageStatus();`, context);

    assert.equal(elements.filterDashboardActivity.value, '365');
    assert.equal(elements.filterDashboardActivity.disabled, true);
});
