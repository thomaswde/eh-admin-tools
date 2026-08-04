// Main Application Initialization

// Global API client variable
window.apiClient = null;

// Initialize the application when DOM is loaded
window.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

async function initializeApp() {
    console.log('Initializing ExtraHop Admin Tools...');

    initTheme();

    // Load saved config on page load
    loadSavedConfig();

    // Start loading .env and OS-credential entries without delaying restoration
    // of an existing browser session.
    const savedConnectionsPromise = loadSavedConnections();

    // Restore a still-valid backend session after a frontend reload
    await restoreBackendSession();
    await savedConnectionsPromise;
    
    // Set up global event listeners
    setupGlobalEventListeners();

    // Restore diagnostic logging preference
    await loadApiLoggingStatus();
    
    // Set the build version in the ribbon
    await setBuildVersion();
    
    console.log('Application initialized successfully');
}

async function restoreBackendSession() {
    try {
        const session = await ExtraHopAPI.currentSession();
        const config = session?.connected ? session.config : null;
        if (!config) {
            state.connected = false;
            state.apiConfig = null;
            state.runtimeContext = 'offline';
            window.apiClient = null;
            showOfflineState();
            return;
        }

        const api = new ExtraHopAPI(config);
        state.apiConfig = config;
        state.connected = true;
        state.runtimeContext = config.type;
        sessionStorage.setItem('eh_config', JSON.stringify(config));
        window.apiClient = api;

        syncSavedConnectionSelection();
        showConnectedState();
        await openConnectedAppliances();
        const saveWarning = sessionStorage.getItem('eh_connection_save_warning');
        if (saveWarning) {
            sessionStorage.removeItem('eh_connection_save_warning');
            showStatus(saveWarning, true);
        }
    } catch (error) {
        console.warn('Could not establish the local workspace:', error);
    }
}

async function setBuildVersion() {
    const el = document.getElementById('buildVersion');
    const dirtyTag = document.getElementById('buildDirtyTag');
    if (!el || !dirtyTag) return;

    try {
        const response = await fetch('/backend/health', { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`Health request failed with HTTP ${response.status}`);
        }
        const build = await response.json();
        const version = String(build.version || '').replace(/^\d{2}(\d{2})\.(\d{2})\.(\d{2})$/, '$1.$2.$3');
        const commit = String(build.commit || 'unknown');
        el.textContent = `${version} - ${commit}`;
        dirtyTag.classList.toggle('hidden', build.dirty !== true);
    } catch (error) {
        el.textContent = '';
        dirtyTag.classList.add('hidden');
        console.warn('Unable to load build version:', error);
    }
}

function loadSavedConfig() {
    const savedConfig = sessionStorage.getItem('eh_config');
    if (!savedConfig) return;

    try {
        const config = JSON.parse(savedConfig);
        if (!config || !['360', 'enterprise'].includes(config.type)) {
            throw new Error('Unsupported saved connection type');
        }
        if (config.type === '360') {
            document.getElementById('deploymentType').value = '360';
            document.getElementById('tenantName').value = config.tenant || '';
        } else {
            document.getElementById('deploymentType').value = 'enterprise';
            document.getElementById('enterpriseHost').value = config.host || '';
            document.getElementById('enterpriseAllowUntrustedTls').checked = config.verifyTls === false;
            document.getElementById('config360').style.display = 'none';
            document.getElementById('configEnterprise').style.display = 'flex';
        }
        window.refreshCustomSelect?.(document.getElementById('deploymentType'));
    } catch (error) {
        console.warn('Discarding invalid saved connection metadata:', error);
        sessionStorage.removeItem('eh_config');
    }
}

