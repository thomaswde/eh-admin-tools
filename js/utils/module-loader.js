// Dynamic Module Loader

class ModuleLoader {
    constructor() {
        this.loadedModules = new Set();
        this.moduleMap = {
            'dashboards': 'dashboard-manager.js',
            'crs-usage': 'records-report.js',
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
            
            // Create script element and load the module
            const script = document.createElement('script');
            script.src = `js/modules/${moduleFile}`;
            script.async = true;
            
            // Return a promise that resolves when the script loads
            return new Promise((resolve, reject) => {
                script.onload = () => {
                    this.loadedModules.add(moduleName);
                    console.log(`Module '${moduleName}' loaded successfully`);
                    resolve(true);
                };
                
                script.onerror = (error) => {
                    console.error(`Failed to load module '${moduleName}':`, error);
                    reject(false);
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
        const loaded = await this.loadModule(moduleName);
        
        if (!loaded) {
            console.error(`Failed to load module '${moduleName}'`);
            return false;
        }

        // Switch to the module using the common utility
        switchModule(moduleName);

        // Call module-specific initialization if available
        const initFunctionName = `init${moduleName.charAt(0).toUpperCase() + moduleName.slice(1).replace('-', '')}Module`;
        if (typeof window[initFunctionName] === 'function') {
            try {
                await window[initFunctionName]();
            } catch (error) {
                console.error(`Error initializing module '${moduleName}':`, error);
            }
        }

        return true;
    }

    isModuleLoaded(moduleName) {
        return this.loadedModules.has(moduleName);
    }
}

// Global module loader instance
const moduleLoader = new ModuleLoader();