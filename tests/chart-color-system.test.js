const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..');

function source(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('shared chart colors use one categorical palette plus semantic state colors', () => {
    const css = source('css/styles.css');
    const common = source('js/utils/common.js');
    const cssValues = Object.fromEntries(
        [...css.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)]
            .map(([, name, value]) => [`--${name}`, value.toLowerCase()])
    );
    const context = vm.createContext({
        document: { documentElement: {} },
        getComputedStyle() {
            return {
                getPropertyValue(token) {
                    return cssValues[token] || '';
                }
            };
        }
    });

    vm.runInContext(common, context);

    assert.deepEqual(
        Array.from(vm.runInContext(
            'Array.from({ length: 8 }, (_, index) => genericChartPaletteColor(index))',
            context
        )),
        ['#00aaef', '#5e55d7', '#bb5fd8', '#d0638d', '#d28861', '#d4dd73', '#8fdb6f', '#86dba9']
    );
    assert.equal(vm.runInContext("stateIndicatorColor('warning')", context), '#f59e0b');
    assert.equal(vm.runInContext("stateIndicatorColor('error')", context), '#ef4444');
    assert.doesNotMatch(css, /--chart-primary:/);
    assert.doesNotMatch(common, /genericChartPrimaryColor/);
});

test('generic charts use the shared palette while warning and error series stay semantic', () => {
    const audit = source('js/modules/audit-logs.js');
    const records = source('js/modules/records-report.js');
    const discovery = source('js/modules/device-discovery.js');
    const nodemap = source('js/modules/nodemap.js');

    assert.match(audit, /backgroundColor:\s*genericChartPaletteColor\(0\)/);
    assert.match(audit, /backgroundColor:\s*genericChartPaletteColor\(colorIndex\)/);
    assert.match(records, /backgroundColor:\s*genericChartPaletteColor\(0\)/);
    assert.match(records, /backgroundColor:\s*genericChartPaletteColor\(i\)/);
    assert.doesNotMatch([audit, records, discovery, nodemap].join('\n'), /#(?:261f63|7f2854|ec0089)/i);
    assert.doesNotMatch([audit, records, discovery, nodemap].join('\n'), /genericChartPrimaryColor/);
    assert.match(discovery, /advanced:.*genericChartPaletteColor\(0\)/);
    assert.match(discovery, /standard:.*stateIndicatorColor\('warning'\)/);
    assert.match(discovery, /discovery:.*stateIndicatorColor\('error'\)/);
    assert.match(discovery, /flow_log:.*genericChartPaletteColor\(1\)/);
    assert.match(nodemap, /'command':\s*genericChartPaletteColor\(3\)/);
    assert.match(nodemap, /stateIndicatorColor\('warning'\)/);
    assert.match(nodemap, /stateIndicatorColor\('error'\)/);
});

test('dark selected controls stay neutral with light text', () => {
    const css = source('css/styles.css');
    const darkBlock = css.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] || '';

    assert.match(darkBlock, /--primary-bg:\s*#3b3a46/);
    assert.match(darkBlock, /--primary-fg:\s*#ececf2/);
    assert.match(darkBlock, /--chip-bg:\s*#302f39/);
    assert.doesNotMatch(darkBlock, /--(?:primary-bg|chip-bg):\s*#(?:261f63|7f2854)/i);
});
