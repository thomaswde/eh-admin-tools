const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function chartContext(width = 1000) {
    const rectangles = [];
    const texts = [];
    const textDraws = [];
    const context2d = {
        setTransform() {},
        clearRect() {},
        fillRect(x, y, rectWidth, height) {
            rectangles.push({ x, y, width: rectWidth, height, fillStyle: this.fillStyle });
        },
        fillText(value, x, y) {
            texts.push(String(value));
            textDraws.push({ text: String(value), x, y, fillStyle: this.fillStyle, font: this.font });
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
    return { canvas, rectangles, texts, textDraws };
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
        SystemHealthViewModel: require('../js/modules/system-health-view-model.js'),
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
    assert.ok(utilization.texts.includes('2 OFFLINE'));
    assert.ok(analysis.texts.includes('2 OFFLINE'));
    assert.ok(utilization.texts.includes('Alpha sensor, Zulu sensor'));
    assert.ok(analysis.texts.includes('Alpha sensor, Zulu sensor'));
    assert.ok(parseInt(utilization.canvas.style.height, 10) > 130, 'footer receives dedicated vertical space');
    assert.ok(parseInt(analysis.canvas.style.height, 10) > 150, 'analysis footer receives dedicated vertical space');
});

test('offline footer wraps every appliance name within the canvas and expands its height', () => {
    const context = loadSystemHealthRenderer();
    const utilization = chartContext(720);
    context.utilizationCanvas = utilization.canvas;
    context.reportingRows = [{
        id: 'online', name: 'Reporting sensor', packetPeak: 50, packetCapacity: 100,
        collectionStatus: { pkts: 'complete' }
    }];
    context.offlineRows = Array.from({ length: 37 }, (_, index) => ({
        id: `offline-${index}`,
        name: `offline-sensor-${String(index + 1).padStart(2, '0')}`,
        offline: true
    }));

    vm.runInContext(`
        drawSystemHealthUtilizationCanvas(utilizationCanvas, reportingRows, {
            key: 'packet', valueKey: 'packetPeak', capacityKey: 'packetCapacity',
            formatter: value => String(value)
        }, { offlineRows });
    `, context);

    const nameLines = utilization.textDraws.filter(draw => draw.text.startsWith('offline-sensor-'));
    const canvasHeight = parseInt(utilization.canvas.style.height, 10);
    assert.ok(utilization.texts.includes('37 OFFLINE'));
    assert.ok(nameLines.length >= 5, 'many offline names wrap across multiple lines');
    assert.equal(nameLines.map(draw => draw.text).join(', ').includes('offline-sensor-37'), true, 'the full list remains visible');
    assert.equal(nameLines.every(draw => draw.text.length * 6 <= 680), true, 'wrapped lines stay inside horizontal padding');
    assert.ok(canvasHeight > 180, 'canvas grows to reserve the wrapped footer');
    assert.ok(Math.max(...nameLines.map(draw => draw.y)) < canvasHeight - 10, 'the final line stays above bottom padding');
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
        assert.ok(chart.texts.includes('2 OFFLINE'));
        assert.ok(chart.texts.includes('Alpha Packetstore, Zulu Packetstore'));
    });
});

test('Packetstore fidelity colors packet and secret loss independently and shows dropped blocks', () => {
    const context = loadSystemHealthRenderer();
    const fidelity = chartContext();
    context.fidelityCanvas = fidelity.canvas;
    context.fidelityRows = [{
        id: 'store', name: 'Packetstore',
        packetDropRatio: 0.005, packetDropsTotal: 5,
        secretDropRatio: 0.02, secretDropsTotal: 2, secretsTotal: 100,
        slowWriteDropsTotal: 0, interfaceDropsTotal: 0, blocksDroppedTotal: 7
    }];

    vm.runInContext('drawSystemHealthPacketstoreFidelity(fidelityCanvas, fidelityRows, []);', context);

    assert.ok(fidelity.rectangles.some(rect => rect.fillStyle === '#f59e0b'), 'packet warning bar is orange');
    assert.ok(fidelity.rectangles.some(rect => rect.fillStyle === '#ef4444'), 'secret critical bar is red');
    assert.equal(fidelity.textDraws.find(draw => draw.text.startsWith('packets')).fillStyle, '#f59e0b');
    assert.equal(fidelity.textDraws.find(draw => draw.text.startsWith('secrets')).fillStyle, '#ef4444');
    assert.equal(fidelity.textDraws.find(draw => draw.text.startsWith('blocks')).fillStyle, '#f59e0b');
});
