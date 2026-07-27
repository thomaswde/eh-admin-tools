const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CsvUtils = require('../js/utils/csv.js');

test('browser loads the shared CSV utility before the dynamic feature loader', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(html.indexOf('js/utils/csv.js') < html.indexOf('js/utils/module-loader.js'));
});

test('RFC 4180 parser handles commas, doubled quotes, CRLF, and embedded newlines', () => {
    const rows = CsvUtils.parseRows([
        '\ufeffName,Description,Networks',
        '"Sensor, East","First line',
        'Second ""quoted"" line","10.0.0.0/8, 192.168.0.0/16"',
        'Plain,Value,172.16.0.0/12'
    ].join('\r\n'));

    assert.deepEqual(rows, [
        ['Name', 'Description', 'Networks'],
        ['Sensor, East', 'First line\r\nSecond "quoted" line', '10.0.0.0/8, 192.168.0.0/16'],
        ['Plain', 'Value', '172.16.0.0/12']
    ]);
    const roundTripRows = [
        ['Name', 'Description'],
        ['Sensor, West', 'Line one\nLine two with "quotes"']
    ];
    assert.deepEqual(CsvUtils.parseRows(CsvUtils.stringifyRows(roundTripRows)), roundTripRows);
    assert.throws(() => CsvUtils.parseRows('name,description\r\nvalue,"unfinished'), /unterminated quoted field/);
});

test('stringifier neutralizes formula-like text and preserves explicit numeric cells', () => {
    const csv = CsvUtils.stringifyRows([
        ['Text', 'Number value', 'Numeric column', 'Other text'],
        ['=CMD()', -42, '-7.5', '@user'],
        ['+SUM(A1:A2)', 3, '+8', '-not-a-number']
    ], { numericColumns: [2] });
    const rows = CsvUtils.parseRows(csv);

    assert.deepEqual(rows[1], ["'=CMD()", '-42', '-7.5', "'@user"]);
    assert.deepEqual(rows[2], ["'+SUM(A1:A2)", '3', '+8', "'-not-a-number"]);
});

test('Network Localities import uses shared parsing for multiline descriptions and quoted CIDR lists', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'modules', 'network-localities.js'),
        'utf8'
    );
    const context = vm.createContext({ console, CsvUtils, Set, Map, String, Array });
    vm.runInContext(source, context, { filename: 'network-localities.js' });
    const parse = vm.runInContext('parseNetworkLocalitiesCsv', context);
    const entries = parse([
        'Name,CIDR,External,Description',
        '"Office, East","10.0.0.0/8, 192.168.0.0/16",yes,"First line',
        'Second ""quoted"" line"'
    ].join('\r\n'));

    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'Office, East');
    assert.deepEqual(Array.from(entries[0].cidrs), ['10.0.0.0/8', '192.168.0.0/16']);
    assert.equal(entries[0].external, true);
    assert.equal(entries[0].description, 'First line\r\nSecond "quoted" line');
});
