const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function loadApi(deploymentType, respond) {
    const calls = [];
    const context = vm.createContext({
        console,
        window: {},
        document: { querySelectorAll: () => [] },
        sessionStorage: { removeItem() {} },
        setTimeout,
        clearTimeout,
        AbortController,
        Error,
        TypeError,
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (respond) return respond(url, options);
            return {
                status: 201,
                ok: true,
                statusText: 'Created',
                headers: { get: () => null },
                async text() { return ''; }
            };
        }
    });
    vm.runInContext(source('js/utils/deployment-capabilities.js'), context);
    vm.runInContext(source('js/api-client/extrahop-api.js'), context);
    const ExtraHopAPI = vm.runInContext('ExtraHopAPI', context);
    return { api: new ExtraHopAPI({ type: deploymentType }), calls };
}

test('Enterprise configuration backups use the customization backup endpoint', async () => {
    const { api, calls } = loadApi('enterprise');

    const result = await api.createConfigurationBackup('eh-admin-tools-dashboard-backup-20260806');

    assert.equal(result.name, 'eh-admin-tools-dashboard-backup-20260806');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/backend/extrahop/api/v1/customizations');
    assert.equal(calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        name: 'eh-admin-tools-dashboard-backup-20260806'
    });
});

test('RevealX 360 rejects configuration backups before network transport', async () => {
    const { api, calls } = loadApi('360');

    await assert.rejects(
        api.createConfigurationBackup('unsupported-backup'),
        error => error.code === 'UNSUPPORTED_DEPLOYMENT_CAPABILITY'
    );

    assert.equal(calls.length, 0);
});

for (const deployment of ['enterprise', '360']) {
    test(`${deployment} clears dashboard grants with PUT and verifies the response`, async () => {
        const { api, calls } = loadApi(deployment);
        api.getDashboardSharing = async id => {
            assert.equal(id, '9007199254740993');
            return { anyone: 'null', users: {}, groups: {} };
        };
        await api.clearDashboardSharing('9007199254740993');
        assert.equal(calls[0].options.method, 'PUT');
        assert.equal(calls[0].url, '/backend/extrahop/api/v1/dashboards/9007199254740993/sharing');
        assert.deepEqual(JSON.parse(calls[0].options.body), { users: {}, groups: {} });
    });
}

test('clearing sharing fails closed for retained grants and incomplete readback', async () => {
    const { api } = loadApi('enterprise');
    for (const sharing of [
        null, {}, { anyone: null, users: {} },
        { anyone: 'viewer', users: {}, groups: {} },
        { anyone: null, users: { alice: 'viewer' }, groups: {} },
        { anyone: null, users: {}, groups: { ops: 'editor' } }
    ]) {
        api.getDashboardSharing = async () => sharing;
        await assert.rejects(api.clearDashboardSharing('42'), error => error.code === 'DASHBOARD_SHARING_UNVERIFIED');
    }
    api.getDashboardSharing = async () => { throw new Error('readback denied'); };
    await assert.rejects(api.clearDashboardSharing('42'), /readback denied/);
});

test('dashboard PATCH preserves JSON null instead of inventing a string permission', async () => {
    const { api, calls } = loadApi('enterprise');
    await api.updateDashboardSharing('42', { anyone: null, users: {}, groups: {} });
    assert.deepEqual(JSON.parse(calls[0].options.body), { anyone: null, users: {}, groups: {} });
});

function jsonResponse(status, body) {
    return {
        status,
        ok: status >= 200 && status < 300,
        statusText: status === 422 ? 'Unprocessable Entity' : 'OK',
        async text() { return JSON.stringify(body); }
    };
}

// Exercise serialization and readback through the real API wrapper. A PUT
// replaces omitted grants; a PATCH only updates the supplied grant entries.
function sharingTransport({ writeStatus = 204, apply = true } = {}) {
    let sharing = { anyone: 'viewer', users: { existing: 'viewer' }, groups: { 'remote.ops': 'editor' } };
    return async (_url, { method, body }) => {
        if (method === 'GET') return jsonResponse(200, sharing);
        const payload = JSON.parse(body);
        if (payload.anyone === 'null') return jsonResponse(422, { message: 'Invalid permission' });
        if (apply) {
            sharing = method === 'PUT'
                ? { anyone: null, users: {}, groups: {}, ...payload }
                : { ...sharing, ...payload, users: { ...sharing.users, ...payload.users }, groups: { ...sharing.groups, ...payload.groups } };
        }
        return jsonResponse(writeStatus, writeStatus === 422 ? { message: 'Sharing replacement returned 422' } : {});
    };
}

for (const deployment of ['enterprise', '360']) {
    test(`${deployment} removes all-users access while preserving explicit grants and adding an editor`, async () => {
        const { api, calls } = loadApi(deployment, sharingTransport());
        await api.replaceDashboardSharing('9007199254740993', {
            anyone: null, users: { existing: 'viewer', added: 'editor' }, groups: { 'remote.ops': 'editor' }
        });
        assert.deepEqual(calls.map(call => call.options.method), ['PUT', 'GET']);
        assert.deepEqual(JSON.parse(JSON.stringify(await api.getDashboardSharing('9007199254740993'))), {
            anyone: null, users: { existing: 'viewer', added: 'editor' }, groups: { 'remote.ops': 'editor' }
        });
    });

    test(`${deployment} clears all grants using replacement and verifies fresh transport state`, async () => {
        const { api, calls } = loadApi(deployment, sharingTransport());
        await api.clearDashboardSharing('42');
        assert.deepEqual(calls.map(call => call.options.method), ['PUT', 'GET']);
        assert.deepEqual(JSON.parse(JSON.stringify(await api.getDashboardSharing('42'))), { anyone: null, users: {}, groups: {} });
    });
}

