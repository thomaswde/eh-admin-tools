async function refreshAccessToken() {
    if (!window.apiClient || !state.apiConfig || state.apiConfig.type !== '360') {
        return false;
    }

    try {
        return await window.apiClient.refreshAccessToken();
    } catch (error) {
        console.error('Failed to refresh access token:', error);
        return false;
    }
}

// Wrapper for API requests that handles token refresh
async function apiRequestWithRetry(apiMethod, ...args) {
    try {
        return await apiMethod(...args);
    } catch (error) {
        // Check if it's a 401 error (expired token)
        if (error.message.includes('401') && state.apiConfig?.type === '360') {
            console.log('Detected 401, attempting token refresh...');
            const refreshed = await refreshAccessToken();
            
            if (refreshed) {
                // Retry the original request
                return await apiMethod(...args);
            }
        }
        // Re-throw if not a token issue or refresh failed
        throw error;
    }
}

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

async function loadSavedConnections() {
    const select = document.getElementById('savedConnectionSelect');
    const connectBtn = document.getElementById('connectSavedBtn');
    const status = document.getElementById('savedConnectionStatus');
    if (!select || !connectBtn || !status) return;

    select.disabled = true;
    connectBtn.disabled = true;
    status.textContent = 'Checking the local .env file and secure credential store.';

    try {
        const catalog = await ExtraHopAPI.listSavedConnections();
        const connections = Array.isArray(catalog.connections) ? catalog.connections : [];
        select.replaceChildren();

        if (connections.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No saved connections';
            select.appendChild(option);
        } else {
            for (const group of groupSavedConnections(connections)) {
                const parent = group.label
                    ? Object.assign(document.createElement('optgroup'), { label: group.label })
                    : select;
                for (const connection of group.connections) {
                    const option = document.createElement('option');
                    option.value = connection.id;
                    option.textContent = connection.label;
                    option.dataset.deploymentType = connection.type;
                    parent.appendChild(option);
                }
                if (group.label) select.appendChild(parent);
            }
        }

        select.disabled = connections.length === 0;
        connectBtn.disabled = connections.length === 0;

        const sourceParts = [];
        if (catalog.env?.connectionCount) {
            sourceParts.push(`${catalog.env.connectionCount} from .env`);
        }
        if (catalog.secureStorage?.connectionCount) {
            sourceParts.push(`${catalog.secureStorage.connectionCount} from secure storage`);
        }
        const warnings = [...new Set(
            (Array.isArray(catalog.warnings) ? catalog.warnings : [])
                .filter(message => typeof message === 'string' && message)
        )];
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
        select.replaceChildren();
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Saved connections unavailable';
        select.appendChild(option);
        status.textContent = error.message;
    }
}

function showNewConnectionForm(show) {
    const form = document.getElementById('configForm');
    form.style.display = show ? 'flex' : 'none';
    if (show) {
        document.getElementById('deploymentType').focus();
    } else {
        clearCredentialInputs();
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
        const api = new ExtraHopAPI({ connectionId });
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

    try {
        connectBtn.disabled = true;
        connectBtn.textContent = 'Connecting...';

        let config;
        if (deploymentType === '360') {
            config = {
                type: '360',
                tenant: document.getElementById('tenantName').value.trim(),
                apiId: document.getElementById('apiId').value.trim(),
                apiSecret: document.getElementById('apiSecret').value.trim()
            };

            if (!config.tenant || !config.apiId || !config.apiSecret) {
                throw new Error('Please fill in all fields');
            }
        } else {
            const proxyToken = document.getElementById('enterpriseProxyToken')?.value.trim();
            config = {
                type: 'enterprise',
                host: document.getElementById('enterpriseHost').value.trim(),
                apiKey: document.getElementById('enterpriseApiKey').value.trim(),
                verifyTls: !document.getElementById('enterpriseAllowUntrustedTls').checked
            };

            if (proxyToken) {
                config.proxyToken = proxyToken;
            }

            if (!config.host || !config.apiKey) {
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
        connectBtn.textContent = 'Connect and save';
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
        state.currentModule = null;
        window.apiClient = null;
        sessionStorage.removeItem('eh_config');
        clearCredentialInputs();
        hideConnectedState();
        document.getElementById('moduleSelection').style.display = 'none';
        document.querySelectorAll('.module-content').forEach(module => {
            module.style.display = 'none';
        });
        document.getElementById('welcomeScreen').style.display = 'block';
        showStatus('Disconnected from ExtraHop', false);
        disconnectBtn.disabled = false;
        disconnectBtn.textContent = 'Disconnect';
    }
}

function clearCredentialInputs() {
    ['apiId', 'apiSecret', 'enterpriseApiKey', 'enterpriseProxyToken'].forEach(id => {
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
