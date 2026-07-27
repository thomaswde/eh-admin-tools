(function attachCsvUtils(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CsvUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildCsvUtils() {
    'use strict';

    const FORMULA_PREFIX = /^[=+\-@]/;

    function rowIsEmpty(row) {
        return row.every(cell => cell === '');
    }

    function parseRows(input, options = {}) {
        let text = String(input ?? '');
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        const rows = [];
        let row = [];
        let value = '';
        let quoted = false;
        let closedQuote = false;

        function finishValue() {
            row.push(value);
            value = '';
            closedQuote = false;
        }

        function finishRow() {
            finishValue();
            if (!options.skipEmptyRows || !rowIsEmpty(row)) rows.push(row);
            row = [];
        }

        for (let index = 0; index < text.length; index += 1) {
            const char = text[index];
            const next = text[index + 1];
            if (quoted) {
                if (char === '"' && next === '"') {
                    value += '"';
                    index += 1;
                } else if (char === '"') {
                    quoted = false;
                    closedQuote = true;
                } else {
                    value += char;
                }
                continue;
            }
            if (closedQuote && char !== ',' && char !== '\r' && char !== '\n') {
                throw new Error(`Unexpected character after closing quote at position ${index}`);
            }
            if (char === '"') {
                if (value !== '') throw new Error(`Unexpected quote in unquoted field at position ${index}`);
                quoted = true;
            } else if (char === ',') {
                finishValue();
            } else if (char === '\r' || char === '\n') {
                finishRow();
                if (char === '\r' && next === '\n') index += 1;
            } else {
                value += char;
            }
        }
        if (quoted) throw new Error('CSV contains an unterminated quoted field');
        if (value !== '' || row.length > 0 || closedQuote) finishRow();
        return rows;
    }

    function parseObjects(input, options = {}) {
        const rows = parseRows(input, { skipEmptyRows: options.skipEmptyRows !== false });
        if (!rows.length) return [];
        const headers = rows.shift().map(header => options.trimHeaders ? header.trim() : header);
        return rows.map(row => Object.fromEntries(
            headers.map((header, index) => [header, row[index] === undefined ? '' : row[index]])
        ));
    }

    function numericColumnSet(columns) {
        if (columns instanceof Set) return columns;
        return new Set(columns || []);
    }

    function escapeCell(value, options = {}) {
        if (value === null || value === undefined) return '';
        const explicitlyNumeric = options.numeric === true
            || typeof value === 'number'
            || typeof value === 'bigint';
        let text = String(value);
        if (!explicitlyNumeric && options.neutralizeFormulas !== false && FORMULA_PREFIX.test(text)) {
            text = `'${text}`;
        }
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }

    function stringifyRows(rows, options = {}) {
        const numericColumns = numericColumnSet(options.numericColumns);
        const lineEnding = options.lineEnding || '\r\n';
        const text = Array.from(rows || [], row => Array.from(row || [], (value, index) =>
            escapeCell(value, {
                numeric: numericColumns.has(index),
                neutralizeFormulas: options.neutralizeFormulas
            })
        ).join(',')).join(lineEnding);
        return options.finalNewline === false || text === '' ? text : `${text}${lineEnding}`;
    }

    function stringifyObjects(columns, rows, options = {}) {
        const orderedColumns = Array.from(columns || []);
        const numericNames = numericColumnSet(options.numericColumns);
        const numericIndexes = new Set(orderedColumns.flatMap((column, index) =>
            numericNames.has(column) ? [index] : []
        ));
        return stringifyRows([
            orderedColumns,
            ...Array.from(rows || [], row => orderedColumns.map(column => row && row[column]))
        ], { ...options, numericColumns: numericIndexes });
    }

    return {
        parseRows,
        parseObjects,
        escapeCell,
        stringifyRows,
        stringifyObjects
    };
});
