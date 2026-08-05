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

test('user filter summary distinguishes no filters from combined filters', () => {
    const { context } = loadUserManager({});
    context.filterDescription = vm.runInContext(
        `describeUserFilters(' Alice ', 'local', 'disabled', '90')`,
        context
    );

    assert.deepEqual(plain(context.filterDescription), [
        'Name or username contains “Alice”',
        'Type: Local',
        'State: Disabled',
        'Last login: Inactive for 90 days'
    ]);
    assert.equal(
        vm.runInContext(`userFilterCountText(25, 25, 0)`, context),
        'Showing all 25 users'
    );
    assert.equal(
        vm.runInContext(`userFilterCountText(2, 25, 4)`, context),
        '2 of 25 users match 4 applied filters'
    );
});

test('user name, type, state, and inactivity filters combine in one result set', () => {
    const nowMs = Date.UTC(2026, 7, 5);
    const oldLogin = Date.UTC(2025, 0, 1);
    const recentLogin = Date.UTC(2026, 7, 4);
    const elements = {
        searchUsers: { value: 'alice' },
        filterUserType: { value: 'local' },
        filterUserState: { value: 'disabled' },
        filterUserInactivity: { value: '90' }
    };
    const users = [
        { username: 'alice', name: 'Alice Admin', type: 'local', enabled: false, last_ui_login_time: oldLogin },
        { username: 'alice-remote', name: 'Alice Remote', type: 'remote', enabled: false, last_ui_login_time: oldLogin },
        { username: 'alice-enabled', name: 'Alice Enabled', type: 'local', enabled: true, last_ui_login_time: oldLogin },
        { username: 'alice-current', name: 'Alice Current', type: 'local', enabled: false, last_ui_login_time: recentLogin },
        { username: 'bob', name: 'Bob Admin', type: 'local', enabled: false, last_ui_login_time: oldLogin }
    ];
    const { context, state } = loadUserManager({}, users, elements);
    context.nowMs = nowMs;

    vm.runInContext(`
        Date.now = () => nowMs;
        applyUserFilters();
    `, context);

    assert.deepEqual(state.filteredUsers.map(user => user.username), ['alice']);
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
