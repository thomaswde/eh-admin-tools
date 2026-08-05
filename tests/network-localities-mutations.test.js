const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'modules', 'network-localities.js'),
    'utf8'
);

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function loadLocalities(apiClient) {
    const saveButton = { disabled: false, textContent: 'Save Changes' };
    const alerts = [];
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        state: { connected: true },
        window: { apiClient },
        document: {
            getElementById(id) {
                return id === 'saveLocalityChanges' ? saveButton : null;
            },
            querySelectorAll: () => []
        },
        confirm: () => true,
        alert: message => alerts.push(message),
        escapeAttribute: value => String(value),
        setTimeout() {}
    });

    vm.runInContext(source, context, { filename: 'network-localities.js' });
    vm.runInContext('renderLocalitiesTable = () => {}; showLocalityStatus = () => {};', context);
    const localitiesState = vm.runInContext('localitiesState', context);
    return { context, localitiesState, alerts, saveButton };
}

test('partial create reloads authoritative state and retries only the unresolved draft', async () => {
    const postNames = [];
    let badAttempts = 0;
    const api = {
        async request(url, options = {}) {
            if (url === '/networklocalities' && options.method === 'POST') {
                const payload = JSON.parse(options.body);
                postNames.push(payload.name);
                if (payload.name === 'bad' && badAttempts++ === 0) {
                    throw new Error('temporary create failure');
                }
                return undefined;
            }
            if (url === '/networklocalities') {
                return badAttempts > 1
                    ? [
                        { id: '101', name: 'good', networks: ['10.0.0.0/24'], external: false },
                        { id: '102', name: 'bad', networks: ['10.0.1.0/24'], external: false }
                    ]
                    : [{ id: '101', name: 'good', networks: ['10.0.0.0/24'], external: false }];
            }
            throw new Error(`unexpected request ${url}`);
        }
    };
    const { context, localitiesState } = loadLocalities(api);
    localitiesState.currentLocalities = [
        {
            name: 'good', networks: ['10.0.0.0/24'], external: false,
            description: '', _isNew: true, _clientId: 'draft-good'
        },
        {
            name: 'bad', networks: ['10.0.1.0/24'], external: false,
            description: '', _isNew: true, _clientId: 'draft-bad'
        }
    ];

    await vm.runInContext('saveLocalityChanges()', context);

    assert.deepEqual(
        plain(localitiesState.currentLocalities.map(item => [item.name, item.id, !!item._isNew, item._clientId])),
        [
            ['good', '101', false, null],
            ['bad', null, true, 'draft-bad']
        ]
    );

    await vm.runInContext('saveLocalityChanges()', context);

    assert.deepEqual(postNames, ['good', 'bad', 'bad']);
    assert.deepEqual(
        plain(localitiesState.currentLocalities.map(item => item.name)),
        ['good', 'bad']
    );
    assert.equal(localitiesState.currentLocalities.some(item => item._isNew), false);
});

test('partial update and delete preserve only failed operations for a safe retry', async () => {
    const mutationCalls = [];
    let secondAttempt = false;
    const api = {
        async request(url, options = {}) {
            if (options.method === 'PATCH') {
                mutationCalls.push(`PATCH ${url}`);
                if (url.endsWith('/2') && !secondAttempt) throw new Error('update failed');
                return undefined;
            }
            if (options.method === 'DELETE') {
                mutationCalls.push(`DELETE ${url}`);
                if (url.endsWith('/4') && !secondAttempt) throw new Error('delete failed');
                return undefined;
            }
            if (url === '/networklocalities') {
                return secondAttempt
                    ? [
                        { id: '1', name: 'one edited', networks: ['10.0.0.0/24'], external: false },
                        { id: '2', name: 'two edited', networks: ['10.0.1.0/24'], external: false }
                    ]
                    : [
                        { id: '1', name: 'one edited', networks: ['10.0.0.0/24'], external: false },
                        { id: '2', name: 'two server', networks: ['10.0.1.0/24'], external: false },
                        { id: '4', name: 'four', networks: ['10.0.3.0/24'], external: false }
                    ];
            }
            throw new Error(`unexpected request ${url}`);
        }
    };
    const { context, localitiesState } = loadLocalities(api);
    localitiesState.currentLocalities = [
        { id: '1', name: 'one edited', networks: ['10.0.0.0/24'], external: false, _modified: true },
        { id: '2', name: 'two edited', networks: ['10.0.1.0/24'], external: false, _modified: true },
        { id: '3', name: 'three', networks: ['10.0.2.0/24'], external: false, _deleted: true },
        { id: '4', name: 'four', networks: ['10.0.3.0/24'], external: false, _deleted: true }
    ];
    localitiesState.deletedIds = new Set(['3', '4']);

    await vm.runInContext('saveLocalityChanges()', context);

    const byId = new Map(localitiesState.currentLocalities.map(item => [item.id, item]));
    assert.equal(byId.get('1')._modified, undefined);
    assert.equal(byId.get('2').name, 'two edited');
    assert.equal(byId.get('2')._modified, true);
    assert.equal(byId.has('3'), false);
    assert.equal(byId.get('4')._deleted, true);
    assert.deepEqual(Array.from(localitiesState.deletedIds), ['4']);

    secondAttempt = true;
    await vm.runInContext('saveLocalityChanges()', context);

    assert.deepEqual(mutationCalls, [
        'PATCH /networklocalities/1',
        'PATCH /networklocalities/2',
        'DELETE /networklocalities/3',
        'DELETE /networklocalities/4',
        'PATCH /networklocalities/2',
        'DELETE /networklocalities/4'
    ]);
    assert.equal(localitiesState.currentLocalities.some(item => item._modified || item._deleted), false);
    assert.equal(localitiesState.deletedIds.size, 0);
});

