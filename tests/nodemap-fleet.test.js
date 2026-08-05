const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The Connected Appliances module derives facts about each appliance and then
// sorts, groups, and filters them. These tests cover that derivation without a
// DOM, matching the dependency-free convention used by the other tests here.
//
// The module runs in a vm context, so arrays it returns carry that realm's
// Array.prototype and deepStrictEqual rejects them as not reference-equal.
// plain() copies a result into this realm before comparison.

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function loadNodemap() {
    const commonSource = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'utils', 'common.js'),
        'utf8'
    );
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'modules', 'nodemap.js'),
        'utf8'
    );

    const noop = () => {};
    const context = vm.createContext({
        console: { log: noop, warn: noop, error: noop },
        state: { connected: false },
        document: {
            documentElement: {},
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => []
        },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        window: {},
        fetch: () => Promise.reject(new Error('not used')),
        escapeHtml: text => (text == null ? '' : String(text)),
        detailItem: (label, value) => `${label}:${value}`,
        showModal: noop,
        hideModal: noop,
        d3: {}
    });

    vm.runInContext(commonSource, context, { filename: 'common.js' });
    vm.runInContext(
        `${source}
;({
    nodemapState,
    describeAppliance,
    getRole,
    getStatusInfo,
    getVisibleRecords,
    sortRecords,
    buildGroups,
    passesFilters
})`,
        context,
        { filename: 'nodemap.js' }
    );

    return vm.runInContext(`({
        nodemapState,
        describeAppliance,
        getRole,
        getStatusInfo,
        getVisibleRecords,
        sortRecords,
        buildGroups,
        passesFilters
    })`, context);
}

function appliance(overrides) {
    return {
        id: 1,
        display_name: 'sensor-a',
        platform: 'discover',
        license_platform: 'EDA1100V',
        firmware_version: '26.2.2',
        status_message: 'Online',
        ...overrides
    };
}

test('status text maps to a level, and unknown status is not treated as online', () => {
    const { getStatusInfo } = loadNodemap();

    assert.equal(getStatusInfo({ status_message: 'Online' }).level, 'online');
    assert.equal(getStatusInfo({ status_message: 'Unable to connect to appliance' }).level, 'error');
    assert.equal(getStatusInfo({ status_message: 'Requires additional configuration' }).level, 'warning');
    assert.equal(getStatusInfo({ status_message: '' }).level, 'unknown');
    assert.equal(getStatusInfo({}).statusText, 'Unknown');
});

test('role comes from platform and model, and is derived once for every view', () => {
    const { getRole, describeAppliance } = loadNodemap();

    assert.equal(getRole({ license_platform: 'ECA' }, { platform: 'command' }), 'command');
    assert.equal(getRole({ license_platform: 'EFC1291V' }, { platform: 'discover' }), 'efc');
    assert.equal(getRole({ license_platform: 'EDA1100V' }, { platform: 'discover' }), 'discover');
    assert.equal(
        getRole({ license_platform: 'ETA6290V' }, { platform: 'trace', hasIntegratedTrace: false }),
        'trace'
    );
    // An EDA model with integrated packet capture stays a sensor, because the
    // model prefix wins over the trace platform the catalog reports for it.
    assert.equal(
        getRole({ license_platform: 'EDA1100V_TRACE' }, { platform: 'trace', hasIntegratedTrace: true }),
        'discover'
    );

    const record = describeAppliance(appliance({ display_name: null, hostname: null, id: 42 }));
    assert.equal(record.name, 'Appliance 42', 'falls back when the appliance has no name');
});

test('catalog matches classify form factors and deployments without model-name heuristics', () => {
    const { nodemapState, describeAppliance } = loadNodemap();

    nodemapState.catalogData = [
        { name: 'ETA9350V', platform: 'packetstore', form_factor: { rack_units: 1 } },
        { name: 'ETA-CLOUD', platform: 'packetstore', deployments: { clouds: ['aws'] } }
    ];

    const physical = describeAppliance(appliance({
        license_platform: 'ETA9350V',
        platform: 'trace'
    }));
    const virtual = describeAppliance(appliance({
        license_platform: 'ETA-CLOUD',
        platform: 'trace'
    }));

    assert.equal(physical.typeLabel, 'Physical');
    assert.equal(virtual.typeLabel, 'Virtual');
});

test('product modules normalize whether the API returns a string or an array', () => {
    const { describeAppliance } = loadNodemap();

    assert.deepEqual(plain(describeAppliance(appliance({ product_modules: 'ndr' })).modules), ['NDR']);
    assert.deepEqual(
        plain(describeAppliance(appliance({ product_modules: ['ndr', 'npm'] })).modules),
        ['NDR', 'NPM']
    );
    assert.deepEqual(plain(describeAppliance(appliance({ product_modules: null })).modules), []);
});

test('sorting is stable: equal keys fall back to name instead of shuffling', () => {
    const { nodemapState, describeAppliance, sortRecords } = loadNodemap();

    const records = [
        appliance({ id: 1, display_name: 'zeta', firmware_version: '26.2.2' }),
        appliance({ id: 2, display_name: 'alpha', firmware_version: '26.2.2' }),
        appliance({ id: 3, display_name: 'mid', firmware_version: '26.2.2' })
    ].map(describeAppliance);

    nodemapState.sortKey = 'firmware';
    nodemapState.sortDir = 'asc';

    assert.deepEqual(
        plain(sortRecords(records).map(r => r.name)),
        ['alpha', 'mid', 'zeta']
    );
});

