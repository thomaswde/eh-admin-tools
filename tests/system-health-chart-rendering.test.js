const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function chartContext(width = 1000) {
    const rectangles = [];
    const texts = [];
    const context2d = {
        setTransform() {},
        clearRect() {},
        fillRect(x, y, rectWidth, height) {
            rectangles.push({ x, y, width: rectWidth, height });
        },
        fillText(value) {
            texts.push(String(value));
        },
        measureText(value) {
            return { width: String(value).length * 6 };
        },
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {}
    };
    const canvas = {
        dataset: {},
        style: {},
        parentElement: {
            clientWidth: width,
            getBoundingClientRect() {
                return { width };
            }
        },
        getContext() {
            return context2d;
        }
    };
    return { canvas, rectangles, texts };
}

function loadSystemHealthRenderer() {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'modules', 'system-health-report.js'),
        'utf8'
    );
    const palette = {
        bg: '#131218',
        text: '#ececf2',
        subtle: '#c5c5cb',
        muted: '#9e9ea4',
        grid: '#36353b',
        track: '#29282e',
        altRow: '#1d1c22',
        low: '#00aaef',
        mid: '#f59e0b',
        high: '#ef4444',
        transparent: true
    };
    const context = vm.createContext({
        window: {
            devicePixelRatio: 1,
            chartThemeResolvedColors() {
                return palette;
            }
        },
        document: {
            getElementById() {
                return null;
            },
            querySelector() {
                return null;
            },
            querySelectorAll() {
                return [];
            }
        },
        AbortController,
        Blob,
        URL,
        URLSearchParams,
        console
    });
    vm.runInContext(source, context);
    return context;
}

test('System Health canvas charts do not paint full-width alternating table rows', () => {
    const context = loadSystemHealthRenderer();
    const utilization = chartContext();
    const analysis = chartContext();
    context.utilizationCanvas = utilization.canvas;
    context.analysisCanvas = analysis.canvas;
    context.testRows = [
        {
            id: '1',
            name: 'sensor-1',
            packetPeak: 50,
            packetCapacity: 100,
            collectionStatus: { pkts: 'complete' },
            analysis: { advanced: 10, standard: 5, discovery: 0 }
        },
        {
            id: '2',
            name: 'sensor-2',
            packetPeak: 25,
            packetCapacity: 100,
            collectionStatus: { pkts: 'complete' },
            analysis: { advanced: 5, standard: 2, discovery: 0 }
        }
    ];

    vm.runInContext(`
        drawSystemHealthUtilizationCanvas(utilizationCanvas, testRows, {
            key: 'packet',
            valueKey: 'packetPeak',
            capacityKey: 'packetCapacity',
            formatter: value => String(value)
        }, {});
        drawSystemHealthAnalysisCanvas(analysisCanvas, testRows, {
            advancedCapacity: 100,
            standardCapacity: 100
        });
    `, context);

    assert.equal(
        utilization.rectangles.some(rect => rect.width >= 900),
        false,
        'utilization charts should only paint bounded bar tracks and fills'
    );
    assert.equal(
        analysis.rectangles.some(rect => rect.width >= 900),
        false,
        'analysis charts should only paint bounded bar tracks and fills'
    );
});

test('offline sensors are listed once below charts instead of receiving empty bars', () => {
    const context = loadSystemHealthRenderer();
    const utilization = chartContext();
    const analysis = chartContext();
    context.utilizationCanvas = utilization.canvas;
    context.analysisCanvas = analysis.canvas;
    context.reportingRows = [{
        id: 'online',
        name: 'Reporting sensor',
        packetPeak: 50,
        packetCapacity: 100,
        collectionStatus: { pkts: 'complete' },
        analysis: { advanced: 10, standard: 5, discovery: 0 }
    }];
    context.offlineRows = [
        { id: 'z', name: 'Zulu sensor', offline: true },
        { id: 'a', name: 'Alpha sensor', offline: true }
    ];

    vm.runInContext(`
        drawSystemHealthUtilizationCanvas(utilizationCanvas, reportingRows, {
            key: 'packet',
            valueKey: 'packetPeak',
            capacityKey: 'packetCapacity',
            formatter: value => String(value)
        }, { offlineRows });
        drawSystemHealthAnalysisCanvas(analysisCanvas, reportingRows, {
            advancedCapacity: 100,
            standardCapacity: 100,
            offlineRows
        });
    `, context);

    assert.equal(utilization.rectangles.length, 2, 'only the reporting sensor gets a track and fill');
    assert.equal(analysis.rectangles.length, 4, 'only the reporting sensor gets Advanced and Standard tracks and fills');
    assert.equal(utilization.texts.filter(text => text.startsWith('OFFLINE:')).length, 1);
    assert.equal(analysis.texts.filter(text => text.startsWith('OFFLINE:')).length, 1);
    assert.ok(utilization.texts.includes('OFFLINE: Alpha sensor, Zulu sensor'));
    assert.ok(analysis.texts.includes('OFFLINE: Alpha sensor, Zulu sensor'));
});

test('offline Packetstores use the same compact footer in all three charts', () => {
    const context = loadSystemHealthRenderer();
    const lookback = chartContext();
    const fidelity = chartContext();
    const load = chartContext();
    context.lookbackCanvas = lookback.canvas;
    context.fidelityCanvas = fidelity.canvas;
    context.loadCanvas = load.canvas;
    context.offlinePacketstores = [
        { id: 'z', name: 'Zulu Packetstore', offline: true },
        { id: 'a', name: 'Alpha Packetstore', offline: true }
    ];

    vm.runInContext(`
        drawSystemHealthPacketstoreLookback(lookbackCanvas, [], offlinePacketstores);
        drawSystemHealthPacketstoreFidelity(fidelityCanvas, [], offlinePacketstores);
        drawSystemHealthPacketstoreLoad(loadCanvas, [], offlinePacketstores);
    `, context);

    [lookback, fidelity, load].forEach(chart => {
        assert.equal(chart.rectangles.length, 0);
        assert.deepEqual(
            chart.texts.filter(text => text.startsWith('OFFLINE:')),
            ['OFFLINE: Alpha Packetstore, Zulu Packetstore']
        );
    });
});
