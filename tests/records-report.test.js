const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(repoRoot, 'js/modules/records-report.js'), 'utf8');
const SystemHealthCollection = require('../js/modules/system-health-collection.js');
const CsvUtils = require('../js/utils/csv.js');

function loadRecords(overrides = {}) {
    const context = vm.createContext({
        console,
        Date,
        Map,
        Number,
        Object,
        String,
        SystemHealthCollection,
        CsvUtils,
        window: {},
        ...overrides
    });
    vm.runInContext(source, context, { filename: 'records-report.js' });
    return context;
}

function recordsApi(context) {
    return vm.runInContext(`({
        parseCRSCalendarDate,
        buildCRSReportWindow,
        parseCSV,
        selectCRSCapacityRows,
        buildCRSSummary,
        fetchCRSData
    })`, context);
}

test('builds a UTC date window without shifting explicit calendar dates', () => {
    const api = recordsApi(loadRecords());
    assert.equal(api.parseCRSCalendarDate('2026-07-25'), '2026-07-25');
    const window = JSON.parse(JSON.stringify(
        api.buildCRSReportWindow('week', Date.parse('2026-07-26T19:30:00.000Z'))
    ));
    assert.equal(window.start, '2026-07-19');
    assert.equal(window.end, '2026-07-25');
    assert.deepEqual(window.dates, [
        '2026-07-19', '2026-07-20', '2026-07-21', '2026-07-22',
        '2026-07-23', '2026-07-24', '2026-07-25'
    ]);
    assert.equal(window.untilMs, Date.parse('2026-07-26T00:00:00.000Z'));
});

test('normalizes CSV dates, filters extra rows, and requires complete selected coverage', () => {
    const api = recordsApi(loadRecords());
    const rows = api.parseCSV([
        'Summary Date UTC,Utilized,Reserved,Notes',
        '"7/23/2026 12:00 AM",40,100,"quoted, note with',
        'a second ""line"""',
        '2026-07-24,50,100',
        '2026-07-25T00:00:00Z,60,100',
        '2026-07-26,999,1000'
    ].join('\n'));
    const reportWindow = api.buildCRSReportWindow('week', Date.parse('2026-07-26T12:00:00Z'));
    assert.throws(
        () => api.selectCRSCapacityRows(rows, reportWindow),
        /missing 2026-07-19, 2026-07-20, 2026-07-21, 2026-07-22/
    );

    const shortWindow = {
        dates: ['2026-07-23', '2026-07-24', '2026-07-25']
    };
    assert.deepEqual(
        Array.from(api.selectCRSCapacityRows(rows, shortWindow), row => row.date),
        shortWindow.dates
    );
});

test('compares average daily record bytes with average daily utilized capacity', () => {
    const api = recordsApi(loadRecords());
    const summary = JSON.parse(JSON.stringify(api.buildCRSSummary([
        { id: '1', recordBytesGB: 420, collectionStatus: { status: 'complete' } },
        { id: '2', recordBytesGB: 280, collectionStatus: { status: 'complete' } }
    ], { utilized: 50, reserved: 100, aggregationMode: 'daily_average' }, 7)));

    assert.equal(summary.totalRecordBytesGB, 700);
    assert.equal(summary.averageDailyRecordBytesGB, 100);
    assert.equal(summary.compressionRatio, 2);
    assert.equal(summary.applianceData[0].compressedGB, 30);
    assert.equal(summary.applianceData[1].compressedGB, 20);
});

test('uses one batched total-by-object XID query and preserves zero, empty, and offline states', async () => {
    const calls = [];
    const responses = [
        { xid: '44' },
        { node_id: 1, stats: [{ oid: 1, time: 1, duration: 86_400_000, values: [0] }] },
        null
    ];
    const window = {
        apiClient: {
            async getAppliances() {
                return [
                    { id: 1, platform: 'discover', display_name: 'zero', license_platform: 'EDA', status_message: 'Online' },
                    { id: 2, platform: 'discover', display_name: 'empty', license_platform: 'EDA', status_message: 'Online' },
                    { id: 3, platform: 'discover', display_name: 'offline', license_platform: 'EDA', status_message: 'Offline' },
                    { id: 4, platform: 'discover', display_name: 'denied', license_platform: 'EDA', status_message: 'Online', data_access: false },
                    { id: 9, platform: 'trace', display_name: 'not discover', status_message: 'Online' }
                ];
            },
            async request(endpoint, options) {
                calls.push({ endpoint, options });
                return responses.shift();
            }
        }
    };
    const api = recordsApi(loadRecords({ window }));
    const reportWindow = api.buildCRSReportWindow('yesterday', Date.parse('2026-07-26T12:00:00Z'));
    const result = JSON.parse(JSON.stringify(await api.fetchCRSData(reportWindow)));

    assert.equal(calls[0].endpoint, '/metrics/totalbyobject');
    const request = JSON.parse(calls[0].options.body);
    assert.deepEqual(request.object_ids, [1, 2]);
    assert.deepEqual(request.metric_specs, [{ name: 'record_bytes' }]);
    assert.equal(request.object_type, 'system');
    assert.equal(request.metric_category, 'capture');
    assert.equal(request.from, reportWindow.fromMs);
    assert.equal(request.until, reportWindow.untilMs);
    assert.equal(calls[1].endpoint, '/metrics/next/44');
    assert.equal(calls[2].endpoint, '/metrics/next/44');

    assert.equal(result[0].recordBytes, 0);
    assert.equal(result[0].collectionStatus.status, 'zero_valued');
    assert.equal(result[1].recordBytes, null);
    assert.equal(result[1].collectionStatus.status, 'empty');
    assert.equal(result[2].recordBytes, null);
    assert.equal(result[2].collectionStatus.status, 'offline');
    assert.equal(result[3].recordBytes, null);
    assert.equal(result[3].collectionStatus.status, 'data_unavailable');

    const summary = JSON.parse(JSON.stringify(api.buildCRSSummary(result, { utilized: 10, reserved: 20 }, 1)));
    assert.equal(summary.collectionComplete, false);
    assert.equal(summary.totalRecordBytesGB, null);
    assert.equal(summary.compressionRatio, null);
    assert.equal(
        summary.compressionUnavailableReason,
        'Incomplete metric coverage; review sensor collection statuses'
    );
});

test('records an aggregate request failure instead of substituting zero', async () => {
    const error = new Error('upstream failed');
    error.status = 500;
    const window = {
        apiClient: {
            async getAppliances() {
                return [{ id: 1, platform: 'discover', display_name: 'sensor', status_message: 'Online' }];
            },
            async request() { throw error; }
        }
    };
    const api = recordsApi(loadRecords({ window, console: { error() {}, log() {} } }));
    const result = await api.fetchCRSData(api.buildCRSReportWindow('yesterday', Date.parse('2026-07-26T12:00:00Z')));
    assert.equal(result[0].recordBytes, null);
    assert.equal(result[0].collectionStatus.status, 'failed');
});
