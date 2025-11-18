// Shared utility functions

function showStatus(message, isError = false) {
    const statusDiv = document.getElementById('connectionStatus');
    const statusText = document.getElementById('statusText');
    statusDiv.style.display = 'block';
    statusText.textContent = message;
    statusText.style.color = isError ? '#ef4444' : 'var(--cyan)';
}

function toggleApiConfig() {
    const configForm = document.getElementById('configForm');
    const expandIcon = document.getElementById('expandIcon');
    
    if (configForm.style.display === 'none') {
        configForm.style.display = 'block';
        expandIcon.style.transform = 'rotate(0deg)';
    } else {
        configForm.style.display = 'none';
        expandIcon.style.transform = 'rotate(-90deg)';
    }
}

function showConnectedState() {
    const connectedState = document.getElementById('connectedState');
    const configForm = document.getElementById('configForm');
    const connectedInfo = document.getElementById('connectedInfo');
    
    connectedState.classList.remove('hidden');
    configForm.style.display = 'none';
    
    if (state.apiConfig.type === '360') {
        connectedInfo.textContent = `RevealX 360: ${state.apiConfig.tenant}`;
    } else {
        connectedInfo.textContent = `RevealX Enterprise: ${state.apiConfig.host}`;
    }
    
    document.getElementById('expandIcon').style.transform = 'rotate(-90deg)';
}

function hideConnectedState() {
    const connectedState = document.getElementById('connectedState');
    const configForm = document.getElementById('configForm');
    
    connectedState.classList.add('hidden');
    configForm.style.display = 'block';
}

function showErrorModal(message, details) {
    document.getElementById('errorMessage').textContent = message;
    document.getElementById('errorUrl').textContent = details.url || 'N/A';
    document.getElementById('errorHeaders').textContent = JSON.stringify(details.headers || {}, null, 2);
    document.getElementById('errorBody').textContent = details.body || 'N/A';
    document.getElementById('errorStatus').textContent = details.status || 'N/A';
    document.getElementById('errorResponse').textContent = typeof details.response === 'object' 
        ? JSON.stringify(details.response, null, 2) 
        : details.response || 'N/A';
    
    document.getElementById('errorDetails').style.display = 'none';
    document.getElementById('toggleErrorDetails').textContent = 'Show Technical Details';
    showModal('errorModal');
}

function switchModule(moduleName) {
    // Update sidebar
    document.querySelectorAll('.module-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-module="${moduleName}"]`)?.classList.add('active');

    // Update content
    document.querySelectorAll('.module-content').forEach(module => {
        module.style.display = 'none';
    });
    document.getElementById('welcomeScreen').style.display = 'none';
    document.getElementById(`${moduleName}Module`).style.display = 'block';

    // Update ribbon module title
    const moduleTitles = {
        'dashboards': 'Dashboard Manager',
        'audit-logs': 'Audit Log Analyzer',
        'detections': 'Detections',
        'devices': 'Device Manager',
        'analysis-priorities': 'Analysis Priorities',
        'localities': 'Network Localities Manager',
        'nodemap': 'Appliance Node Map'
    };
    document.getElementById('ribbonModuleTitle').textContent = moduleTitles[moduleName] || '';

    state.currentModule = moduleName;

    // Call module-specific activation function if it exists
    const camelCaseName = moduleName.split('-').map((part, index) => 
        index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : 
                     part.charAt(0).toUpperCase() + part.slice(1)
    ).join('');
    const activationFunctionName = `activate${camelCaseName}Module`;
    
    if (typeof window[activationFunctionName] === 'function') {
        try {
            window[activationFunctionName]();
        } catch (error) {
            console.error(`Error activating module '${moduleName}':`, error);
        }
    }
}

function showModal(modalId) {
    document.getElementById(modalId).classList.add('show');
}

function hideModal(modalId) {
    document.getElementById(modalId).classList.remove('show');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}