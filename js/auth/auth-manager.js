/* exported deleteSavedConnection, editSavedConnection, handleConnect, handleDisconnect, handleSavedConnect, recheckSecureStorage */
function groupSavedConnections(connections) {
    const sorted = [...(connections || [])].sort((left, right) => {
        const labelOrder = String(left.label || '').localeCompare(
            String(right.label || ''),
            undefined,
            { sensitivity: 'base' }
        );
        if (labelOrder !== 0) return labelOrder;
        return String(left.id || '').localeCompare(String(right.id || ''));
    });
    const has360 = sorted.some(connection => connection.type === '360');
    const hasEnterprise = sorted.some(connection => connection.type === 'enterprise');
    if (!has360 || !hasEnterprise) {
        return [{ label: null, connections: sorted }];
    }
    return [
        {
            label: 'RevealX 360',
            connections: sorted.filter(connection => connection.type === '360')
        },
        {
            label: 'RevealX Enterprise',
            connections: sorted.filter(connection => connection.type === 'enterprise')
        }
    ];
}

function savedConnectionTarget(connection) {
    if (connection?.type === '360') {
        return String(connection.tenant || connection.label || '').trim().toLowerCase();
    }
    if (connection?.type === 'enterprise') {
        return String(connection.host || connection.label || '').trim().toLowerCase();
    }
    return '';
}

function activeConnectionTarget(config) {
    if (config?.type === '360') {
        return String(config.tenant || '').trim().toLowerCase();
    }
    if (config?.type === 'enterprise') {
        return String(config.host || '').trim().toLowerCase();
    }
    return '';
}

function findActiveSavedConnectionId(connections, config) {
    const target = activeConnectionTarget(config);
    if (!target) return '';

    const match = (connections || []).find(connection => (
        connection?.type === config.type
        && savedConnectionTarget(connection) === target
    ));
    return match?.id || '';
}

let savedConnectionCatalog = [];
let editingSavedConnectionId = '';

function selectedSavedConnection() {
    const connectionId = document.getElementById('savedConnectionSelect')?.value;
    return savedConnectionCatalog.find(connection => connection.id === connectionId) || null;
}

function syncSavedEnterpriseProxyTokenVisibility() {
    const field = document.getElementById('savedEnterpriseProxyTokenField');
    const input = document.getElementById('savedEnterpriseProxyToken');
    if (!field || !input) return;

    const show = selectedSavedConnection()?.type === 'enterprise';
    field.hidden = !show;
    if (!show) input.value = '';
}

function syncSavedConnectionSelection(connections = savedConnectionCatalog) {
    const select = document.getElementById('savedConnectionSelect');
    const connectBtn = document.getElementById('connectSavedBtn');
    if (!select) return;

    const activeConfig = state.connected ? state.apiConfig : null;
    const activeConnectionId = findActiveSavedConnectionId(connections, activeConfig);
    if (activeConfig) {
        // An active connection must never make an unrelated saved connection
        // appear selected. Leave the prompt selected if it is not in the catalog.
        select.value = activeConnectionId;
    } else {
        select.value = connections[0]?.id || '';
    }

    if (connectBtn) connectBtn.disabled = !select.value;
    syncSavedEnterpriseProxyTokenVisibility();
    window.refreshCustomSelect?.(select);
}

function renderSecureStorageRecovery(secureStorage) {
    const panel = document.getElementById('secureStorageRecovery');
    const command = document.getElementById('secureStorageSetupCommand');
    const instruction = document.getElementById('secureStorageRecoveryInstruction');
    const recoveryStatus = document.getElementById('secureStorageRecoveryStatus');
    if (!panel || !command || !instruction || !recoveryStatus) return;

    const recovery = secureStorage?.recovery;
    const show = secureStorage?.available === false
        && recovery?.kind === 'wsl-secret-service';
    panel.hidden = !show;
    if (!show) return;

    const setupCommand = typeof recovery.command === 'string'
        ? recovery.command.trim()
        : '';
    command.textContent = setupCommand;
    command.hidden = !setupCommand;
    command.style.display = setupCommand ? '' : 'none';
    instruction.textContent = setupCommand
        ? 'Select and copy this command, run it in your WSL terminal, then return here and check again. If prompted, create or unlock the keyring.'
        : 'Install GNOME Keyring with this WSL distribution\'s package manager, then return here and check again. If prompted, create or unlock the keyring.';
    recoveryStatus.textContent = '';
}

