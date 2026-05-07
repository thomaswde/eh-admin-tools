// Dynamic Module Loader

class ModuleLoader {
    constructor() {
        this.loadedModules = new Set();
        this.moduleMap = {
            'dashboards': 'dashboard-manager.js',
            'users': 'user-manager.js',
            'crs-usage': 'records-report.js',
            'device-discovery': 'device-discovery.js',
            'system-health': 'system-health-report.js',
            'localities': 'network-localities.js',
            'audit-logs': 'audit-logs.js',
            'nodemap': 'nodemap.js'
        };
    }

    async loadModule(moduleName) {
        if (this.loadedModules.has(moduleName)) {
            return true; // Already loaded
        }

        const moduleFile = this.moduleMap[moduleName];
        if (!moduleFile) {
            console.warn(`Module '${moduleName}' not found in module map`);
            return false;
        }

        try {
            console.log(`Loading module: ${moduleName}`);

            const existingScript = document.querySelector(`script[data-module-name="${moduleName}"]`);
            if (existingScript && existingScript.dataset.moduleLoaded === 'true') {
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

    async switchToModule(moduleName) {
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

        // Switch to the module using the common utility
        switchModule(moduleName);

        // Call module-specific initialization if available
        const camelCaseName = moduleName.split('-').map((part, index) => 
            index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : 
                         part.charAt(0).toUpperCase() + part.slice(1)
        ).join('');
        const initFunctionName = `init${camelCaseName}Module`;
        console.log(`Looking for init function: ${initFunctionName}`);
        if (typeof window[initFunctionName] === 'function') {
            try {
                console.log(`Calling ${initFunctionName}()`);
                await window[initFunctionName]();
            } catch (error) {
                console.error(`Error initializing module '${moduleName}':`, error);
                this.loadedModules.delete(moduleName);
                return false;
            }
        } else {
            console.warn(`Init function ${initFunctionName} not found for module '${moduleName}'`);
        }

        return true;
    }

    isModuleLoaded(moduleName) {
        return this.loadedModules.has(moduleName);
    }
}

// Global module loader instance
const moduleLoader = new ModuleLoader();
