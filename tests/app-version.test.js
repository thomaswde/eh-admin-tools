const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('build version toggles the dirty tag from backend state', async () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'app.js'),
        'utf8'
    );
    const versionElement = { textContent: '' };
    const dirtyClasses = new Set(['hidden']);
    let isDirty = true;
    const dirtyTag = {
        classList: {
            add(name) {
                dirtyClasses.add(name);
            },
            toggle(name, force) {
                if (force) dirtyClasses.add(name);
                else dirtyClasses.delete(name);
            }
        }
    };
    const context = vm.createContext({
        window: {
            addEventListener() {},
            apiClient: null
        },
        document: {
            getElementById(id) {
                if (id === 'buildVersion') return versionElement;
                if (id === 'buildDirtyTag') return dirtyTag;
                return null;
            }
        },
        fetch: async () => ({
            ok: true,
            json: async () => ({
                version: '2026.07.25',
                commit: 'a1b2c3d',
                dirty: isDirty
            })
        }),
        console
    });

    vm.runInContext(source, context);
    await vm.runInContext('setBuildVersion()', context);

    assert.equal(versionElement.textContent, '26.07.25 - a1b2c3d');
    assert.equal(dirtyClasses.has('hidden'), false);

    isDirty = false;
    await vm.runInContext('setBuildVersion()', context);

    assert.equal(dirtyClasses.has('hidden'), true);
});
