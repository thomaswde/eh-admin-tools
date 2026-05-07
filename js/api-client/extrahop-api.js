class ExtraHopAPI {
    constructor(config) {
        this.config = config;
    }

    async authenticate() {
        const response = await fetch('/backend/session', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(this.config)
        });

        const data = await this.parseResponse(response);
        if (data.config) {
            this.config = data.config;
        }
        return true;
    }

    static async currentSession() {
        const response = await fetch('/backend/session', {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        if (response.status === 401) {
            return null;
        }

        const data = await ExtraHopAPI.parseStaticResponse(response);
        return data?.connected && data.config ? data.config : null;
    }

    static async getApiLogging() {
        const response = await fetch('/backend/api-logging', {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });
        return ExtraHopAPI.parseStaticResponse(response);
    }

    static async updateApiLogging(verbosity, path) {
        const body = { verbosity };
        if (path) {
            body.path = path;
        }

        const response = await fetch('/backend/api-logging', {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(body)
        });
        return ExtraHopAPI.parseStaticResponse(response);
    }

    async refreshAccessToken() {
        const response = await fetch('/backend/session/refresh', {
            method: 'POST',
            headers: { 'Accept': 'application/json' }
        });
        await this.parseResponse(response);
        return true;
    }

    async dispose() {
        await fetch('/backend/session', { method: 'DELETE' }).catch(() => {});
    }

    async request(endpoint, options = {}) {
        if (!endpoint.startsWith('/api/v1') && !endpoint.startsWith('/oauth2')) {
            endpoint = '/api/v1' + endpoint;
        }

        const response = await fetch(`/backend/extrahop${endpoint}`, {
            method: options.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: options.body
        });

        return this.parseResponse(response);
    }

    async parseResponse(response) {
        return ExtraHopAPI.parseStaticResponse(response);
    }

    static async parseStaticResponse(response) {
        if (response.status === 204) {
            return {};
        }

        const text = await response.text();
        let data = {};
        if (text) {
            try {
                data = JSON.parse(text);
            } catch (error) {
                data = text;
            }
        }

        if (!response.ok) {
            const detail = data.detail || {};
            const message = detail.message || data.message || data.error_message || data.error || response.statusText;
            const error = new Error(message);
            error.details = detail.details || data;
            error.status = response.status;
            throw error;
        }

        return data;
    }

    async getDashboards() {
        return this.request('/dashboards');
    }

    async getDashboardSharing(dashboardId) {
        return this.request(`/dashboards/${dashboardId}/sharing`);
    }

    async updateDashboard(dashboardId, body) {
        return this.request(`/dashboards/${dashboardId}`, {
            method: 'PATCH',
            body: JSON.stringify(body)
        });
    }

    async updateDashboardSharing(dashboardId, body) {
        return this.request(`/dashboards/${dashboardId}/sharing`, {
            method: 'PATCH',
            body: JSON.stringify(body)
        });
    }

    async deleteDashboard(dashboardId) {
        await this.request(`/dashboards/${dashboardId}`, {
            method: 'DELETE'
        });
        return true;
    }

    async listUsers({ suppressErrors = false } = {}) {
        try {
            return await this.request('/users');
        } catch (error) {
            if (suppressErrors) {
                console.warn('Could not fetch users:', error);
                return [];
            }
            throw error;
        }
    }

    async getUsers() {
        return this.listUsers({ suppressErrors: true });
    }

    async getUser(username) {
        return this.request(`/users/${encodeURIComponent(username)}`);
    }

    async createUser(body) {
        return this.request('/users', {
            method: 'POST',
            body: JSON.stringify(body)
        });
    }

    async updateUser(username, body) {
        return this.request(`/users/${encodeURIComponent(username)}`, {
            method: 'PATCH',
            body: JSON.stringify(body)
        });
    }

    async deleteUser(username, destUser) {
        const query = destUser
            ? `?dest_user=${encodeURIComponent(destUser)}`
            : '';

        return this.request(`/users/${encodeURIComponent(username)}${query}`, {
            method: 'DELETE'
        });
    }

    async getUserApiKeys(username) {
        return this.request(`/users/${encodeURIComponent(username)}/apikeys`);
    }

    async getUserLockStatus(username) {
        return this.request(`/users/${encodeURIComponent(username)}/lock`);
    }

    async unlockUser(username) {
        return this.request(`/users/${encodeURIComponent(username)}/lock`, {
            method: 'DELETE'
        });
    }

    async getAppliances() {
        return this.request('/appliances');
    }

    async getAuditLog(limit = 100, offset = 0) {
        return this.request(`/auditlog?limit=${limit}&offset=${offset}`);
    }
}
