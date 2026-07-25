const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('chart theme dependency explicitly exports the API used by System Health', () => {
    const chartThemeSource = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'modules', 'chart-theme.js'),
        'utf8'
    );
    const systemHealthSource = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'modules', 'system-health-report.js'),
        'utf8'
    );
    const window = {
        addEventListener() {}
    };
    const document = {
        getElementById() {
            return null;
        },
        querySelector() {
            return null;
        },
        querySelectorAll() {
            return [];
        }
    };
    const context = vm.createContext({
        window,
        document,
        localStorage: {},
        fetch: async () => {
            throw new Error('catalog unavailable in the browser-boundary smoke test');
        },
        MutationObserver: class {},
        URLSearchParams,
        AbortController,
        Blob,
        URL,
        console
    });

    vm.runInContext(chartThemeSource, context);

    assert.equal(typeof window.initChartThemePanel, 'function');
    assert.equal(typeof window.chartThemeResolvedColors, 'function');

    vm.runInContext(systemHealthSource, context);
    assert.doesNotThrow(() => vm.runInContext('setupSystemHealthStylePanel()', context));
});
