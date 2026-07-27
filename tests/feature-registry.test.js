const test = require('node:test');
const assert = require('node:assert/strict');
const { FeatureRegistry } = require('../js/utils/feature-registry.js');

test('browser loads the registry before the dynamic module loader', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(html.indexOf('js/utils/feature-registry.js') < html.indexOf('js/utils/module-loader.js'));
});

test('every dynamically mapped feature registers its exact module name', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const registrations = {
        dashboards: 'dashboard-manager.js',
        users: 'user-manager.js',
        'crs-usage': 'records-report.js',
        'device-discovery': 'device-discovery.js',
        'system-health': 'system-health-report.js',
        localities: 'network-localities.js',
        'audit-logs': 'audit-logs.js',
        nodemap: 'nodemap.js'
    };
    for (const [name, filename] of Object.entries(registrations)) {
        const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'modules', filename), 'utf8');
        assert.match(source, new RegExp(`featureRegistry\\.register\\('${name.replace('-', '\\-')}'`));
    }
});

test('initialization is successful once and concurrent callers share in-flight work', async () => {
    const registry = new FeatureRegistry();
    let calls = 0;
    let release;
    registry.register('reports', {
        initialize() {
            calls += 1;
            return new Promise(resolve => { release = resolve; });
        }
    });

    const first = registry.initialize('reports');
    const second = registry.initialize('reports');
    assert.strictEqual(first, second);
    assert.equal(calls, 0);
    await Promise.resolve();
    assert.equal(calls, 1);
    release();
    await Promise.all([first, second]);
    await registry.initialize('reports');
    assert.equal(calls, 1);
});

test('failed initialization can be retried', async () => {
    const registry = new FeatureRegistry();
    let calls = 0;
    registry.register('reports', {
        initialize() {
            calls += 1;
            if (calls === 1) throw new Error('not ready');
        }
    });

    await assert.rejects(registry.initialize('reports'), /not ready/);
    assert.equal(registry.getState('reports').initialized, false);
    await registry.initialize('reports');
    assert.equal(calls, 2);
    assert.equal(registry.getState('reports').initialized, true);
});

test('activating a feature cancels and deactivates the prior active feature', async () => {
    const registry = new FeatureRegistry();
    const events = [];
    registry.register('one', {
        initialize() { events.push('initialize:one'); },
        activate() { events.push('activate:one'); },
        cancel(context) { events.push(`cancel:one:${context.nextFeature}`); },
        deactivate(context) { events.push(`deactivate:one:${context.nextFeature}`); }
    });
    registry.register('two', {
        initialize() { events.push('initialize:two'); },
        activate() { events.push('activate:two'); }
    });

    await registry.activate('one');
    await registry.activate('two');
    assert.deepEqual(events, [
        'initialize:one',
        'activate:one',
        'initialize:two',
        'cancel:one:two',
        'deactivate:one:two',
        'activate:two'
    ]);
    assert.equal(registry.getState('one').active, false);
    assert.equal(registry.getState('two').active, true);
});

test('activation errors do not mark the failed feature active', async () => {
    const registry = new FeatureRegistry();
    registry.register('broken', {
        activate() { throw new Error('activation failed'); }
    });

    await assert.rejects(registry.activate('broken'), /activation failed/);
    assert.deepEqual(registry.getState('broken'), {
        initialized: true,
        initializing: false,
        active: false
    });
});

test('cleanup failures do not prevent the next feature from activating', async () => {
    const registry = new FeatureRegistry();
    registry.register('one', {
        cancel() { throw new Error('cancel failed'); }
    });
    registry.register('two', {});

    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args);
    try {
        await registry.activate('one');
        await registry.activate('two');
    } finally {
        console.error = originalError;
    }

    assert.equal(registry.getState('one').active, false);
    assert.equal(registry.getState('two').active, true);
    assert.equal(errors.length, 1);
    assert.match(errors[0][0], /cleanup failed/);
});

test('registration rejects duplicate names and invalid hooks', () => {
    const registry = new FeatureRegistry();
    registry.register('one', {});
    assert.throws(() => registry.register('one', {}), /already registered/);
    assert.throws(() => registry.register('two', { activate: true }), /must be a function/);
});