test('authoritative reload resolves an ambiguous create response without staging a duplicate retry', async () => {
    const postNames = [];
    const api = {
        async request(url, options = {}) {
            if (url === '/networklocalities' && options.method === 'POST') {
                const payload = JSON.parse(options.body);
                postNames.push(payload.name);
                if (payload.name === 'ambiguous') throw new Error('connection closed after request');
                return undefined;
            }
            if (url === '/networklocalities') {
                return [
                    { id: '10', name: 'confirmed', networks: ['10.10.0.0/24'], external: false },
                    { id: '11', name: 'ambiguous', networks: ['10.11.0.0/24'], external: false }
                ];
            }
            throw new Error(`unexpected request ${url}`);
        }
    };
    const { context, localitiesState } = loadLocalities(api);
    localitiesState.currentLocalities = [
        {
            name: 'confirmed', networks: ['10.10.0.0/24'], external: false,
            description: '', _isNew: true, _clientId: 'confirmed-draft'
        },
        {
            name: 'ambiguous', networks: ['10.11.0.0/24'], external: false,
            description: '', _isNew: true, _clientId: 'ambiguous-draft'
        }
    ];

    await vm.runInContext('saveLocalityChanges()', context);
    await vm.runInContext('saveLocalityChanges()', context);

    assert.deepEqual(postNames, ['confirmed', 'ambiguous']);
    assert.deepEqual(
        plain(localitiesState.currentLocalities.map(item => [item.id, item.name, !!item._isNew])),
        [['10', 'confirmed', false], ['11', 'ambiguous', false]]
    );
});

test('filter-aware bulk selection stages only selected localities for deletion', () => {
    const { context, localitiesState } = loadLocalities({});
    localitiesState.currentLocalities = [
        {
            id: '9007199254740993',
            name: 'Production East',
            networks: ['10.1.0.0/16'],
            external: false,
            description: 'primary'
        },
        {
            id: '2',
            name: 'Development',
            networks: ['10.2.0.0/16'],
            external: false,
            description: 'lab'
        },
        {
            name: 'Production draft',
            networks: ['10.3.0.0/16'],
            external: false,
            description: '',
            _isNew: true,
            _clientId: 'draft-production'
        }
    ];
    localitiesState.filterTerm = 'production';

    const visibleKeys = vm.runInContext(
        'getVisibleLocalityEntries().map(({ locality }) => localitySelectionKey(locality))',
        context
    );
    assert.deepEqual(plain(visibleKeys), [
        'id:9007199254740993',
        'draft:draft-production'
    ]);

    vm.runInContext('handleSelectAllLocalities({ target: { checked: true } })', context);
    assert.deepEqual(Array.from(localitiesState.selectedKeys), [
        'id:9007199254740993',
        'draft:draft-production'
    ]);

    const staged = vm.runInContext(
        'stageLocalitiesForDeletion(Array.from(localitiesState.selectedKeys))',
        context
    );

    assert.equal(staged, 2);
    assert.deepEqual(Array.from(localitiesState.deletedIds), ['9007199254740993']);
    assert.equal(localitiesState.currentLocalities[0]._deleted, true);
    assert.equal(localitiesState.currentLocalities[1]._deleted, undefined);
    assert.equal(localitiesState.currentLocalities[2]._deleted, true);
    assert.equal(localitiesState.selectedKeys.size, 0);
});

test('large locality queries render a bounded editable page', () => {
    const { context, localitiesState } = loadLocalities({});
    localitiesState.currentLocalities = Array.from({ length: 30000 }, (_, index) => ({
        id: String(9007199254740993n + BigInt(index)),
        name: `locality-${index}`,
        networks: [`10.${Math.floor(index / 256) % 256}.${index % 256}.0/24`],
        external: false,
        description: ''
    }));

    assert.equal(vm.runInContext('getFilteredLocalityEntries().length', context), 30000);
    assert.equal(vm.runInContext('getVisibleLocalityEntries().length', context), 200);
    assert.equal(vm.runInContext('getVisibleLocalityEntries()[0].index', context), 0);
    localitiesState.page = 149;
    assert.equal(vm.runInContext('getVisibleLocalityEntries().length', context), 200);
    assert.equal(vm.runInContext('getVisibleLocalityEntries()[0].index', context), 29800);
    assert.equal(localitiesState.currentLocalities[0].id, '9007199254740993');
});
