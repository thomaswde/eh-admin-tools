// Main Application Initialization

// Global API client variable
window.apiClient = null;

// Initialize the application when DOM is loaded
window.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

async function initializeApp() {
    console.log('Initializing ExtraHop API Tools...');
    
    // Load saved config on page load
    loadSavedConfig();
    
    // Set up global event listeners
    setupGlobalEventListeners();
    
    console.log('Application initialized successfully');
}

function loadSavedConfig() {
    const savedConfig = sessionStorage.getItem('eh_config');
    if (savedConfig) {
        const config = JSON.parse(savedConfig);
        if (config.type === '360') {
            document.getElementById('deploymentType').value = '360';
            document.getElementById('tenantName').value = config.tenant;
            document.getElementById('apiId').value = config.apiId;
            document.getElementById('apiSecret').value = config.apiSecret;
            // Restore proxy checkbox state (default to true if not set)
            document.getElementById('useAwsProxy').checked = config.useProxy !== false;
        } else {
            document.getElementById('deploymentType').value = 'enterprise';
            document.getElementById('enterpriseHost').value = config.host;
            document.getElementById('enterpriseApiKey').value = config.apiKey;
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

    // Module buttons - with dynamic loading
    document.querySelectorAll('.module-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const moduleName = e.currentTarget.dataset.module;
            if (state.connected) {
                await moduleLoader.switchToModule(moduleName);
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
}