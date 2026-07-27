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
    return {
        dataset: { module: moduleName },
        hidden: false,
        disabled: false,
        attributes,
        classList: { remove() {} },
        setAttribute(name, value) {
            attributes[name] = value;
        }
    };
}

test('capability matrix marks User Manager self-managed-only', () => {
    const context = loadCapabilities();

    assert.equal(vm.runInContext("deploymentSupportsApiFamily('enterprise', 'users')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('360', 'users')", context), false);
    assert.equal(vm.runInContext("deploymentSupportsModule('enterprise', 'users')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsModule('360', 'users')", context), false);
    assert.equal(vm.runInContext("deploymentSupportsModule('360', 'system-health')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('enterprise', 'applianceFirmware')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('360', 'applianceFirmware')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('enterprise', 'localApplianceFirmware')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('360', 'localApplianceFirmware')", context), false);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('enterprise', 'applianceCloudServices')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('360', 'applianceCloudServices')", context), false);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('enterprise', 'applianceProductKeys')", context), true);
    assert.equal(vm.runInContext("deploymentSupportsApiFamily('360', 'applianceProductKeys')", context), false);
});

test('RevealX 360 navigation hides and disables only unsupported modules', () => {
    const users = navButton('users');
    const systemHealth = navButton('system-health');
    const context = loadCapabilities([users, systemHealth]);

    vm.runInContext("syncDeploymentCapabilityNavigation('360')", context);

    assert.equal(users.hidden, true);
    assert.equal(users.disabled, true);
    assert.equal(users.attributes['aria-disabled'], 'true');
    assert.equal(systemHealth.hidden, false);
    assert.equal(systemHealth.disabled, false);
    assert.equal(systemHealth.attributes['aria-disabled'], 'false');

    vm.runInContext("syncDeploymentCapabilityNavigation('enterprise')", context);
    assert.equal(users.hidden, false);
    assert.equal(users.disabled, false);
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
