const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('concurrent module loads share one dependency and module script sequence', async () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'utils', 'module-loader.js'),
        'utf8'
    );
    const scripts = [];
    const document = {
        head: {
            appendChild(script) {
                scripts.push(script);
                queueMicrotask(() => script.onload());
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
        console,
        document,
        switchModule() {}
    });

    vm.runInContext(source, context);
    const loader = vm.runInContext('new ModuleLoader()', context);

    const results = await Promise.all([
        loader.loadModule('system-health'),
        loader.loadModule('system-health')
    ]);

    assert.deepEqual(results, [true, true]);
    assert.equal(scripts.length, 4);
    assert.deepEqual(
        scripts.map(script => script.src.replace(/\?v=\d+$/, '')),
        [
            'js/modules/chart-theme.js',
            'js/modules/system-health-collection.js',
            'js/modules/system-health-pptx.js',
            'js/modules/system-health-report.js'
        ]
    );

    assert.equal(await loader.loadModule('system-health'), true);
    assert.equal(scripts.length, 4);
});
