const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadManagement() {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'modules', 'appliance-management.js'),
        'utf8'
    );
    const context = vm.createContext({
        window: {},
        console,
        setTimeout,
        clearTimeout,
        Error,
        Date
    });
    vm.runInContext(source, context);
    return vm.runInContext('ApplianceManagement', context);
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

test('firmware releases are inverted into exact per-appliance eligibility', () => {
    const management = loadManagement();
    const unsafeId = '9007199254740993';
    const availability = management.buildFirmwareAvailability(
        [{ id: '0' }, { id: unsafeId }, { id: '7' }, { id: '9' }],
        [
            {
                release: '26.3',
                versions: [
                    { version: '26.3.1.100', system_ids: [unsafeId, '7'] },
                    { version: '26.3.2.200', system_ids: [unsafeId] },
                    { version: '26.3.1.100', system_ids: [unsafeId] }
                ]
            }
        ]
    );

    assert.equal(availability['0'].status, 'not-applicable');
    assert.deepEqual(plain(availability[unsafeId]), {
        status: 'available',
        versions: [
            { release: '26.3', version: '26.3.1.100' },
            { release: '26.3', version: '26.3.2.200' }
        ],
        error: null
    });
    assert.equal(availability['7'].status, 'available');
    assert.equal(availability['9'].status, 'no-upgrade');
});

test('firmware collection failure remains distinct from no eligible upgrade', () => {
    const management = loadManagement();
    const failure = new Error('remote appliance unavailable');
    const failed = management.buildFirmwareAvailability([{ id: '7' }], [], failure);
    const empty = management.buildFirmwareAvailability([{ id: '7' }], []);

    assert.equal(failed['7'].status, 'failed');
    assert.equal(failed['7'].error, failure);
    assert.equal(empty['7'].status, 'no-upgrade');
});

test('console detection, job locations, and product-key masking are conservative', () => {
    const management = loadManagement();

    assert.equal(management.isConsoleInventory([{ id: '0', platform: 'command' }]), true);
    assert.equal(management.isConsoleInventory([{ id: '0', platform: 'discover' }]), false);
    assert.equal(management.isSafeJobLocation('/api/v1/jobs/ebbdbc9e-7113'), true);
    assert.equal(management.isSafeJobLocation('https://attacker.example/api/v1/jobs/7'), false);
    assert.equal(management.isSafeJobLocation('/api/v1/devices/7'), false);
    const masked = management.maskProductKey('AAAA-BBBB-CCCC');
    assert.equal(masked.endsWith('CCCC'), true);
    assert.equal(masked.includes('AAAA'), false);
});

test('job polling reports updates and stops on documented DONE status', async () => {
    const management = loadManagement();
    const jobs = [
        { status: 'RUNNING', step_description: 'Downloading' },
        { status: 'DONE', step_description: 'Complete' }
    ];
    const updates = [];
    let clock = 0;

    const result = await management.pollFirmwareJob({
        location: '/api/v1/jobs/job-7',
        fetchJob: async () => jobs.shift(),
        onUpdate: job => updates.push(job.status),
        now: () => clock,
        intervalMs: 10,
        deadlineMs: 100,
        wait: async milliseconds => { clock += milliseconds; }
    });

    assert.equal(result.state, 'done');
    assert.deepEqual(updates, ['RUNNING', 'DONE']);
});

test('job polling returns an explicit timeout without treating it as success', async () => {
    const management = loadManagement();
    let clock = 0;
    const result = await management.pollFirmwareJob({
        location: '/api/v1/jobs/job-8',
        fetchJob: async () => ({ status: 'RUNNING' }),
        now: () => clock,
        intervalMs: 10,
        deadlineMs: 20,
        wait: async milliseconds => { clock += milliseconds; }
    });

    assert.equal(result.state, 'timed-out');
    assert.equal(result.job.status, 'RUNNING');
});