function setupGlobalEventListeners() {
    setupConnectionPanel();
    setupApiLoggingPanel();

    // Deployment type change
    document.getElementById('deploymentType').addEventListener('change', (e) => {
        setDeploymentForm(e.target.value);
    });

    // Connect button
    document.getElementById('connectBtn').addEventListener('click', handleConnect);
    document.getElementById('connectSavedBtn').addEventListener('click', handleSavedConnect);
    document.getElementById('savedConnectionSelect').addEventListener('change', event => {
        document.getElementById('connectSavedBtn').disabled = !event.target.value;
        syncSavedEnterpriseProxyTokenVisibility();
    });
    document.getElementById('savedConnectionSelect').addEventListener('custom-select-action', event => {
        if (event.detail?.action === 'edit') {
            editSavedConnection(event.detail.value);
        } else if (event.detail?.action === 'delete') {
            deleteSavedConnection(event.detail.value, event.detail.label);
        }
    });
    document.getElementById('addConnectionBtn').addEventListener('click', () => {
        showNewConnectionForm(true);
    });
    document.getElementById('cancelAddConnectionBtn').addEventListener('click', () => {
        showNewConnectionForm(false);
    });
    document.getElementById('recheckSecureStorageBtn').addEventListener(
        'click',
        recheckSecureStorage
    );
    document.getElementById('disconnectBtn').addEventListener('click', handleDisconnect);

    const apiLoggingVerbosity = document.getElementById('apiLoggingVerbosity');
    if (apiLoggingVerbosity) {
        apiLoggingVerbosity.addEventListener('change', handleApiLoggingChange);
    }

    // Module buttons - with dynamic loading
    document.querySelectorAll('.module-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const moduleName = e.currentTarget.dataset.module;
            const runtimeContext = runtimeContextForState(state);
            if (!deploymentSupportsModule(runtimeContext, moduleName)) {
                showStatus(moduleCapabilityReason(runtimeContext, moduleName), true);
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

    // Reference links
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

// The connection form lives in a popover anchored to the header chip.
function setupConnectionPanel() {
    const chip = document.getElementById('apiConfigToggle');
    const panel = document.getElementById('connPanel');

    chip.addEventListener('click', (event) => {
        event.stopPropagation();
        setApiLoggingPanelOpen(false);
        toggleApiConfig();
    });

    // Clicks inside the panel must not close it.
    panel.addEventListener('click', (event) => event.stopPropagation());

    document.addEventListener('click', () => setConnectionPanelOpen(false));

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setConnectionPanelOpen(false);
    });

    document.getElementById('welcomeConnectBtn').addEventListener('click', (event) => {
        event.stopPropagation();
        setConnectionPanelOpen(true);
        const savedSelect = document.getElementById('savedConnectionSelect');
        if (!savedSelect.disabled) {
            savedSelect.focus();
        } else {
            document.getElementById('addConnectionBtn').focus();
        }
    });
}

function setApiLoggingPanelOpen(open) {
    const toggle = document.getElementById('apiLoggingToggle');
    const panel = document.getElementById('apiLoggingPanel');
    if (!toggle || !panel) return;

    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
}

function setupApiLoggingPanel() {
    const toggle = document.getElementById('apiLoggingToggle');
    const panel = document.getElementById('apiLoggingPanel');
    const close = document.getElementById('apiLoggingClose');
    if (!toggle || !panel || !close) return;

    toggle.addEventListener('click', event => {
        event.stopPropagation();
        setConnectionPanelOpen(false);
        setApiLoggingPanelOpen(panel.hidden);
    });
    panel.addEventListener('click', event => event.stopPropagation());
    close.addEventListener('click', () => {
        setApiLoggingPanelOpen(false);
        toggle.focus();
    });
    document.addEventListener('click', () => setApiLoggingPanelOpen(false));
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !panel.hidden) {
            setApiLoggingPanelOpen(false);
            toggle.focus();
        }
    });
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
        statusEl.style.color = 'var(--danger-text)';
    }
}

async function handleApiLoggingChange(event) {
    const selectEl = event.currentTarget;
    const previousValue = selectEl.dataset.currentValue || 'off';
    selectEl.disabled = true;

    try {
        const config = await ExtraHopAPI.updateApiLogging(selectEl.value);
        renderApiLoggingStatus(config);
    } catch (error) {
        selectEl.value = previousValue;
        window.refreshCustomSelect?.(selectEl);
        const statusEl = document.getElementById('apiLoggingStatus');
        if (statusEl) {
            statusEl.textContent = `Could not update logging: ${error.message}`;
            statusEl.style.color = 'var(--danger-text)';
        }
    } finally {
        selectEl.disabled = false;
    }
}

function renderApiLoggingStatus(config) {
    const statusEl = document.getElementById('apiLoggingStatus');
    const selectEl = document.getElementById('apiLoggingVerbosity');
    const summaryEl = document.getElementById('apiLoggingSummary');
    if (!statusEl || !selectEl || !config) return;

    selectEl.value = config.verbosity || 'off';
    selectEl.dataset.currentValue = selectEl.value;
    window.refreshCustomSelect?.(selectEl);
    if (summaryEl) {
        summaryEl.textContent = {
            off: 'Off',
            errors: 'Errors only',
            metadata: 'Metadata',
            full: 'Full responses'
        }[selectEl.value] || selectEl.value;
    }
    statusEl.textContent = config.enabled
        ? `Writing ${config.verbosity} responses to ${config.path}`
        : `Log file: ${config.path}`;
    statusEl.style.color = 'var(--text-muted)';
}
