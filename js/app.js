// Main Application Initialization

// Global API client variable
window.apiClient = null;

// Initialize the application when DOM is loaded
window.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

async function initializeApp() {
    console.log('Initializing ExtraHop Admin Tools...');
    
    // Load saved config on page load
    loadSavedConfig();

    // Restore a still-valid backend session after a frontend reload
    await restoreBackendSession();
    
    // Set up global event listeners
    setupGlobalEventListeners();

    // Restore diagnostic logging preference
    await loadApiLoggingStatus();
    
    // Set last modified timestamp in the ribbon
    setLastModifiedTimestamp();
    
    console.log('Application initialized successfully');
}

async function restoreBackendSession() {
    try {
        const config = await ExtraHopAPI.currentSession();
        if (!config) return;

        const api = new ExtraHopAPI(config);
        state.apiConfig = config;
        state.connected = true;
        sessionStorage.setItem('eh_config', JSON.stringify(config));
        window.apiClient = api;

        document.getElementById('moduleSelection').style.display = 'block';
        showConnectedState();
        showStatus('✓ Reconnected to existing session', false);
    } catch (error) {
        console.warn('No existing backend session to restore:', error);
    }
}

function setLastModifiedTimestamp() {
    const el = document.getElementById('lastModified');
    if (!el) return;

    const modified = new Date(document.lastModified);
    if (isNaN(modified.getTime())) {
        el.textContent = '';
        return;
    }

    el.textContent = `Last updated: ${modified.toLocaleString()}`;
}

function loadSavedConfig() {
    const savedConfig = sessionStorage.getItem('eh_config');
    if (savedConfig) {
        const config = JSON.parse(savedConfig);
        if (config.type === '360') {
            document.getElementById('deploymentType').value = '360';
            document.getElementById('tenantName').value = config.tenant || '';
        } else {
            document.getElementById('deploymentType').value = 'enterprise';
            document.getElementById('enterpriseHost').value = config.host || '';
            document.getElementById('config360').style.display = 'none';
            document.getElementById('configEnterprise').style.display = 'block';
        }
    }
}

function setupGlobalEventListeners() {
    // Deployment type change
    document.getElementById('deploymentType').addEventListener('change', (e) => {
        const is360 = e.target.value === '360';
        document.getElementById('config360').style.display = is360 ? 'block' : 'none';
        document.getElementById('configEnterprise').style.display = is360 ? 'none' : 'block';
    });

    // Connect button
    document.getElementById('connectBtn').addEventListener('click', handleConnect);

    const apiLoggingVerbosity = document.getElementById('apiLoggingVerbosity');
    if (apiLoggingVerbosity) {
        apiLoggingVerbosity.addEventListener('change', handleApiLoggingChange);
    }

    window.addEventListener('beforeunload', () => {
        if (window.apiClient && typeof window.apiClient.dispose === 'function') {
            window.apiClient.dispose();
        }
    });

    // Module buttons - with dynamic loading
    document.querySelectorAll('.module-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const moduleName = e.currentTarget.dataset.module;
            if (!state.connected) {
                showStatus('Connect to an ExtraHop deployment before opening tools.', true);
                return;
            }

            const switched = await moduleLoader.switchToModule(moduleName);
            if (!switched) {
                showStatus(`Could not open ${moduleName}. Check the browser console for details.`, true);
            }
        });
    });

    // Close modals on outside click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('show');
            }
        });
    });

    // Error modal controls
    document.getElementById('closeErrorModal').addEventListener('click', () => hideModal('errorModal'));
    document.getElementById('toggleErrorDetails').addEventListener('click', function() {
        const detailsDiv = document.getElementById('errorDetails');
        if (detailsDiv.style.display === 'none') {
            detailsDiv.style.display = 'block';
            this.textContent = 'Hide Technical Details';
        } else {
            detailsDiv.style.display = 'none';
            this.textContent = 'Show Technical Details';
        }
    });

    // Other Tools toggle
    const otherToolsToggle = document.getElementById('otherToolsToggle');
    const otherToolsContainer = document.getElementById('otherToolsContainer');
    const otherToolsCaret = document.getElementById('otherToolsCaret');

    if (otherToolsToggle && otherToolsContainer && otherToolsCaret) {
        otherToolsToggle.addEventListener('click', () => {
            const isHidden = otherToolsContainer.style.display === 'none' || otherToolsContainer.style.display === '';
            otherToolsContainer.style.display = isHidden ? 'block' : 'none';
            otherToolsCaret.style.transform = isHidden ? 'rotate(90deg)' : 'rotate(0deg)';
        });
    }

    // Other Tools external links
    const productCatalogBtn = document.getElementById('productCatalogBtn');
    if (productCatalogBtn) {
        productCatalogBtn.addEventListener('click', () => {
            window.open('https://thomaswde.github.io/eh-lookup/', '_blank');
        });
    }

    const restApiGuideBtn = document.getElementById('restApiGuideBtn');
    if (restApiGuideBtn) {
        restApiGuideBtn.addEventListener('click', () => {
            let url = 'https://docs.extrahop.com/current/rest-api-guide/';
            if (window.state && window.state.apiConfig && window.state.apiConfig.type === '360') {
                url = 'https://docs.extrahop.com/current/rx360-rest-api/';
            }
            window.open(url, '_blank');
        });
    }
}

async function loadApiLoggingStatus() {
    const statusEl = document.getElementById('apiLoggingStatus');
    const selectEl = document.getElementById('apiLoggingVerbosity');
    if (!statusEl || !selectEl) return;

    try {
        const config = await ExtraHopAPI.getApiLogging();
        renderApiLoggingStatus(config);
    } catch (error) {
        statusEl.textContent = `Logging status unavailable: ${error.message}`;
        statusEl.style.color = '#ef4444';
    }
}

async function handleApiLoggingChange(event) {
    const selectEl = event.currentTarget;
    const previousValue = selectEl.dataset.currentValue || 'off';
    selectEl.disabled = true;

    try {
        const config = await ExtraHopAPI.updateApiLogging(selectEl.value);
        renderApiLoggingStatus(config);
        showStatus(`API logging set to ${config.verbosity}`, false);
    } catch (error) {
        selectEl.value = previousValue;
        const statusEl = document.getElementById('apiLoggingStatus');
        if (statusEl) {
            statusEl.textContent = `Could not update logging: ${error.message}`;
            statusEl.style.color = '#ef4444';
        }
    } finally {
        selectEl.disabled = false;
    }
}

function renderApiLoggingStatus(config) {
    const statusEl = document.getElementById('apiLoggingStatus');
    const selectEl = document.getElementById('apiLoggingVerbosity');
    if (!statusEl || !selectEl || !config) return;

    selectEl.value = config.verbosity || 'off';
    selectEl.dataset.currentValue = selectEl.value;
    statusEl.textContent = config.enabled
        ? `Writing ${config.verbosity} responses to ${config.path}`
        : `Log file: ${config.path}`;
    statusEl.style.color = 'var(--text-muted)';
}
