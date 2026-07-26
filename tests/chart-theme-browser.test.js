const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('chart theme dependency explicitly exports the API used by System Health', async () => {
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
    let resolvedTheme = 'light';
    const document = {
        documentElement: {
            getAttribute() {
                return resolvedTheme;
            }
        },
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
    assert.deepEqual(
        JSON.parse(JSON.stringify(vm.runInContext('window.chartThemeResolvedColors()', context))),
        {
            bg: '#ffffff',
            text: '#16151f',
            low: '#00aaef',
            mid: '#f59e0b',
            high: '#ef4444',
            subtle: '#403f47',
            muted: '#6a6970',
            grid: '#dadadb',
            track: '#e8e8e9',
            altRow: '#f5f4f5',
            transparent: false
        }
    );
    resolvedTheme = 'dark';
    assert.deepEqual(
        JSON.parse(JSON.stringify(vm.runInContext('window.chartThemeResolvedColors()', context))),
        {
            bg: '#131218',
            text: '#ececf2',
            low: '#00aaef',
            mid: '#f59e0b',
            high: '#ef4444',
            subtle: '#c5c5cb',
            muted: '#9e9ea4',
            grid: '#36353b',
            track: '#29282e',
            altRow: '#1d1c22',
            transparent: false
        }
    );
    const firstPanelInitializer = window.initChartThemePanel;
    const firstPaletteResolver = window.chartThemeResolvedColors;
    assert.doesNotThrow(() => vm.runInContext(chartThemeSource, context));
    assert.equal(window.initChartThemePanel, firstPanelInitializer);
    assert.equal(window.chartThemeResolvedColors, firstPaletteResolver);

    vm.runInContext(systemHealthSource, context);
    assert.doesNotThrow(() => vm.runInContext('setupSystemHealthStylePanel()', context));

    const sequence = [];
    let releaseTimeSeries;
    context.sequence = sequence;
    context.timeSeriesGate = new Promise(resolve => {
        releaseTimeSeries = resolve;
    });
    vm.runInContext(`
        collectSystemHealthTimeSeries = async () => {
            sequence.push('time-series-start');
            await timeSeriesGate;
            sequence.push('time-series-complete');
            return { metrics: {}, trigger_utilization: {}, errors: [] };
        };
        collectSystemHealthTriggerDrops = async () => {
            sequence.push('totals-start');
            return { errors: [] };
        };
    `, context);

    const collection = vm.runInContext('collectSystemHealthMetrics([], [], {}, {})', context);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sequence, ['time-series-start']);
    releaseTimeSeries();
    await collection;
    assert.deepEqual(sequence, ['time-series-start', 'time-series-complete', 'totals-start']);
});