function visibleSavedConnectionWarnings(catalog) {
    const hasStructuredStorageRecovery = catalog?.secureStorage?.available === false
        && catalog.secureStorage?.recovery?.kind === 'wsl-secret-service';
    return [...new Set(
        (Array.isArray(catalog?.warnings) ? catalog.warnings : [])
            .filter(message => typeof message === 'string' && message)
            .filter(message => (
                !hasStructuredStorageRecovery
                || message !== catalog.secureStorage?.message
            ))
    )];
}

async function loadSavedConnections({ recheckSecureStorage = false } = {}) {
    const select = document.getElementById('savedConnectionSelect');
    const connectBtn = document.getElementById('connectSavedBtn');
    const status = document.getElementById('savedConnectionStatus');
    if (!select || !connectBtn || !status) return;

    select.disabled = true;
    connectBtn.disabled = true;
    status.textContent = 'Checking the local .env file and secure credential store.';

    try {
        const catalog = recheckSecureStorage
            ? await ExtraHopAPI.recheckSecureStorage()
            : await ExtraHopAPI.listSavedConnections();
        const connections = Array.isArray(catalog.connections) ? catalog.connections : [];
        savedConnectionCatalog = connections;
        renderSecureStorageRecovery(catalog.secureStorage);
        select.replaceChildren();

        if (connections.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No saved connections';
            select.appendChild(option);
        } else {
            const prompt = document.createElement('option');
            prompt.value = '';
            prompt.textContent = 'Choose a saved connection';
            prompt.disabled = true;
            select.appendChild(prompt);

            for (const group of groupSavedConnections(connections)) {
                const parent = group.label
                    ? Object.assign(document.createElement('optgroup'), { label: group.label })
                    : select;
                for (const connection of group.connections) {
                    const option = document.createElement('option');
                    option.value = connection.id;
                    option.textContent = connection.label;
                    option.dataset.deploymentType = connection.type;
                    option.dataset.connectionTarget = savedConnectionTarget(connection);
                    option.dataset.connectionEditable = String(connection.editable === true);
                    parent.appendChild(option);
                }
                if (group.label) select.appendChild(parent);
            }
        }

        select.disabled = connections.length === 0;
        syncSavedConnectionSelection(connections);

        const sourceParts = [];
        if (catalog.env?.connectionCount) {
            sourceParts.push(`${catalog.env.connectionCount} from .env`);
        }
        if (catalog.secureStorage?.connectionCount) {
            sourceParts.push(`${catalog.secureStorage.connectionCount} from secure storage`);
        }
        const warnings = visibleSavedConnectionWarnings(catalog);
        if (connections.length === 0) {
            status.textContent = warnings.join(' ') || 'No saved connections found.';
        } else {
            status.textContent = `${connections.length} saved connection${connections.length === 1 ? '' : 's'}`
                + (sourceParts.length ? ` (${sourceParts.join(', ')})` : '')
                + '.';
            if (warnings.length) {
                status.textContent += ` ${warnings.join(' ')}`;
            }
        }
    } catch (error) {
        savedConnectionCatalog = [];
        renderSecureStorageRecovery(null);
        select.replaceChildren();
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Saved connections unavailable';
        select.appendChild(option);
        select.disabled = true;
        connectBtn.disabled = true;
        syncSavedEnterpriseProxyTokenVisibility();
        window.refreshCustomSelect?.(select);
        status.textContent = error.message;
    }
}

async function recheckSecureStorage() {
    const button = document.getElementById('recheckSecureStorageBtn');
    const status = document.getElementById('secureStorageRecoveryStatus');
    if (!button || !status) return;

    button.disabled = true;
    button.textContent = 'Checking...';
    status.textContent = 'Checking for a Linux Secret Service...';
    try {
        await loadSavedConnections({ recheckSecureStorage: true });
        const panel = document.getElementById('secureStorageRecovery');
        if (!panel?.hidden) {
            status.textContent = 'Secure storage is still unavailable. Finish the setup in WSL, then check again.';
        }
    } finally {
        button.disabled = false;
        button.textContent = 'Check again';
    }
}

