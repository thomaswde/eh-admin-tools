const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function chartContext(width = 1000) {
    const rectangles = [];
    const context2d = {
        setTransform() {},
        clearRect() {},
        fillRect(x, y, rectWidth, height) {
            rectangles.push({ x, y, width: rectWidth, height });
        },
        fillText() {},
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
    return { canvas, rectangles };
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