test('sort direction reverses the chosen key without disturbing the tiebreak', () => {
    const { nodemapState, describeAppliance, sortRecords } = loadNodemap();

    const records = [
        appliance({ id: 1, display_name: 'a', license_platform: 'EDA1100V' }),
        appliance({ id: 2, display_name: 'b', license_platform: 'IDS1280V' }),
        appliance({ id: 3, display_name: 'c', license_platform: 'EFC1291V' })
    ].map(describeAppliance);

    nodemapState.sortKey = 'model';

    nodemapState.sortDir = 'asc';
    assert.deepEqual(plain(sortRecords(records).map(r => r.model)), ['EDA1100V', 'EFC1291V', 'IDS1280V']);

    nodemapState.sortDir = 'desc';
    assert.deepEqual(plain(sortRecords(records).map(r => r.model)), ['IDS1280V', 'EFC1291V', 'EDA1100V']);
});

test('grouping by status puts problems first, not alphabetical order', () => {
    const { nodemapState, describeAppliance, buildGroups } = loadNodemap();

    const records = [
        appliance({ id: 1, display_name: 'ok', status_message: 'Online' }),
        appliance({ id: 2, display_name: 'blank', status_message: '' }),
        appliance({ id: 3, display_name: 'down', status_message: 'Unable to connect' }),
        appliance({ id: 4, display_name: 'cfg', status_message: 'Requires additional configuration' })
    ].map(describeAppliance);

    nodemapState.groupBy = 'status';

    assert.deepEqual(
        plain(buildGroups(records).map(group => group.key)),
        ['Unable to connect', 'Requires additional configuration', 'Unknown', 'Online']
    );
});

test('grouping by firmware is alphabetical and counts each version once', () => {
    const { nodemapState, describeAppliance, buildGroups } = loadNodemap();

    const records = [
        appliance({ id: 1, firmware_version: '26.2.2' }),
        appliance({ id: 2, firmware_version: '25.4.0' }),
        appliance({ id: 3, firmware_version: '26.2.2' }),
        appliance({ id: 4, firmware_version: null })
    ].map(describeAppliance);

    nodemapState.groupBy = 'firmware';
    const groups = buildGroups(records);

    assert.deepEqual(plain(groups.map(g => [g.key, g.records.length])), [
        ['25.4.0', 1],
        ['26.2.2', 2],
        ['Unknown', 1]
    ]);
});

test('grouping set to none returns one untitled group holding everything', () => {
    const { nodemapState, describeAppliance, buildGroups } = loadNodemap();

    const records = [appliance({ id: 1 }), appliance({ id: 2 })].map(describeAppliance);
    nodemapState.groupBy = 'none';

    const groups = buildGroups(records);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].key, '');
    assert.equal(groups[0].records.length, 2);
});

test('the console is never hidden by a role filter', () => {
    const { nodemapState, describeAppliance, passesFilters } = loadNodemap();

    const console_ = describeAppliance(appliance({
        id: 1, display_name: 'ECA', platform: 'command', license_platform: 'ECA'
    }));
    const sensor = describeAppliance(appliance({ id: 2 }));

    nodemapState.filters.discover = false;
    nodemapState.filters.other = false;

    assert.equal(passesFilters(console_), true, 'the console stays visible');
    assert.equal(passesFilters(sensor), false, 'the sensor is filtered out');
});

test('status filters apply only to definite online and error states', () => {
    const { nodemapState, describeAppliance, passesFilters } = loadNodemap();

    const unknown = describeAppliance(appliance({ id: 1, status_message: '' }));
    const warning = describeAppliance(appliance({
        id: 2, status_message: 'Requires additional configuration'
    }));

    nodemapState.filters.online = false;
    nodemapState.filters.offline = false;

    assert.equal(passesFilters(unknown), true, 'unknown status survives both filters');
    assert.equal(passesFilters(warning), true, 'needs-configuration survives both filters');
});

test('search covers hostname, uuid, firmware, and modules, not just the display name', () => {
    const { nodemapState, describeAppliance, passesFilters } = loadNodemap();

    const record = describeAppliance(appliance({
        id: 7,
        display_name: 'sensor-a',
        hostname: 'host-7.appliance-hopcloud.extrahop',
        uuid: '568c2427-3eba-4c6e',
        firmware_version: '26.2.2.2005',
        product_modules: ['ndr']
    }));

    for (const term of ['hopcloud', '568c2427', '26.2.2', 'ndr', 'SENSOR-A']) {
        nodemapState.searchTerm = term;
        assert.equal(passesFilters(record), true, `expected "${term}" to match`);
    }

    nodemapState.searchTerm = 'not-in-this-record';
    assert.equal(passesFilters(record), false);
});

test('getVisibleRecords applies filters and search together', () => {
    const { nodemapState, getVisibleRecords } = loadNodemap();

    nodemapState.appliances = [
        appliance({ id: 1, display_name: 'keep-me', status_message: 'Online' }),
        appliance({ id: 2, display_name: 'drop-me', status_message: 'Unable to connect' }),
        appliance({ id: 3, display_name: 'keep-me-too', status_message: 'Online' })
    ];
    nodemapState.searchTerm = 'keep';
    nodemapState.filters.offline = false;

    assert.deepEqual(
        plain(getVisibleRecords().map(r => r.name)),
        ['keep-me', 'keep-me-too']
    );
});
