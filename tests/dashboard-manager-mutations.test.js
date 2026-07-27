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

function loadDashboardManager(apiClient, dashboards = []) {
    const state = {
        connected: true,
        dashboards,
        filteredDashboards: dashboards,
        selectedDashboards: new Set(),
        allUsers: [],
        currentPage: 1,
        itemsPerPage: 25
    };
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        state,
        window: { apiClient },
        document: { getElementById: () => null },
        alert() {},
        escapeHtml: value => String(value),
        escapeAttribute: value => String(value),
        detailItem: () => '',
        showModal() {},
        hideModal() {}
    });

    vm.runInContext(source, context, { filename: 'dashboard-manager.js' });
    context.refreshCount = 0;
    vm.runInContext('loadDashboards = async () => { refreshCount++; return true; }', context);
    return { context, state };
}

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
