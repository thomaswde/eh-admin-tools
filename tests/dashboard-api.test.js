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
