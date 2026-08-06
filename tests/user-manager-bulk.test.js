const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'modules', 'user-manager.js'),
    'utf8'
);

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function loadUserManager(apiClient, users = [], elements = {}) {
    const state = {
        connected: true,
        apiConfig: { type: 'enterprise' },
        users,
        filteredUsers: users,
        allUsers: []
    };
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        state,
        window: { apiClient },
        document: { getElementById: id => elements[id] || null },
        alert() {},
        confirm: () => true,
        escapeHtml: value => String(value),
        escapeAttribute: value => String(value),
        detailItem: () => '',
        showModal() {},
        hideModal() {},
        showStatus() {},
        deploymentSupportsApiFamily: () => true
    });
    vm.runInContext(source, context, { filename: 'user-manager.js' });
    context.refreshCount = 0;
    vm.runInContext('loadUsers = async () => { refreshCount++; return true; }', context);
    return { context, state };
}

test('inactivity filtering uses account age for users who never logged in', () => {
    const { context } = loadUserManager({});
    context.nowMs = Date.UTC(2026, 7, 5);
    context.oldJoined = Date.UTC(2025, 0, 1);
    context.newJoined = Date.UTC(2026, 7, 1);
    context.recentLogin = Date.UTC(2026, 7, 4);

    assert.equal(vm.runInContext(
        `userMatchesInactivityFilter({ last_ui_login_time: null, date_joined: oldJoined }, '90', nowMs)`,
        context
    ), true);
    assert.equal(vm.runInContext(
        `userMatchesInactivityFilter({ last_ui_login_time: null, date_joined: newJoined }, '90', nowMs)`,
        context
    ), false);
    assert.equal(vm.runInContext(
        `userMatchesInactivityFilter({ last_ui_login_time: recentLogin, date_joined: oldJoined }, '90', nowMs)`,
        context
    ), false);
    assert.equal(vm.runInContext(
        `userMatchesInactivityFilter({ last_ui_login_time: null, date_joined: newJoined }, 'never', nowMs)`,
        context
    ), true);
});

test('user filter labels distinguish fields, operators, and operands', () => {
    const { context } = loadUserManager({});
    assert.equal(
        vm.runInContext(
            `describeUserFilter({ field: 'identity', operator: 'contains', operand: ' Alice ' })`,
            context
        ),
        'Name or username contains “Alice”'
    );
    assert.equal(
        vm.runInContext(
            `describeUserFilter({ field: 'type', operator: 'is_not', operand: 'remote' })`,
            context
        ),
        'Type is not “Remote”'
    );
    assert.equal(
        vm.runInContext(
            `describeUserFilter({ field: 'last_login', operator: 'not_within', operand: '90' })`,
            context
        ),
        'Last UI login not within the last 90d'
    );
    assert.equal(
        vm.runInContext(`userFilterCountMarkup(25, 25, 0)`, context),
        'Showing all <strong>25</strong> users'
    );
    assert.equal(
        vm.runInContext(`userFilterCountMarkup(2, 25, 4)`, context),
        '<strong>2</strong> of <strong>25</strong> users match <strong>4</strong> applied filters'
    );
});

test('user name, type, state, and inactivity filters combine in one result set', () => {
    const nowMs = Date.UTC(2026, 7, 5);
    const oldLogin = Date.UTC(2025, 0, 1);
    const recentLogin = Date.UTC(2026, 7, 4);
    const users = [
        { username: 'alice', name: 'Alice Admin', type: 'local', enabled: false, last_ui_login_time: oldLogin },
        { username: 'alice-remote', name: 'Alice Remote', type: 'remote', enabled: false, last_ui_login_time: oldLogin },
        { username: 'alice-enabled', name: 'Alice Enabled', type: 'local', enabled: true, last_ui_login_time: oldLogin },
        { username: 'alice-current', name: 'Alice Current', type: 'local', enabled: false, last_ui_login_time: recentLogin },
        { username: 'bob', name: 'Bob Admin', type: 'local', enabled: false, last_ui_login_time: oldLogin }
    ];
    const { context, state } = loadUserManager({}, users);
    context.nowMs = nowMs;

    vm.runInContext(`
        Date.now = () => nowMs;
        userFilterState.filters = [
            { id: 1, field: 'identity', operator: 'contains', operand: 'alice' },
            { id: 2, field: 'type', operator: 'is', operand: 'local' },
            { id: 3, field: 'state', operator: 'is', operand: 'disabled' },
            { id: 4, field: 'last_login', operator: 'not_within', operand: '90' }
        ];
        applyUserFilters();
    `, context);

    assert.deepEqual(state.filteredUsers.map(user => user.username), ['alice']);
});

