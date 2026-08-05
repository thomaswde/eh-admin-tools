const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CsvUtils = require('../js/utils/csv.js');

test('browser loads the shared CSV utility before the dynamic feature loader', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(html.indexOf('js/utils/csv.js') < html.indexOf('js/utils/module-loader.js'));
    assert.ok(html.indexOf('js/utils/report-cache-validation.js') < html.indexOf('js/utils/module-loader.js'));
});

test('RFC 4180 parser handles commas, doubled quotes, CRLF, and embedded newlines', () => {
    const rows = CsvUtils.parseRows(
        [
            '\ufeffName,Description,Networks',
            '"Sensor, East","First line',
            'Second ""quoted"" line","10.0.0.0/8, 192.168.0.0/16"',
            'Plain,Value,172.16.0.0/12'
        ].join('\r\n')
    );

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
    const csv = CsvUtils.stringifyRows(
        [
            ['Text', 'Number value', 'Numeric column', 'Other text'],
            ['=CMD()', -42, '-7.5', '@user'],
            ['+SUM(A1:A2)', 3, '+8', '-not-a-number']
        ],
        { numericColumns: [2] }
    );
    const rows = CsvUtils.parseRows(csv);

    assert.deepEqual(rows[1], ["'=CMD()", '-42', '-7.5', "'@user"]);
    assert.deepEqual(rows[2], ["'+SUM(A1:A2)", '3', '+8', "'-not-a-number"]);
});
