const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function loadApi(deploymentType) {
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
        assert.deepEqual(JSON.parse(calls[0].options.body), { anyone: 'null', users: {}, groups: {} });
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
        await assert.rejects(api.clearDashboardSharing('42'), /not verified/);
    }
    api.getDashboardSharing = async () => { throw new Error('readback denied'); };
    await assert.rejects(api.clearDashboardSharing('42'), /readback denied/);
});

test('dashboard revocation serializes the documented null permission string', async () => {
    const { api, calls } = loadApi('enterprise');
    await api.updateDashboardSharing('42', { anyone: null, users: {}, groups: {} });
    assert.deepEqual(JSON.parse(calls[0].options.body), { anyone: 'null', users: {}, groups: {} });
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