test('base access filters use the displayed granted or effective access', () => {
    const users = [
        { username: 'system', granted_roles: { system: 'full' } },
        { username: 'effective', granted_roles: {}, effective_roles: { write: 'limited' } },
        { username: 'custom', granted_roles: { write: 'custom' } }
    ];
    const { context, state } = loadUserManager({}, users);

    vm.runInContext(`
        userFilterState.filters = [
            { id: 1, field: 'base_access', operator: 'is', operand: 'write_limited' }
        ];
        applyUserFilters();
    `, context);

    assert.deepEqual(state.filteredUsers.map(user => user.username), ['effective']);
});

test('stacked user filters reject duplicates and allow inverse filters', () => {
    const { context } = loadUserManager({});
    const results = vm.runInContext(`[
        addUserFilter({ field: 'identity', operator: 'contains', operand: 'Admin' }),
        addUserFilter({ field: 'identity', operator: 'contains', operand: ' admin ' }),
        addUserFilter({ field: 'identity', operator: 'not_contains', operand: 'test' }),
        addUserFilter({ field: 'last_login', operator: 'never', operand: '' }),
        userFilterState.filters.length
    ]`, context);

    assert.deepEqual(plain(results), [true, false, true, true, 3]);
});

test('bulk disable skips disabled users, continues after failures, and reloads once', async () => {
    const calls = [];
    const api = {
        async updateUser(username, payload) {
            calls.push([username, plain(payload)]);
            if (username === 'failed') throw new Error('denied');
        }
    };
    const users = [
        { username: 'enabled', enabled: true },
        { username: 'disabled', enabled: false },
        { username: 'failed', enabled: true }
    ];
    const { context } = loadUserManager(api, users);

    const results = await vm.runInContext(
        `performUserDisables(['enabled', 'disabled', 'failed'])`,
        context
    );

    assert.deepEqual(calls, [
        ['enabled', { enabled: false }],
        ['failed', { enabled: false }]
    ]);
    assert.equal(results.disabled, 1);
    assert.equal(results.skipped, 1);
    assert.equal(results.errors.length, 1);
    assert.deepEqual(
        plain(results.items.map(item => [item.username, item.disable.status])),
        [['enabled', 'succeeded'], ['disabled', 'skipped'], ['failed', 'failed']]
    );
    assert.equal(context.refreshCount, 1);
});

test('bulk delete applies one transfer destination and attempts every selected user', async () => {
    const calls = [];
    const api = {
        async deleteUser(username, transferUser) {
            calls.push([username, transferUser]);
            if (username === 'second') throw new Error('conflict');
        }
    };
    const { context } = loadUserManager(api);

    const results = await vm.runInContext(
        `performUserDeletes(['first', 'second', 'third'], 'owner')`,
        context
    );

    assert.deepEqual(calls, [
        ['first', 'owner'],
        ['second', 'owner'],
        ['third', 'owner']
    ]);
    assert.equal(results.deleted, 2);
    assert.equal(results.errors.length, 1);
    assert.equal(context.refreshCount, 1);
});

test('bulk delete rejects a transfer destination selected for deletion', async () => {
    const { context } = loadUserManager({ deleteUser: async () => {} });

    await assert.rejects(
        vm.runInContext(`performUserDeletes(['first', 'owner'], 'owner')`, context),
        /cannot also be selected/
    );
    assert.equal(context.refreshCount, 0);
});
