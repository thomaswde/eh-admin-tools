const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function loadApi(deploymentType, responseFactory) {
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
            return responseFactory(url, options);
        }
    });
    vm.runInContext(source('js/utils/deployment-capabilities.js'), context);
    vm.runInContext(source('js/api-client/extrahop-api.js'), context);
    const ExtraHopAPI = vm.runInContext('ExtraHopAPI', context);
    return { api: new ExtraHopAPI({ type: deploymentType }), calls };
}

function response(data, { status = 200, location = null } = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        statusText: 'OK',
        headers: { get: name => name.toLowerCase() === 'location' ? location : null },
        async text() { return JSON.stringify(data); }
    };
}

test('firmware lookup preserves opaque IDs and is available on RevealX 360', async () => {
    const unsafeId = '9007199254740993';
    const { api, calls } = loadApi('360', () => response([]));

    await api.getApplianceFirmwareVersions([unsafeId, '7']);

    assert.equal(calls.length, 1);
    assert.equal(
        calls[0].url,
        '/backend/extrahop/api/v1/appliances/firmware/next?ids=9007199254740993%2C7'
    );
});

test('firmware upgrade keeps browser IDs as strings and returns accepted-job metadata', async () => {
    const unsafeId = '9007199254740993';
    const location = '/api/v1/jobs/ebbdbc9e-7113';
    const { api, calls } = loadApi('enterprise', () => response({}, { status: 202, location }));

    const result = await api.upgradeApplianceFirmware([unsafeId], '26.3.1.100');

    assert.equal(result.status, 202);
    assert.equal(result.location, location);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        system_ids: [unsafeId],
        version: '26.3.1.100'
    });
});

test('RevealX 360 rejects self-managed appliance data before transport', async () => {
    const { api, calls } = loadApi('360', () => response({}));

    await assert.rejects(api.getApplianceCloudServices(), error =>
        error.code === 'UNSUPPORTED_DEPLOYMENT_CAPABILITY'
    );
    await assert.rejects(api.getApplianceProductKeys('7'), error =>
        error.code === 'UNSUPPORTED_DEPLOYMENT_CAPABILITY'
    );
    assert.equal(calls.length, 0);
});

test('job polling accepts only a server-relative jobs location', async () => {
    const { api, calls } = loadApi('enterprise', () => response({ status: 'DONE' }));

    await assert.rejects(api.getFirmwareUpgradeJob('https://attacker.example/api/v1/jobs/7'), TypeError);
    const job = await api.getFirmwareUpgradeJob('/api/v1/jobs/job-7');

    assert.equal(job.status, 'DONE');
    assert.equal(calls[0].url, '/backend/extrahop/api/v1/jobs/job-7');
});
