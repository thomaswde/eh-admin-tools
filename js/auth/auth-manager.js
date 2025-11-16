async function refreshAccessToken() {
    if (!state.apiConfig || state.apiConfig.type !== '360') {
        return false;
    }

    console.log('Access token expired, refreshing...');
    
    try {
        const api = new ExtraHopAPI(state.apiConfig);
        await api.authenticate();
        
        // Update the global API client with new token
        window.apiClient.accessToken = api.accessToken;
        
        console.log('Access token refreshed successfully');
        return true;
    } catch (error) {
        console.error('Failed to refresh access token:', error);
        // Show error and ask user to reconnect
        alert('Your session has expired. Please reconnect.');
        hideConnectedState();
        state.connected = false;
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
            const useProxy = document.getElementById('useAwsProxy').checked;
            config = {
                type: '360',
                tenant: document.getElementById('tenantName').value.trim(),
                apiId: document.getElementById('apiId').value.trim(),
                apiSecret: document.getElementById('apiSecret').value.trim(),
                useProxy: useProxy
            };

            if (!config.tenant || !config.apiId || !config.apiSecret) {
                throw new Error('Please fill in all fields');
            }
        } else {
            config = {
                type: 'enterprise',
                host: document.getElementById('enterpriseHost').value.trim(),
                apiKey: document.getElementById('enterpriseApiKey').value.trim()
            };

            if (!config.host || !config.apiKey) {
                throw new Error('Please fill in all fields');
            }
        }

        const api = new ExtraHopAPI(config);
        await api.authenticate();

        state.apiConfig = config;
        state.connected = true;
        sessionStorage.setItem('eh_config', JSON.stringify(config));
        window.apiClient = api;

        showStatus('✓ Connected successfully', false);
        document.getElementById('moduleSelection').style.display = 'block';
        showConnectedState();
        
        connectBtn.textContent = 'Connected';
        setTimeout(() => {
            connectBtn.textContent = 'Reconnect';
            connectBtn.disabled = false;
        }, 2000);

    } catch (error) {
        showStatus('✖ ' + error.message, true);
        connectBtn.textContent = 'Connect';
        connectBtn.disabled = false;
    }
}