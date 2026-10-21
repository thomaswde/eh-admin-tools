const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('pending saved connections do not block controls or the rest of startup', async () => {
    const context = vm.createContext({
        window: { addEventListener() {} },
        console
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8'), context);
    const calls = [];
    context.initTheme = () => {};
    context.loadSavedConfig = () => {};
    context.setupGlobalEventListeners = () => calls.push('controls');
    context.loadSavedConnections = () => new Promise(() => {});
    context.restoreBackendSession = async () => calls.push('workspace');
    context.loadApiLoggingStatus = async () => calls.push('logging');
    context.setBuildVersion = async () => calls.push('version');
    await vm.runInContext('initializeApp()', context);
    assert.deepEqual(calls, ['controls', 'workspace', 'logging', 'version']);
});