function setDeploymentForm(deploymentType) {
    const is360 = deploymentType === '360';
    document.getElementById('config360').style.display = is360 ? 'block' : 'none';
    document.getElementById('configEnterprise').style.display = is360 ? 'none' : 'flex';
}

function setConnectionEditHints(show) {
    ['apiIdEditHint', 'apiSecretEditHint', 'enterpriseApiKeyEditHint'].forEach(id => {
        const hint = document.getElementById(id);
        if (hint) hint.hidden = !show;
    });
}

function resetConnectionFormMode() {
    editingSavedConnectionId = '';
    const deployment = document.getElementById('deploymentType');
    deployment.disabled = false;
    document.getElementById('connectionFormTitle').textContent = 'New connection';
    document.getElementById('connectBtn').textContent = 'Connect and save';
    setConnectionEditHints(false);
    window.refreshCustomSelect?.(deployment);
}

function showNewConnectionForm(show, connection = null) {
    const form = document.getElementById('configForm');
    form.style.display = show ? 'flex' : 'none';
    if (show) {
        clearCredentialInputs();
        const deployment = document.getElementById('deploymentType');
        if (connection) {
            editingSavedConnectionId = connection.id;
            deployment.value = connection.type;
            deployment.disabled = true;
            document.getElementById('connectionFormTitle').textContent = `Edit ${connection.label}`;
            document.getElementById('connectBtn').textContent = 'Connect and save changes';
            document.getElementById('tenantName').value = connection.tenant || '';
            document.getElementById('enterpriseHost').value = connection.host || '';
            document.getElementById('enterpriseAllowUntrustedTls').checked = connection.verifyTls === false;
            setConnectionEditHints(true);
        } else {
            resetConnectionFormMode();
            document.getElementById('tenantName').value = '';
            document.getElementById('enterpriseHost').value = '';
            document.getElementById('enterpriseAllowUntrustedTls').checked = false;
        }
        setDeploymentForm(deployment.value);
        window.refreshCustomSelect?.(deployment);
        const firstInput = deployment.value === '360'
            ? document.getElementById('tenantName')
            : document.getElementById('enterpriseHost');
        firstInput.focus();
    } else {
        clearCredentialInputs();
        resetConnectionFormMode();
    }
}

function editSavedConnection(connectionId) {
    const connection = savedConnectionCatalog.find(item => (
        item.id === connectionId && item.editable === true
    ));
    if (!connection) {
        showStatus('This connection is managed outside the app and cannot be edited here.', true);
        return;
    }
    showNewConnectionForm(true, connection);
}

async function deleteSavedConnection(connectionId, label) {
    const connection = savedConnectionCatalog.find(item => (
        item.id === connectionId && item.editable === true
    ));
    if (!connection) {
        showStatus('This connection is managed outside the app and cannot be removed here.', true);
        return;
    }
    if (!confirm(`Remove the saved connection "${label || connection.label}"?`)) return;

    try {
        await ExtraHopAPI.deleteSavedConnection(connectionId);
        if (editingSavedConnectionId === connectionId) showNewConnectionForm(false);
        await loadSavedConnections();
        showStatus(`Removed saved connection "${label || connection.label}".`, false);
    } catch (error) {
        showStatus('✖ ' + error.message, true);
        showConnectionError(error);
    }
}

function completeConnection(api) {
    state.apiConfig = api.config;
    state.connected = true;
    sessionStorage.setItem('eh_config', JSON.stringify(api.config));
    if (api.savedConnection === false && api.connectionStorage?.message) {
        sessionStorage.setItem('eh_connection_save_warning', api.connectionStorage.message);
    } else {
        sessionStorage.removeItem('eh_connection_save_warning');
    }
    window.apiClient = api;
    clearCredentialInputs();

    // A new connection may target a different ExtraHop environment. Reload
    // before rendering so no module can reuse data, reports, or in-flight work.
    clearEnvironmentBoundContent();
}

