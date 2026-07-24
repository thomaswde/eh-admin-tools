// Shared utility functions

function showStatus(message, isError = false) {
    const statusDiv = document.getElementById('connectionStatus');
    const statusText = document.getElementById('statusText');
    const notice = statusDiv.querySelector('.notice');

    statusDiv.style.display = 'block';
    statusText.textContent = message;
    notice.classList.toggle('notice-danger', isError);
    notice.classList.toggle('notice-ok', !isError);

    // Status lives inside the connection popover, so an error is only useful
    // if the popover is open.
    if (isError) setConnectionPanelOpen(true);
}

function toggleApiConfig() {
    setConnectionPanelOpen(document.getElementById('connPanel').hidden);
}

function setConnectionPanelOpen(open) {
    document.getElementById('connPanel').hidden = !open;
    document.getElementById('apiConfigToggle').setAttribute('aria-expanded', String(open));
}

function showConnectedState() {
    const chip = document.getElementById('apiConfigToggle');
    const is360 = state.apiConfig.type === '360';

    document.getElementById('connectedState').classList.remove('hidden');
    document.getElementById('configForm').style.display = 'none';
    document.getElementById('moduleSelection').style.display = 'block';

    document.getElementById('connectedInfo').textContent = is360
        ? `${state.apiConfig.tenant}.api.cloud.extrahop.com`
        : state.apiConfig.host;

    chip.classList.add('is-connected');
    document.getElementById('connChipLabel').textContent = is360 ? state.apiConfig.tenant : state.apiConfig.host;
    document.getElementById('connChipMeta').textContent = is360 ? 'RevealX 360' : 'Enterprise';

    setConnectionPanelOpen(false);
}

function hideConnectedState() {
    const chip = document.getElementById('apiConfigToggle');

    document.getElementById('connectedState').classList.add('hidden');
    document.getElementById('configForm').style.display = 'block';
    document.getElementById('moduleSelection').style.display = 'none';

    chip.classList.remove('is-connected');
    document.getElementById('connChipLabel').textContent = 'Not connected';
    document.getElementById('connChipMeta').textContent = '';

    setConnectionPanelOpen(true);
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
    document.getElementById('toggleErrorDetails').textContent = 'Show technical details';
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

// A labelled read-only value, used inside .detail-panel blocks.
function detailItem(label, value) {
    return `<div><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value">${escapeHtml(value)}</span></div>`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

function escapeAttribute(text) {
    return escapeHtml(text)
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
