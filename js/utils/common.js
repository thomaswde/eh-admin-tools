/* exported showStatus, toggleApiConfig, showConnectedState, showOfflineState, hideConnectedState, showErrorModal,
switchModule, openConnectedAppliances, hideModal, detailItem, escapeAttribute,
genericChartPrimaryColor, genericChartPaletteColor, stateIndicatorColor */
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

    state.runtimeContext = state.apiConfig.type;
    syncDeploymentCapabilityNavigation(state.runtimeContext);

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

function showOfflineState({ preserveSupportedModule = false, openConnectionPanel = false } = {}) {
    const chip = document.getElementById('apiConfigToggle');

    state.runtimeContext = 'offline';
    syncDeploymentCapabilityNavigation('offline');
    document.getElementById('connectedState').classList.add('hidden');
    document.getElementById('configForm').style.display = 'none';
    document.getElementById('moduleSelection').style.display = 'block';

    chip.classList.remove('is-connected');
    document.getElementById('connChipLabel').textContent = 'Local workspace';
    document.getElementById('connChipMeta').textContent = 'Offline';

    const currentModuleSupported = preserveSupportedModule
        && state.currentModule
        && deploymentSupportsModule('offline', state.currentModule);
    if (!currentModuleSupported) {
        state.currentModule = null;
        document.querySelectorAll('.module-btn').forEach(button => button.classList.remove('active'));
        document.querySelectorAll('.module-content').forEach(module => {
            module.style.display = 'none';
        });
        document.getElementById('welcomeScreen').style.display = 'block';
    }

    setConnectionPanelOpen(openConnectionPanel);
}

function hideConnectedState() {
    showOfflineState({ preserveSupportedModule: false, openConnectionPanel: true });
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
}

async function openConnectedAppliances() {
    const switched = await moduleLoader.switchToModule('nodemap');
    if (!switched) {
        console.error('Connected successfully, but the Connected Appliances view could not be opened.');
    }
    return switched;
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

/* --------------------------- shared color system --------------------------- */

const GENERIC_CHART_COLOR_FALLBACKS = [
    '#72aed9',
    '#5e55d7',
    '#bb5fd8',
    '#d0638d',
    '#d28861',
    '#d4dd73',
    '#8fdb6f',
    '#86dba9'
];

function appCssColor(token, fallback) {
    if (
        typeof getComputedStyle !== 'function'
        || typeof document === 'undefined'
        || !document.documentElement
    ) return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    return value || fallback;
}

function genericChartPrimaryColor() {
    return appCssColor('--chart-primary', '#00aaef');
}

function genericChartPaletteColor(index) {
    const parsed = Number(index);
    const integer = Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
    const normalized = (
        (integer % GENERIC_CHART_COLOR_FALLBACKS.length)
        + GENERIC_CHART_COLOR_FALLBACKS.length
    ) % GENERIC_CHART_COLOR_FALLBACKS.length;
    return appCssColor(`--chart-${normalized + 1}`, GENERIC_CHART_COLOR_FALLBACKS[normalized]);
}

function stateIndicatorColor(level) {
    const colors = {
        online: ['--ok', '#2bb673'],
        warning: ['--warn-indicator', '#f59e0b'],
        error: ['--danger-indicator', '#ef4444'],
        unknown: ['--gray', '#898a8d']
    };
    const [token, fallback] = colors[level] || colors.unknown;
    return appCssColor(token, fallback);
}

function applyChartJsTheme() {
    if (typeof Chart === 'undefined') return;
    const text = appCssColor('--text-2', '#3c3b47');
    const muted = appCssColor('--gray', '#898a8d');
    const grid = appCssColor('--hairline', '#e9e9ef');

    Chart.defaults.color = text;
    Chart.defaults.borderColor = grid;

    Object.values(Chart.instances || {}).forEach(chart => {
        chart.options.color = text;
        const legend = chart.options.plugins?.legend;
        if (legend) legend.labels = { ...(legend.labels || {}), color: text };
        Object.values(chart.options.scales || {}).forEach(scale => {
            scale.ticks = { ...(scale.ticks || {}), color: muted };
            scale.title = { ...(scale.title || {}), color: text };
            scale.grid = { ...(scale.grid || {}), color: grid };
            scale.border = { ...(scale.border || {}), color: grid };
        });
        chart.update('none');
    });
}

applyChartJsTheme();