async function handleSavedConnect() {
    const connectBtn = document.getElementById('connectSavedBtn');
    const connectionId = document.getElementById('savedConnectionSelect').value;
    if (!connectionId) return;

    try {
        connectBtn.disabled = true;
        connectBtn.textContent = 'Connecting...';
        const config = { connectionId };
        const proxyToken = document.getElementById('savedEnterpriseProxyToken')?.value.trim();
        if (selectedSavedConnection()?.type === 'enterprise' && proxyToken) {
            config.proxyToken = proxyToken;
        }
        const api = new ExtraHopAPI(config);
        await api.authenticate();
        completeConnection(api);
    } catch (error) {
        showStatus('✖ ' + error.message, true);
        showConnectionError(error);
        connectBtn.textContent = 'Connect';
        connectBtn.disabled = false;
    }
}

async function handleConnect() {
    const connectBtn = document.getElementById('connectBtn');
    const deploymentType = document.getElementById('deploymentType').value;
    const editing = Boolean(editingSavedConnectionId);

    try {
        connectBtn.disabled = true;
        connectBtn.textContent = 'Connecting...';

        let config;
        if (deploymentType === '360') {
            const tenant = document.getElementById('tenantName').value.trim();
            const apiId = document.getElementById('apiId').value.trim();
            const apiSecret = document.getElementById('apiSecret').value.trim();
            config = editing
                ? { connectionId: editingSavedConnectionId, updates: { tenant } }
                : { type: '360', tenant, apiId, apiSecret };
            if (editing && apiId) config.updates.apiId = apiId;
            if (editing && apiSecret) config.updates.apiSecret = apiSecret;

            if (!tenant || (!editing && (!apiId || !apiSecret))) {
                throw new Error('Please fill in all fields');
            }
        } else {
            const proxyToken = document.getElementById('enterpriseProxyToken')?.value.trim();
            const host = document.getElementById('enterpriseHost').value.trim();
            const apiKey = document.getElementById('enterpriseApiKey').value.trim();
            const verifyTls = !document.getElementById('enterpriseAllowUntrustedTls').checked;
            config = editing
                ? {
                    connectionId: editingSavedConnectionId,
                    updates: { host, verifyTls }
                }
                : { type: 'enterprise', host, apiKey, verifyTls };
            if (editing && apiKey) config.updates.apiKey = apiKey;

            if (proxyToken) {
                config.proxyToken = proxyToken;
            }

            if (!host || (!editing && !apiKey)) {
                throw new Error('Please fill in all fields');
            }
        }

        const api = new ExtraHopAPI(config);
        await api.authenticate();

        completeConnection(api);
        return;

    } catch (error) {
        showStatus('✖ ' + error.message, true);
        showConnectionError(error);
        connectBtn.textContent = editing ? 'Connect and save changes' : 'Connect and save';
        connectBtn.disabled = false;
    }
}

async function handleDisconnect() {
    const disconnectBtn = document.getElementById('disconnectBtn');
    disconnectBtn.disabled = true;
    disconnectBtn.textContent = 'Disconnecting...';

    try {
        if (window.apiClient && typeof window.apiClient.dispose === 'function') {
            await window.apiClient.dispose();
        }
    } finally {
        state.apiConfig = null;
        state.connected = false;
        state.runtimeContext = 'offline';
        window.apiClient = null;
        sessionStorage.removeItem('eh_config');
        clearCredentialInputs();
        showOfflineState({ preserveSupportedModule: true });
        if (
            state.currentModule
            && deploymentSupportsModule('offline', state.currentModule)
            && featureRegistry.has(state.currentModule)
        ) {
            await featureRegistry.activate(state.currentModule, { runtimeContext: 'offline' });
        }
        showStatus('Disconnected from ExtraHop. Local tools remain available.', false);
        disconnectBtn.disabled = false;
        disconnectBtn.textContent = 'Disconnect';
    }
}

function clearCredentialInputs() {
    [
        'apiId',
        'apiSecret',
        'enterpriseApiKey',
        'enterpriseProxyToken',
        'savedEnterpriseProxyToken'
    ].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.value = '';
    });
}

function showConnectionError(error) {
    const details = error.details || {};
    showErrorModal(error.message || 'Connection failed', {
        url: details.url || '/backend/session',
        headers: details.headers || { 'Content-Type': 'application/json' },
        body: 'Credentials omitted',
        status: details.status || (error.status ? String(error.status) : 'Connection Error'),
        response: details.response || error.message || 'No additional response details'
    });
}
