/* exported moduleLoader */
// Dynamic Module Loader

class ModuleLoader {
    constructor() {
        this.loadedModules = new Set();
        this.loadingModules = new Map();
        this.switchingModules = new Map();
        this.switchQueue = Promise.resolve();
        this.moduleMap = {
            'dashboards': 'dashboard-manager.js',
            'users': 'user-manager.js',
            'crs-usage': 'records-report.js',
            'device-discovery': 'device-discovery.js',
            'system-health': 'system-health-report.js',
            'pcap-analyzer': 'pcap-analyzer.js',
            'localities': 'network-localities.js',
            'audit-logs': 'audit-logs.js',
            'nodemap': 'nodemap.js'
        };
        this.moduleDependencies = {
            'nodemap': ['appliance-management.js'],
            'crs-usage': ['system-health-collection.js'],
            'pcap-analyzer': ['chart-theme.js'],
            'system-health': [
                'chart-theme.js',
                'system-health-collection.js',
                'system-health-view-model.js',
                'system-health-pptx.js'
            ]
        };
    }

    loadModule(moduleName) {
        if (this.loadedModules.has(moduleName)) {
            return Promise.resolve(featureRegistry.has(moduleName));
        }
        if (this.loadingModules.has(moduleName)) {
            return this.loadingModules.get(moduleName);
        }

        const pending = this.loadModuleOnce(moduleName).finally(() => {
            if (this.loadingModules.get(moduleName) === pending) {
                this.loadingModules.delete(moduleName);
            }
        });
        this.loadingModules.set(moduleName, pending);
        return pending;
    }

    async loadModuleOnce(moduleName) {
        const moduleFile = this.moduleMap[moduleName];
        if (!moduleFile) {
            console.warn(`Module '${moduleName}' not found in module map`);
            return false;
        }

        try {
            console.log(`Loading module: ${moduleName}`);

            for (const dependency of this.moduleDependencies[moduleName] || []) {
                await this.loadScript(`js/modules/${dependency}?v=${Date.now()}`, `${moduleName}:${dependency}`);
            }

            const existingScript = document.querySelector(`script[data-module-name="${moduleName}"]`);
            if (existingScript && existingScript.dataset.moduleLoaded === 'true') {
                if (!featureRegistry.has(moduleName)) {
                    console.error(`Module '${moduleName}' script exists without a registered feature.`);
                    existingScript.remove();
                    return false;
                }
                this.loadedModules.add(moduleName);
                return true;
            }
            if (existingScript) existingScript.remove();

            // Create script element and load the module
            const script = document.createElement('script');
            script.src = `js/modules/${moduleFile}?v=${Date.now()}`;
            script.async = true;
            script.dataset.moduleName = moduleName;
            
            // Return a promise that resolves when the script loads
            return new Promise((resolve) => {
                script.onload = () => {
                    if (!featureRegistry.has(moduleName)) {
                        console.error(`Module '${moduleName}' loaded without registering its feature.`);
                        script.remove();
                        resolve(false);
                        return;
                    }
                    script.dataset.moduleLoaded = 'true';
                    this.loadedModules.add(moduleName);
                    console.log(`Module '${moduleName}' loaded successfully from ${script.src}`);
                    resolve(true);
                };
                
                script.onerror = (error) => {
                    console.error(`Failed to load module '${moduleName}' from ${script.src}:`, error);
                    script.remove();
                    resolve(false);
                };
                
                document.head.appendChild(script);
            });
        } catch (error) {
            console.error(`Error loading module '${moduleName}':`, error);
            return false;
        }
    }

    loadScript(src, dependencyName) {
        const selector = `script[data-module-dependency="${dependencyName}"]`;
        const existing = document.querySelector(selector);
        if (existing?.dataset.moduleLoaded === 'true') return Promise.resolve(true);
        if (existing) existing.remove();
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.dataset.moduleDependency = dependencyName;
        return new Promise((resolve, reject) => {
            script.onload = () => {
                script.dataset.moduleLoaded = 'true';
                resolve(true);
            };
            script.onerror = () => {
                script.remove();
                reject(new Error(`Failed to load module dependency: ${dependencyName}`));
            };
            document.head.appendChild(script);
        });
    }

    async switchToModule(moduleName) {
        const runtimeContext = typeof runtimeContextForState === 'function'
            ? runtimeContextForState(window.state)
            : window.state?.apiConfig?.type || 'offline';
        if (!deploymentSupportsModule(runtimeContext, moduleName)) {
            console.warn(`Module '${moduleName}' is unavailable in runtime context '${runtimeContext}'`);
            return false;
        }

        if (this.switchingModules.has(moduleName)) return this.switchingModules.get(moduleName);
        const pending = this.switchQueue
            .catch(() => {})
            .then(() => this.switchToModuleOnce(moduleName))
            .finally(() => {
                if (this.switchingModules.get(moduleName) === pending) {
                    this.switchingModules.delete(moduleName);
                }
            });
        this.switchingModules.set(moduleName, pending);
        this.switchQueue = pending;
        return pending;
    }

    async switchToModuleOnce(moduleName) {

        // First, ensure the module is loaded
        let loaded = false;
        try {
            loaded = await this.loadModule(moduleName);
        } catch (error) {
            console.error(`Failed to load module '${moduleName}':`, error);
            return false;
        }
        
        if (!loaded) {
            console.error(`Failed to load module '${moduleName}'`);
            return false;
        }

        try {
            await featureRegistry.initialize(moduleName);
            switchModule(moduleName);
            await featureRegistry.activate(moduleName, { moduleName });
        } catch (error) {
            console.error(`Error opening module '${moduleName}':`, error);
            return false;
        }

        return true;
    }

    isModuleLoaded(moduleName) {
        return this.loadedModules.has(moduleName);
    }
}

// Global module loader instance
const moduleLoader = new ModuleLoader();
