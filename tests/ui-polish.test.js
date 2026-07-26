const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

function source(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('Connected Appliances uses an inline tick filter menu and a wide group select', () => {
    const html = source('index.html');
    const customSelect = source('js/ui/custom-select.js');
    const nodemap = source('js/modules/nodemap.js');

    assert.match(html, /id="nodemapFiltersMenu"[^>]*hidden/);
    assert.doesNotMatch(html, /id="nodemapFiltersModal"/);
    assert.match(html, /id="nodemapGroupBy" data-custom-select-min-width="176"/);
    assert.match(customSelect, /customSelectMinWidth/);
    assert.match(nodemap, /setNodemapFilterMenuOpen/);
});

test('Topology uses a far-left trunk and row-level right-angle branches', () => {
    const nodemap = source('js/modules/nodemap.js');

    assert.match(nodemap, /const trunkX = 18/);
    assert.match(nodemap, /const rowConnections = rowCenters\.map/);
    assert.match(nodemap, /attr\('class', 'branch'\)/);
    assert.match(nodemap, /M \$\{trunkX\} \$\{row\.centerY\} H \$\{row\.endX\}/);
    assert.match(nodemap, /attr\('x1', nodeStartX\)/);
});

test('Devices use a horizontal borderless chart with state-aware colors', () => {
    const discovery = source('js/modules/device-discovery.js');

    assert.match(discovery, /indexAxis: 'y'/);
    assert.match(discovery, /borderWidth: 0/);
    assert.match(discovery, /standard:.*stateIndicatorColor\('warning'\)/);
    assert.match(discovery, /discovery:.*stateIndicatorColor\('error'\)/);
    assert.match(discovery, /wrapper\.style\.height/);
});

test('System Health and Records labels and layouts match the revised UI', () => {
    const html = source('index.html');

    assert.match(html, /<h2 class="card-title">Report<\/h2>/);
    assert.match(html, /<h2 class="card-title">Import Export<\/h2>/);
    assert.match(html, /id="chartThemePanel" open/);
    assert.match(html, /Import capacity data/);
    assert.match(html, /Reserved daily capacity \(GB\)/);
    assert.match(html, /Utilized daily capacity \(GB\)/);
    assert.match(html, /Total uncompressed record bytes/);
});

test('Selected controls use neutral shading instead of cyan outlines', () => {
    const css = source('css/styles.css');

    assert.match(css, /:focus-visible\s*\{\s*outline: 2px solid var\(--text-2\)/);
    assert.match(css, /\.theme-card\.is-active\s*\{[\s\S]*?background-color: var\(--chip-bg\)/);
    assert.doesNotMatch(css, /outline: 2px solid var\(--cyan\)/);
});
