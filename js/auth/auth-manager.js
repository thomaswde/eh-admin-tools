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

        state.apiConfig = api.config;
        state.connected = true;
        sessionStorage.setItem('eh_config', JSON.stringify(api.config));
        window.apiClient = api;
        clearCredentialInputs();

        showStatus('✓ Connected successfully', false);
        document.getElementById('moduleSelection').style.display = 'block';
        showConnectedState();
        await openConnectedAppliances();
        
        connectBtn.textContent = 'Connected';
        setTimeout(() => {
            connectBtn.textContent = 'Reconnect';
            connectBtn.disabled = false;
        }, 2000);

    } catch (error) {
        showStatus('✖ ' + error.message, true);
        showConnectionError(error);
        connectBtn.textContent = 'Connect';
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
