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

function loadUserManager(apiClient, users = []) {
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
        document: { getElementById: () => null },
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
