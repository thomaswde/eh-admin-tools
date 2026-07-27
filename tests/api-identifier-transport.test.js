const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('browser API parsing keeps backend-normalized int64 identifiers exact', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'api-client', 'extrahop-api.js'), 'utf8');
    const context = vm.createContext({
        console,
        window: {},
        sessionStorage: { removeItem() {} },
        setTimeout,
        clearTimeout,
        AbortController,
        fetch() {
            throw new Error('unexpected fetch');
        }
    });
    vm.runInContext(source, context);
    context.response = {
        status: 200,
        ok: true,
        statusText: 'OK',
        async text() {
            return JSON.stringify({
                id: '9007199254740993',
                node_id: '9007199254740995',
                xid: ['9007199254740997'],
                time: 1785067200000,
                duration: 60000,
                values: [[42]]
            });
        }
    };

    const data = await vm.runInContext('ExtraHopAPI.parseStaticResponse(response)', context);

    assert.equal(data.id, '9007199254740993');
    assert.equal(data.node_id, '9007199254740995');
    assert.equal(data.xid[0], '9007199254740997');
    assert.equal(data.time, 1785067200000);
    assert.equal(data.duration, 60000);
    assert.equal(data.values[0][0], 42);
});