test('replacement omits revoked entries and can preserve all-users access', async () => {
    const { api, calls } = loadApi('enterprise', sharingTransport());
    await api.replaceDashboardSharing('42', {
        anyone: 'viewer', users: { removed: null, legacy: 'null', kept: 'editor' }, groups: {}
    });
    assert.deepEqual(JSON.parse(calls[0].options.body), { anyone: 'viewer', users: { kept: 'editor' }, groups: {} });
});

test('adding sharing still uses PATCH and preserves existing grants', async () => {
    const { api, calls } = loadApi('enterprise', sharingTransport());
    await api.updateDashboardSharing('42', { anyone: 'viewer', users: { added: 'editor' }, groups: {} });
    assert.equal(calls[0].options.method, 'PATCH');
    assert.deepEqual(JSON.parse(JSON.stringify(await api.getDashboardSharing('42'))), {
        anyone: 'viewer', users: { existing: 'viewer', added: 'editor' }, groups: { 'remote.ops': 'editor' }
    });
});

test('HTTP 422 after applying a clear is reconciled once and retains the write error', async () => {
    const { api, calls } = loadApi('enterprise', sharingTransport({ writeStatus: 422 }));
    await assert.rejects(api.clearDashboardSharing('42'), error => {
        assert.equal(error.code, 'DASHBOARD_SHARING_VERIFIED_AFTER_ERROR');
        assert.equal(error.sharingVerified, true);
        assert.equal(error.writeAcknowledged, false);
        assert.equal(error.status, 422);
        assert.match(error.message, /confirmed by readback/);
        assert.match(error.message, /returned 422/);
        return true;
    });
    assert.deepEqual(calls.map(call => call.options.method), ['PUT', 'GET']);
});

test('HTTP 422 with retained grants remains a failed write without retrying', async () => {
    const { api, calls } = loadApi('enterprise', sharingTransport({ writeStatus: 422, apply: false }));
    await assert.rejects(api.clearDashboardSharing('42'), error => {
        assert.equal(error.status, 422);
        assert.notEqual(error.sharingVerified, true);
        assert.notEqual(error.writeAcknowledged, true);
        assert.match(error.message, /returned 422.*could not be verified/);
        return true;
    });
    assert.deepEqual(calls.map(call => call.options.method), ['PUT', 'GET']);
});

test('HTTP 422 with unreadable sharing preserves both error messages', async () => {
    const { api, calls } = loadApi('enterprise', async (_url, { method }) => method === 'PUT'
        ? jsonResponse(422, { message: 'Write validation error' })
        : jsonResponse(403, { message: 'Readback denied' }));
    await assert.rejects(api.clearDashboardSharing('42'), error => {
        assert.equal(error.status, 422);
        assert.match(error.message, /Write validation error.*Readback denied/);
        assert.notEqual(error.sharingVerified, true);
        return true;
    });
    assert.deepEqual(calls.map(call => call.options.method), ['PUT', 'GET']);
});

test('successful replacement with retained all-users access is unverified, not completed', async () => {
    const { api } = loadApi('enterprise', sharingTransport({ apply: false }));
    await assert.rejects(api.replaceDashboardSharing('42', {
        anyone: null, users: { existing: 'viewer' }, groups: { 'remote.ops': 'editor' }
    }), error => error.code === 'DASHBOARD_SHARING_UNVERIFIED' && error.writeAcknowledged === true);
});

test('removal verification also checks preserved users and groups', async () => {
    const { api } = loadApi('enterprise');
    for (const sharing of [
        { anyone: null, users: {}, groups: { 'local.ops': 'editor' } },
        { anyone: null, users: { existing: 'editor' }, groups: {} },
        { anyone: null, users: { existing: 'viewer' }, groups: { 'local.ops': 'editor' } }
    ]) {
        api.getDashboardSharing = async () => sharing;
        await assert.rejects(api.replaceDashboardSharing('42', {
            anyone: null, users: { existing: 'editor' }, groups: { 'local.ops': 'editor' }
        }), error => error.code === 'DASHBOARD_SHARING_UNVERIFIED');
    }
});

test('authorization and other write failures are not retried or reconciled as successful clears', async () => {
    for (const status of [400, 403, 404, 429, 500]) {
        const { api, calls } = loadApi('enterprise', async () => jsonResponse(status, { message: 'Write denied' }));
        await assert.rejects(api.clearDashboardSharing('42'), error => error.status === status);
        assert.deepEqual(calls.map(call => call.options.method), ['PUT']);
    }
});

test('accepted clear writes preserve their outcome when verification fails', async () => {
    const { api } = loadApi('enterprise');
    api.getDashboardSharing = async () => { throw new Error('readback denied'); };
    await assert.rejects(api.clearDashboardSharing('42'), error => {
        assert.equal(error.code, 'DASHBOARD_SHARING_UNVERIFIED');
        assert.equal(error.writeAcknowledged, true);
        assert.match(error.message, /readback denied/);
        return true;
    });
    api.request = async () => { throw new Error('write denied'); };
    await assert.rejects(api.clearDashboardSharing('42'), error => {
        assert.equal(error.writeAcknowledged, undefined);
        assert.equal(error.message, 'write denied');
        return true;
    });
});
