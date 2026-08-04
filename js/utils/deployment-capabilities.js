// Deployment-specific product capabilities. Keep endpoint-family availability
// explicit so unsupported tools are gated before their modules make API calls.
const DEPLOYMENT_CAPABILITY_MATRIX = Object.freeze({
    enterprise: Object.freeze({
        apiFamilies: Object.freeze({
            users: true,
            applianceFirmware: true,
            localApplianceFirmware: true,
            applianceCloudServices: true,
            applianceProductKeys: true
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
        })
    }),
    360: Object.freeze({
        apiFamilies: Object.freeze({
            users: false,
            applianceFirmware: true,
            localApplianceFirmware: false,
            applianceCloudServices: false,
            applianceProductKeys: false
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

function syncDeploymentCapabilityNavigation(deploymentType) {
    document.querySelectorAll('.module-btn[data-module]').forEach((button) => {
        const supported = deploymentSupportsModule(deploymentType, button.dataset.module);
        button.hidden = !supported;
        button.disabled = !supported;
        button.setAttribute('aria-disabled', String(!supported));
        if (!supported) button.classList.remove('active');
    });
}

window.DEPLOYMENT_CAPABILITY_MATRIX = DEPLOYMENT_CAPABILITY_MATRIX;
window.getDeploymentCapabilities = getDeploymentCapabilities;
window.deploymentSupportsModule = deploymentSupportsModule;
window.deploymentSupportsApiFamily = deploymentSupportsApiFamily;
window.syncDeploymentCapabilityNavigation = syncDeploymentCapabilityNavigation;
