// Deployment-specific product capabilities. Keep endpoint-family availability
// explicit so unsupported tools are gated before their modules make API calls.
const DEPLOYMENT_CAPABILITY_MATRIX = Object.freeze({
    offline: Object.freeze({
        apiFamilies: Object.freeze({
            users: false,
            applianceFirmware: false,
            localApplianceFirmware: false,
            applianceCloudServices: false,
            applianceProductKeys: false,
            configurationBackups: false
        }),
        modules: Object.freeze({
            'audit-logs': false,
            nodemap: false,
            dashboards: false,
            'device-discovery': false,
            localities: false,
            'crs-usage': false,
            'system-health': true,
            'pcap-analyzer': true,
            users: false
        }),
        actions: Object.freeze({
            'datafeed.upload': true,
            'datafeed.collect': false,
            'systemHealth.import': true,
            'systemHealth.collect': false,
            'systemHealth.exportLocal': true,
            'systemHealth.exportApiRows': false
        })
    }),
    enterprise: Object.freeze({
        apiFamilies: Object.freeze({
            users: true,
            applianceFirmware: true,
            localApplianceFirmware: true,
            applianceCloudServices: true,
            applianceProductKeys: true,
            configurationBackups: true
        }),
        modules: Object.freeze({
            'audit-logs': true,
            nodemap: true,
            dashboards: true,
            'device-discovery': true,
            localities: true,
            'crs-usage': true,
            'system-health': true,
            'pcap-analyzer': true,
            users: true
        }),
        actions: Object.freeze({
            'datafeed.upload': true,
            'datafeed.collect': true,
            'systemHealth.import': true,
            'systemHealth.collect': true,
            'systemHealth.exportLocal': true,
            'systemHealth.exportApiRows': true
        })
    }),
    360: Object.freeze({
        apiFamilies: Object.freeze({
            users: false,
            applianceFirmware: true,
            localApplianceFirmware: false,
            applianceCloudServices: false,
            applianceProductKeys: false,
            configurationBackups: false
        }),
        modules: Object.freeze({
            'audit-logs': true,
            nodemap: true,
            dashboards: true,
            'device-discovery': true,
            localities: true,
            'crs-usage': true,
            'system-health': true,
            'pcap-analyzer': true,
            users: false
        }),
        actions: Object.freeze({
            'datafeed.upload': true,
            'datafeed.collect': true,
            'systemHealth.import': true,
            'systemHealth.collect': true,
            'systemHealth.exportLocal': true,
            'systemHealth.exportApiRows': true
        })
    })
});

function getDeploymentCapabilities(deploymentType) {
    return DEPLOYMENT_CAPABILITY_MATRIX[deploymentType] || null;
}

function deploymentSupportsModule(deploymentType, moduleName) {
    const capabilities = getDeploymentCapabilities(deploymentType);
    return capabilities ? capabilities.modules[moduleName] === true : false;
}

function deploymentSupportsApiFamily(deploymentType, familyName) {
    const capabilities = getDeploymentCapabilities(deploymentType);
    return capabilities ? capabilities.apiFamilies[familyName] === true : false;
}

function runtimeContextForState(appState = window.state) {
    const deploymentType = appState?.connected && appState?.apiConfig?.type;
    return deploymentType === 'enterprise' || deploymentType === '360'
        ? deploymentType
        : 'offline';
}

function runtimeSupportsAction(runtimeContext, actionName) {
    const capabilities = getDeploymentCapabilities(runtimeContext);
    return capabilities ? capabilities.actions[actionName] === true : false;
}

function moduleCapabilityReason(runtimeContext, moduleName) {
    if (deploymentSupportsModule(runtimeContext, moduleName)) return '';
    if (runtimeContext === 'offline') return '';
    if (runtimeContext === '360' && moduleName === 'users') {
        return 'Available only with RevealX Enterprise.';
    }
    return 'This tool is unavailable for the current deployment.';
}

function syncDeploymentCapabilityNavigation(deploymentType) {
    document.querySelectorAll('.module-btn[data-module]').forEach((button) => {
        const supported = deploymentSupportsModule(deploymentType, button.dataset.module);
        const reason = moduleCapabilityReason(deploymentType, button.dataset.module);
        button.hidden = false;
        button.disabled = !supported;
        button.setAttribute('aria-disabled', String(!supported));
        button.title = reason;
        const reasonElement = button.querySelector?.('.module-capability-reason');
        if (reasonElement) {
            reasonElement.textContent = reason;
            reasonElement.hidden = !reason;
        }
        if (!supported) button.classList.remove('active');
    });
}

window.DEPLOYMENT_CAPABILITY_MATRIX = DEPLOYMENT_CAPABILITY_MATRIX;
window.getDeploymentCapabilities = getDeploymentCapabilities;
window.deploymentSupportsModule = deploymentSupportsModule;
window.deploymentSupportsApiFamily = deploymentSupportsApiFamily;
window.runtimeContextForState = runtimeContextForState;
window.runtimeSupportsAction = runtimeSupportsAction;
window.moduleCapabilityReason = moduleCapabilityReason;
window.syncDeploymentCapabilityNavigation = syncDeploymentCapabilityNavigation;
