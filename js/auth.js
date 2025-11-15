class Auth {
    constructor() {
        this.currentConfig = null;
        this.isConnected = false;
    }

    validateConfig(config) {
        if (config.type === '360') {
            if (!config.tenant || !config.apiId || !config.apiSecret) {
                throw new Error('Tenant, API ID, and API Secret are required for RevealX 360');
            }
        } else if (config.type === 'enterprise') {
            if (!config.host || !config.apiKey) {
                throw new Error('Host and API Key are required for RevealX Enterprise');
            }
        } else {
            throw new Error('Invalid deployment type');
        }
    }

    async connect(config) {
        this.validateConfig(config);
        
        try {
            const api = new ExtraHopAPI(config);
            const success = await api.authenticate();
            
            if (success) {
                this.currentConfig = config;
                this.isConnected = true;
                
                // Store config and token in session
                sessionStorage.setItem('eh_config', JSON.stringify(config));
                
                return api;
            }
        } catch (error) {
            throw error;
        }
    }

    disconnect() {
        this.currentConfig = null;
        this.isConnected = false;
        sessionStorage.removeItem('eh_config');
        sessionStorage.removeItem('eh_access_token');
        window.apiClient = null;
    }

    getStoredConfig() {
        try {
            const savedConfig = sessionStorage.getItem('eh_config');
            return savedConfig ? JSON.parse(savedConfig) : null;
        } catch (error) {
            console.warn('Failed to parse stored config:', error);
            return null;
        }
    }

    getStoredToken() {
        return sessionStorage.getItem('eh_access_token');
    }

    async restoreSession() {
        const config = this.getStoredConfig();
        const token = this.getStoredToken();
        
        if (config && token) {
            try {
                // Create API client with stored config
                const api = new ExtraHopAPI(config);
                api.accessToken = token;
                
                // Test if token is still valid
                await api.request('/extrahop');
                
                this.currentConfig = config;
                this.isConnected = true;
                return api;
            } catch (error) {
                // Token expired or invalid, clear session
                this.disconnect();
                throw new Error('Session expired. Please reconnect.');
            }
        }
        return null;
    }

    getConnectionInfo() {
        if (!this.isConnected || !this.currentConfig) {
            return null;
        }

        if (this.currentConfig.type === '360') {
            return {
                type: 'RevealX 360',
                endpoint: `${this.currentConfig.tenant}.api.cloud.extrahop.com`,
                proxy: this.currentConfig.useProxy !== false
            };
        } else {
            return {
                type: 'RevealX Enterprise',
                endpoint: this.currentConfig.host,
                proxy: false
            };
        }
    }
}

// Global auth instance
window.auth = new Auth();