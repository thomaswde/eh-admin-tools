const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCapabilities(buttons = []) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'utils', 'deployment-capabilities.js'), 'utf8');
    const context = vm.createContext({
        window: {},
        document: {
            querySelectorAll(selector) {
                assert.equal(selector, '.module-btn[data-module]');
                return buttons;
            }
        }
    });
    vm.runInContext(source, context);
    return context;
}

function navButton(moduleName) {
    const attributes = {};
    const reason = { hidden: true, textContent: '' };
    return {
        dataset: { module: moduleName },
        hidden: false,
        disabled: false,
        attributes,
        classList: { remove() {} },
        querySelector(selector) {
            return selector === '.module-capability-reason' ? reason : null;
        },
        setAttribute(name, value) {
            attributes[name] = value;
        },
        title: '',
        reason
    };
}

test('capability matrix marks User Manager self-managed-only', () => {
    const context = loadCapabilities();

    assert.equal(vm.runInContext("deploymentSupportsApiFamily('enterprise', 'users')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('360', 'users')", context), false);
    assert.equal(vm.runInContext("deploymentSupportsModule('enterprise', 'users')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsModule('360', 'users')", context), false);
    assert.equal(vm.runInContext("deploymentSupportsModule('360', 'system-health')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsModule('enterprise', 'pcap-analyzer')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsModule('360', 'pcap-analyzer')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsModule('offline', 'pcap-analyzer')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsModule('offline', 'system-health')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsModule('offline', 'dashboards')", context), false);
    assert.equal(vm.runInContext("runtimeSupportsAction('offline', 'datafeed.upload')", context), true);
    assert.equal(vm.runInContext("runtimeSupportsAction('offline', 'datafeed.collect')", context), false);
    assert.equal(vm.runInContext("runtimeSupportsAction('offline', 'systemHealth.import')", context), true);
    assert.equal(vm.runInContext("runtimeSupportsAction('offline', 'systemHealth.collect')", context), false);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('enterprise', 'applianceFirmware')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('360', 'applianceFirmware')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('enterprise', 'localApplianceFirmware')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('360', 'localApplianceFirmware')", context), false);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('enterprise', 'applianceCloudServices')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('360', 'applianceCloudServices')", context), false);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('enterprise', 'applianceProductKeys')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('360', 'applianceProductKeys')", context), false);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('enterprise', 'configurationBackups')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('360', 'configurationBackups')", context), false);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('offline', 'configurationBackups')", context), false);
});

test('navigation keeps unsupported modules visible with a concise reason', () => {
    const users = navButton('users');
    const systemHealth = navButton('system-health');
    const context = loadCapabilities([users, systemHealth]);

    vm.runInContext("syncDeploymentCapabilityNavigation('360')", context);

    assert.equal(users.hidden, false);
    assert.equal(users.disabled, true);
    assert.equal(users.attributes['aria-disabled'], 'true');
    assert.equal(users.reason.hidden, false);
    assert.match(users.reason.textContent, /Enterprise/);
    assert.equal(systemHealth.hidden, false);
    assert.equal(systemHealth.disabled, false);
    assert.equal(systemHealth.attributes['aria-disabled'], 'false');

    vm.runInContext("syncDeploymentCapabilityNavigation('enterprise')", context);
    assert.equal(users.hidden, false);
    assert.equal(users.disabled, false);
    assert.equal(users.reason.hidden, true);
});

test('offline navigation enables local tools without repeating connection guidance', () => {
    const dashboards = navButton('dashboards');
    const datafeed = navButton('pcap-analyzer');
    const systemHealth = navButton('system-health');
    const context = loadCapabilities([dashboards, datafeed, systemHealth]);

    vm.runInContext("syncDeploymentCapabilityNavigation('offline')", context);

    assert.equal(dashboards.hidden, false);
    assert.equal(dashboards.disabled, true);
    assert.equal(dashboards.title, '');
    assert.equal(dashboards.reason.textContent, '');
    assert.equal(dashboards.reason.hidden, true);
    assert.equal(datafeed.disabled, false);
    assert.equal(systemHealth.disabled, false);
});

test('offline startup scripts share one cache version and local work uses the tool navigation', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const startupScripts = [
        'js/utils/deployment-capabilities.js',
        'js/utils/app-state.js',
        'js/api-client/extrahop-api.js',
        'js/utils/common.js',
        'js/auth/auth-manager.js',
        'js/utils/module-loader.js',
        'js/app.js'
    ];
    const sources = [...index.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    const versions = startupScripts.map(script => {
        const source = sources.find(value => value.startsWith(`${script}?v=`));
        assert.ok(source, `missing versioned startup script ${script}`);
        return new URL(source, 'http://localhost/').searchParams.get('v');
    });

    assert.equal(new Set(versions).size, 1, 'interdependent startup scripts must share one cache version');
    assert.doesNotMatch(index, /welcomeDatafeedBtn|welcomeSystemHealthBtn/);
    assert.match(index, /Use Datafeed Analysis or System Health in the Tools navigation/);
});

test('RevealX 360 user API calls are rejected before network transport', async () => {
    const context = loadCapabilities();
    const apiSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'api-client', 'extrahop-api.js'), 'utf8');
    let fetchCalls = 0;
    Object.assign(context, {
        console,
        setTimeout,
        clearTimeout,
        AbortController,
        fetch: async () => {
            fetchCalls++;
            throw new Error('network transport should not run');
        },
        sessionStorage: { removeItem() {} }
    });
    vm.runInContext(apiSource, context);

    await assert.rejects(
        vm.runInContext("new ExtraHopAPI({ type: '360' }).listUsers()", context),
        (error) => error.code === 'UNSUPPORTED_DEPLOYMENT_CAPABILITY'
    );
    const suppressed = await vm.runInContext("new ExtraHopAPI({ type: '360' }).getUsers()", context);

    assert.equal(suppressed.length, 0);
    assert.equal(fetchCalls, 0);
});
