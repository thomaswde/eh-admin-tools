const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FeatureRegistry } = require('../js/utils/feature-registry.js');

const moduleLoaderSource = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'utils', 'module-loader.js'),
    'utf8'
);

function createHarness({ hooks = {}, supports = true, registerModules = true } = {}) {
    const scripts = [];
    const events = [];
    const featureRegistry = new FeatureRegistry();
    const quietConsole = { log() {}, warn() {}, error() {} };
    const document = {
        head: {
            appendChild(script) {
                scripts.push(script);
                queueMicrotask(() => {
                    if (script.dataset.moduleName && registerModules) {
                        featureRegistry.register(
                            script.dataset.moduleName,
                            hooks[script.dataset.moduleName] || {}
                        );
                    }
                    script.onload();
                });
            }
        },
        createElement() {
            return {
                dataset: {},
                remove() {
                    const index = scripts.indexOf(this);
                    if (index >= 0) scripts.splice(index, 1);
                }
            };
        },
        querySelector(selector) {
            const match = selector.match(/^script\[data-(module-name|module-dependency)="([^"]+)"\]$/);
            if (!match) return null;
            const datasetKey = match[1] === 'module-name' ? 'moduleName' : 'moduleDependency';
            return scripts.find(script => script.dataset[datasetKey] === match[2]) || null;
        }
    };
    const context = vm.createContext({
        console: quietConsole,
        document,
        featureRegistry,
        window: { state: { apiConfig: { type: 'enterprise' } } },
        deploymentSupportsModule: () => supports,
        switchModule(moduleName) {
            events.push(`visible:${moduleName}`);
        }
    });
    vm.runInContext(moduleLoaderSource, context);
    return {
        loader: vm.runInContext('new ModuleLoader()', context),
        featureRegistry,
        scripts,
        events
    };
}

test('concurrent module loads share one dependency and module script sequence', async () => {
    const { loader, scripts } = createHarness();
    const results = await Promise.all([
        loader.loadModule('system-health'),
        loader.loadModule('system-health')
    ]);

    assert.deepEqual(results, [true, true]);
    assert.deepEqual(
        scripts.map(script => script.src.replace(/\?v=\d+$/, '')),
        [
            'js/modules/chart-theme.js',
            'js/modules/system-health-collection.js',
            'js/modules/system-health-view-model.js',
            'js/modules/system-health-pptx.js',
            'js/modules/system-health-report.js'
        ]
    );
    assert.equal(await loader.loadModule('system-health'), true);
    assert.equal(scripts.length, 5);
});

test('Records Report loads the shared collector before its registered feature', async () => {
    const { loader, scripts } = createHarness();
    assert.equal(await loader.loadModule('crs-usage'), true);
    assert.deepEqual(
        scripts.map(script => script.src.replace(/\?v=\d+$/, '')),
        ['js/modules/system-health-collection.js', 'js/modules/records-report.js']
    );
});

test('Datafeed Analysis loads its cohesive feature script without unrelated dependencies', async () => {
    const { loader, scripts } = createHarness();
    assert.equal(await loader.loadModule('pcap-analyzer'), true);
    assert.deepEqual(
        scripts.map(script => script.src.replace(/\?v=\d+$/, '')),
        ['js/modules/pcap-analyzer.js']
    );
});

test('switch order is initialize then visible DOM then awaited activate', async () => {
    const events = [];
    const harness = createHarness({
        hooks: {
            dashboards: {
                async initialize() { events.push('initialize'); },
                async activate() { events.push('activate'); }
            }
        }
    });
    harness.events.push = event => events.push(event);

    assert.equal(await harness.loader.switchToModule('dashboards'), true);
    assert.deepEqual(events, ['initialize', 'visible:dashboards', 'activate']);
    assert.equal(harness.featureRegistry.getState('dashboards').active, true);
});

test('concurrent switches deduplicate load, initialization, and activation', async () => {
    let initializeCalls = 0;
    let activateCalls = 0;
    const { loader, scripts } = createHarness({
        hooks: {
            dashboards: {
                async initialize() { initializeCalls += 1; },
                async activate() { activateCalls += 1; }
            }
        }
    });

    assert.deepEqual(await Promise.all([
        loader.switchToModule('dashboards'),
        loader.switchToModule('dashboards')
    ]), [true, true]);
    assert.equal(initializeCalls, 1);
    assert.equal(activateCalls, 1);
    assert.equal(scripts.filter(script => script.dataset.moduleName === 'dashboards').length, 1);
});

test('a direct load concurrent with a switch shares the registered script', async () => {
    let initializeCalls = 0;
    let activateCalls = 0;
    const { loader, scripts } = createHarness({
        hooks: {
            dashboards: {
                initialize() { initializeCalls += 1; },
                activate() { activateCalls += 1; }
            }
        }
    });

    assert.deepEqual(await Promise.all([
        loader.loadModule('dashboards'),
        loader.switchToModule('dashboards')
    ]), [true, true]);
    assert.equal(initializeCalls, 1);
    assert.equal(activateCalls, 1);
    assert.equal(scripts.filter(script => script.dataset.moduleName === 'dashboards').length, 1);
});

test('activation failure is reported and initialization remains successful for retry', async () => {
    let initializeCalls = 0;
    let activateCalls = 0;
    const { loader, featureRegistry } = createHarness({
        hooks: {
            dashboards: {
                initialize() { initializeCalls += 1; },
                activate() {
                    activateCalls += 1;
                    if (activateCalls === 1) throw new Error('temporary activation failure');
                }
            }
        }
    });

    assert.equal(await loader.switchToModule('dashboards'), false);
    assert.deepEqual(featureRegistry.getState('dashboards'), {
        initialized: true,
        initializing: false,
        active: false
    });
    assert.equal(await loader.switchToModule('dashboards'), true);
    assert.equal(initializeCalls, 1);
    assert.equal(activateCalls, 2);
});

test('unsupported modules are rejected before script loading', async () => {
    const { loader, scripts } = createHarness({ supports: false });
    assert.equal(await loader.switchToModule('users'), false);
    assert.equal(scripts.length, 0);
});

test('a classic script that does not register its feature fails loading', async () => {
    const { loader } = createHarness({ registerModules: false });
    assert.equal(await loader.loadModule('dashboards'), false);
    assert.equal(loader.isModuleLoaded('dashboards'), false);
});
