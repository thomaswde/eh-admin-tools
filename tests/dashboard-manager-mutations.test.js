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
    const alerts = [];
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
        alert(message) { alerts.push(message); },
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
    return { context, state, genericHelpers, alerts };
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

test('successful dashboard deletion completes without a native success alert', async () => {
    const api = {
        async deleteDashboard() {
            return true;
        }
    };
    const { context, alerts } = loadDashboardManager(api, [{ id: 'one' }]);
    vm.runInContext('updateDashboardBulkActions = () => {}; syncDashboardSelectAllCheckbox = () => {};', context);

    await vm.runInContext(`executeDashboardDelete(['one'])`, context);

    assert.deepEqual(alerts, []);
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

test('dashboard usage attaches by opaque ID and separates positive from absent observations', () => {
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
        dashboardUsageState.coverageFromMs = 1_668_664_000_000;
        dashboardUsageState.untilMs = 1_700_200_000_000;
        attachDashboardUsage(testDashboards, testUsage);
    `, context);

    assert.equal(dashboards[0]._usage.viewsInWindow, 4);
    assert.equal(dashboards[1]._usage.viewsInWindow, 1);
    assert.equal(dashboards[2]._usage, null);
    context.nowMs = 1_700_200_000_000;
    assert.equal(
        vm.runInContext(`dashboardMatchesUsageFilter(testDashboards[0], 'within', '30', nowMs)`, context),
        true
    );
    assert.equal(
        vm.runInContext(`dashboardMatchesUsageFilter(testDashboards[1], 'not_within', '30', nowMs)`, context),
        true
    );
    assert.equal(
        vm.runInContext(`dashboardMatchesUsageFilter(testDashboards[2], 'not_within', '30', nowMs)`, context),
        true
    );
    assert.equal(
        vm.runInContext(`dashboardMatchesUsageFilter(testDashboards[2], 'within', '30', nowMs)`, context),
        false,
        'absence is not positive evidence of a view'
    );
});

test('recorded-activity filters do not claim results when usage collection is unavailable', () => {
    const { context } = loadDashboardManager({});
    const matches = vm.runInContext(`
        dashboardUsageState.status = 'unavailable';
        dashboardMatchesUsageFilter({ id: '1', _usage: null }, 'not_within', '90', 1700000000000);
    `, context);

    assert.equal(matches, false);
});

test('not-recorded filters require enough returned metric history', () => {
    const { context } = loadDashboardManager({});
    const matches = vm.runInContext(`
        dashboardUsageState.status = 'complete';
        dashboardUsageState.coverageFromMs = 1_695_000_000_000;
        dashboardUsageState.untilMs = 1_700_000_000_000;
        dashboardMatchesUsageFilter({ id: '1', _usage: null }, 'not_within', '90', 1_700_000_000_000);
    `, context);

    assert.equal(matches, false);

    const recordedMatches = vm.runInContext(`
        dashboardMatchesUsageFilter({
            id: '2',
            _usage: { lastViewedBucketEndMs: 1_690_000_000_000 }
        }, 'not_within', '90', 1_700_000_000_000);
    `, context);
    assert.equal(recordedMatches, false, 'a recorded view cannot bypass incomplete coverage');
});

test('dashboard activity filtering uses the appliance metric clock', () => {
    const { context } = loadDashboardManager({});
    const matches = vm.runInContext(`
        dashboardUsageState.status = 'complete';
        dashboardUsageState.coverageFromMs = 1_690_000_000_000;
        dashboardUsageState.untilMs = 1_700_200_000_000;
        dashboardMatchesUsageFilter({
            id: '1',
            _usage: { lastViewedBucketEndMs: 1_700_086_400_000 }
        }, 'within', '30');
    `, context);

    assert.equal(matches, true);
});

test('dashboard filter labels distinguish fields, operators, and operands', () => {
    const { context } = loadDashboardManager({});
    assert.equal(
        vm.runInContext(`describeDashboardFilter({ field: 'name', operator: 'contains', operand: ' EDR ' })`, context),
        'Name contains “EDR”'
    );
    assert.equal(
        vm.runInContext(`describeDashboardFilter({ field: 'owner', operator: 'is', operand: 'stand@example.com' })`, context),
        'Owner is “stand@example.com”'
    );
    assert.equal(
        vm.runInContext(`dashboardFilterCountMarkup(5475, 5475, 3)`, context),
        '<strong>5,475</strong> of <strong>5,475</strong> dashboards match <strong>3</strong> applied filters'
    );
});

test('dashboard pagination is fixed at 100 rows per page', () => {
    const dashboards = Array.from({ length: 250 }, (_, index) => ({ id: String(index) }));
    const { context, state } = loadDashboardManager({}, dashboards);
    state.currentPage = 2;

    const page = vm.runInContext('getCurrentPageDashboards()', context);

    assert.equal(page.length, 100);
    assert.equal(page[0].id, '100');
    assert.equal(page[99].id, '199');
});

test('large owner changes and deletions require the exact typed confirmation after 100 dashboards', () => {
    const dashboards = Array.from({ length: 101 }, (_, index) => ({
        id: String(index),
        owner: index < 50 ? 'alice@example.com' : 'bob@example.com'
    }));
    const { context } = loadDashboardManager({}, dashboards);
    context.dashboardIds = dashboards.map(dashboard => dashboard.id);

    assert.equal(vm.runInContext('dashboardNeedsHighImpactConfirmation(100)', context), false);
    assert.equal(vm.runInContext('dashboardNeedsHighImpactConfirmation(101)', context), true);
    assert.equal(vm.runInContext(`dashboardConfirmationPhraseIsValid('confirm')`, context), true);
    assert.equal(vm.runInContext(`dashboardConfirmationPhraseIsValid(' confirm ')`, context), true);
    assert.equal(vm.runInContext(`dashboardConfirmationPhraseIsValid('Confirm')`, context), false);
    assert.equal(vm.runInContext(`dashboardConfirmationPhraseIsValid('yes')`, context), false);
    assert.equal(
        vm.runInContext(`dashboardOwnerChangeConfirmationText(dashboardIds, 'new@example.com')`, context),
        'Type "confirm" to change owner of 101 dashboards from 2 current owners to new@example.com.'
    );
    assert.equal(
        vm.runInContext('dashboardDeleteConfirmationText(dashboardIds)', context),
        'Type "confirm" to delete 101 dashboards.'
    );
});

test('dashboard backup names are unique timestamped appliance customization names', () => {
    const { context } = loadDashboardManager({});
    assert.equal(
        vm.runInContext(`dashboardConfigurationBackupName(Date.UTC(2026, 7, 6, 12, 34, 56, 789))`, context),
        'eh-admin-tools-dashboard-backup-20260806123456789'
    );
});

test('complete dashboard usage does not render explanatory subtext', () => {
    const { context } = loadDashboardManager({});
    const status = vm.runInContext(`
        dashboardUsageState.status = 'complete';
        dashboardUsageState.notice = 'Long appliance metric explanation';
        dashboardUsageStatusText();
    `, context);

    assert.equal(status, '');
});

test('dashboard name, owner, and activity filters combine in one result set', () => {
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
    const { context, state } = loadDashboardManager({}, dashboards);

    vm.runInContext(`
        dashboardUsageState.status = 'complete';
        dashboardUsageState.coverageFromMs = 1_690_000_000_000;
        dashboardUsageState.untilMs = 1_700_000_000_000;
        dashboardFilterState.filters = [
            { id: 1, field: 'name', operator: 'contains', operand: 'EDR Agent' },
            { id: 2, field: 'owner', operator: 'is', operand: 'stand@example.com' },
            { id: 3, field: 'viewed', operator: 'not_within', operand: '90' }
        ];
        applyDashboardFilters();
    `, context);

    assert.deepEqual(state.filteredDashboards.map(dashboard => dashboard.id), ['match']);
});

test('dashboard usage lookbacks are derived from actual returned metric depth', () => {
    const { context } = loadDashboardManager({});

    vm.runInContext(`
        dashboardUsageState.status = 'complete';
        dashboardUsageState.coverageFromMs = 1_700_000_000_000 - 89 * DASHBOARD_USAGE_DAY_MS;
        dashboardUsageState.untilMs = 1_700_000_000_000;
    `, context);

    assert.deepEqual(plain(vm.runInContext(`dashboardUsageLookbackOptions()`, context)), [7, 14, 30, 60, 89]);
    assert.equal(
        vm.runInContext(`dashboardUsageHistoryPlaceholder()`, context),
        'Usage metrics exist for the last 89 complete days'
    );
    assert.equal(
        vm.runInContext(`formatDashboardLastViewed({ id: '1', _usage: null })`, context),
        'No recorded activity (89d of usage history)'
    );
});

test('stacked filters reject duplicates and usage lookbacks outside observed history', () => {
    const { context } = loadDashboardManager({});
    const results = vm.runInContext(`
        dashboardUsageState.status = 'complete';
        dashboardUsageState.coverageFromMs = 1_700_000_000_000 - 30 * DASHBOARD_USAGE_DAY_MS;
        dashboardUsageState.untilMs = 1_700_000_000_000;
        [
            addDashboardFilter({ field: 'name', operator: 'contains', operand: 'DNS' }),
            addDashboardFilter({ field: 'name', operator: 'contains', operand: 'dns' }),
            addDashboardFilter({ field: 'viewed', operator: 'not_within', operand: '90' }),
            addDashboardFilter({ field: 'viewed', operator: 'within', operand: '30' }),
            dashboardFilterState.filters.length
        ];
    `, context);

    assert.deepEqual(plain(results), [true, false, false, true, 2]);
});

test('owner-is selections merge into one OR filter and match any selected owner', () => {
    const dashboards = [
        { id: 'john', name: 'John dashboard', owner: 'John' },
        { id: 'mary', name: 'Mary dashboard', owner: 'Mary' },
        { id: 'pat', name: 'Pat dashboard', owner: 'Pat' }
    ];
    const { context, state } = loadDashboardManager({}, dashboards);

    const result = vm.runInContext(`
        [
            addDashboardFilter({ field: 'owner', operator: 'is', operand: 'John' }),
            addDashboardFilter({ field: 'owner', operator: 'is', operand: 'Mary' }),
            addDashboardFilter({ field: 'owner', operator: 'is', operand: 'john' }),
            dashboardFilterState.filters.length,
            dashboardFilterState.filters[0].operand,
            describeDashboardFilter(dashboardFilterState.filters[0])
        ];
    `, context);
    vm.runInContext('applyDashboardFilters()', context);

    assert.deepEqual(plain(result), [
        true,
        true,
        false,
        1,
        ['John', 'Mary'],
        'Owner is “John” or “Mary”'
    ]);
    assert.deepEqual(state.filteredDashboards.map(dashboard => dashboard.id), ['john', 'mary']);
});
