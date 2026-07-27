/* exported ExtraHopAPI */
const EXTRAHOP_REQUEST_TIMEOUT_MS = 75 * 1000;
const MAX_FIRMWARE_APPLIANCE_IDS = 100;

class ExtraHopAPI {
    constructor(config) {
        this.config = config;
    }

    async authenticate() {
        const savedConnectionId = this.config?.connectionId;
        const url = savedConnectionId
            ? `/backend/connections/${encodeURIComponent(savedConnectionId)}/session`
            : '/backend/session';
        const options = {
            method: 'POST',
            headers: {
                'Accept': 'application/json'
            }
        };
        if (savedConnectionId) {
            const savedConnectionRequest = {};
            if (this.config.proxyToken) {
                savedConnectionRequest.proxyToken = this.config.proxyToken;
            }
            if (this.config.updates && Object.keys(this.config.updates).length) {
                savedConnectionRequest.updates = this.config.updates;
            }
            if (Object.keys(savedConnectionRequest).length) {
                options.headers['Content-Type'] = 'application/json';
                options.body = JSON.stringify(savedConnectionRequest);
            }
        } else {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(this.config);
        }
        const response = await ExtraHopAPI.backendFetch(url, options);

        const data = await this.parseResponse(response);
        if (data.config) {
            this.config = data.config;
        }
        this.savedConnection = data.savedConnection;
        this.connectionStorage = data.connectionStorage || null;
        return true;
    }

    static async listSavedConnections() {
        const response = await ExtraHopAPI.backendFetch('/backend/connections', {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });
        return ExtraHopAPI.parseStaticResponse(response);
    }

    static async deleteSavedConnection(connectionId) {
        const response = await ExtraHopAPI.backendFetch(
            `/backend/connections/${encodeURIComponent(connectionId)}`,
            {
                method: 'DELETE',
                headers: { 'Accept': 'application/json' }
            }
        );
        return ExtraHopAPI.parseStaticResponse(response);
    }

    static async currentSession() {
        const response = await ExtraHopAPI.backendFetch('/backend/session', {
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
        const response = await ExtraHopAPI.backendFetch('/backend/api-logging', {
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

        const response = await ExtraHopAPI.backendFetch('/backend/api-logging', {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(body)
        });
        return ExtraHopAPI.parseStaticResponse(response);
    }

    async dispose() {
        await ExtraHopAPI.backendFetch('/backend/session', { method: 'DELETE' }).catch(() => {});
    }

    async request(endpoint, options = {}) {
        const response = await this.requestResponse(endpoint, options);
        return this.parseResponse(response);
    }

    async requestResponse(endpoint, options = {}) {
        if (!endpoint.startsWith('/api/v1') && !endpoint.startsWith('/oauth2')) {
            endpoint = '/api/v1' + endpoint;
        }

        return ExtraHopAPI.backendFetch(`/backend/extrahop${endpoint}`, {
            method: options.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: options.body,
            signal: options.signal,
            timeoutMs: options.timeoutMs === undefined
                ? EXTRAHOP_REQUEST_TIMEOUT_MS
                : options.timeoutMs
        });
    }

    async parseResponse(response) {
        return ExtraHopAPI.parseStaticResponse(response);
    }

    assertApiFamilySupported(familyName) {
        if (
            typeof deploymentSupportsApiFamily === 'function'
            && !deploymentSupportsApiFamily(this.config?.type, familyName)
        ) {
            const error = new Error(
                `${familyName === 'users' ? 'User management' : familyName} is not supported for this deployment type.`
            );
            error.code = 'UNSUPPORTED_DEPLOYMENT_CAPABILITY';
            throw error;
        }
    }

    static async backendFetch(url, options = {}) {
        const fetchOptions = { ...options };
        const callerSignal = fetchOptions.signal;
        const timeoutMs = Number(fetchOptions.timeoutMs);
        delete fetchOptions.timeoutMs;

        let timeoutId = null;
        let timedOut = false;
        let timeoutController = null;
        let forwardCallerAbort = null;
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
            timeoutController = new AbortController();
            fetchOptions.signal = timeoutController.signal;
            forwardCallerAbort = () => timeoutController.abort(callerSignal.reason);
            if (callerSignal) {
                if (callerSignal.aborted) {
                    forwardCallerAbort();
                } else {
                    callerSignal.addEventListener('abort', forwardCallerAbort, { once: true });
                }
            }
            timeoutId = setTimeout(() => {
                timedOut = true;
                timeoutController.abort(new Error(`Request timed out after ${timeoutMs} ms.`));
            }, timeoutMs);
        }

        try {
            return await fetch(url, {
                ...fetchOptions,
                // Every ExtraHop environment is accessed through the same local
                // proxy URLs, so cached GET responses must never cross sessions.
                cache: 'no-store'
            });
        } catch (cause) {
            if (callerSignal && callerSignal.aborted) throw cause;
            if (timedOut) {
                const error = new Error(
                    `The ExtraHop API request timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`
                );
                error.status = 504;
                error.details = {
                    url,
                    status: 'Request Timeout',
                    response: {
                        message: cause?.message || 'The browser cancelled a request that exceeded its deadline.',
                        hint: 'Retry the operation. Reports that support partial results will identify the affected collection group.'
                    }
                };
                throw error;
            }
            const error = new Error(
                'The local app service could not be reached. Keep the launcher terminal open and use the URL printed by start.sh; do not open index.html directly.'
            );
            error.details = {
                url,
                status: 'Local Backend Unreachable',
                response: {
                    message: cause?.message || 'The browser received no HTTP response.',
                    hint: 'Restart the packaged launcher and retry from its local http://127.0.0.1 URL.'
                }
            };
            throw error;
        } finally {
            if (timeoutId !== null) clearTimeout(timeoutId);
            if (callerSignal && forwardCallerAbort) {
                callerSignal.removeEventListener('abort', forwardCallerAbort);
            }
        }
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
            } catch {
                data = text;
            }
        }

        if (!response.ok) {
            if (response.status === 401) {
                ExtraHopAPI.markSessionExpired();
            }
            const detail = data.detail || {};
            const message = detail.message || data.message || data.error_message || data.error || response.statusText;
            const error = new Error(message);
            error.details = detail.details || data;
            error.status = response.status;
            throw error;
        }

        return data;
    }

    static markSessionExpired() {
        if (!window.state?.connected) return;

        state.connected = false;
        state.apiConfig = null;
        state.currentModule = null;
        window.apiClient = null;
        sessionStorage.removeItem('eh_config');
        hideConnectedState();
        document.getElementById('moduleSelection').style.display = 'none';
        document.querySelectorAll('.module-content').forEach(module => {
            module.style.display = 'none';
        });
        document.getElementById('welcomeScreen').style.display = 'block';
        showStatus('The local session expired or the backend restarted. Reconnect to continue.', true);
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
            this.assertApiFamilySupported('users');
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
        this.assertApiFamilySupported('users');
        return this.request(`/users/${encodeURIComponent(username)}`);
    }

    async createUser(body) {
        this.assertApiFamilySupported('users');
        return this.request('/users', {
            method: 'POST',
            body: JSON.stringify(body)
        });
    }

    async updateUser(username, body) {
        this.assertApiFamilySupported('users');
        return this.request(`/users/${encodeURIComponent(username)}`, {
            method: 'PATCH',
            body: JSON.stringify(body)
        });
    }

    async deleteUser(username, destUser) {
        this.assertApiFamilySupported('users');
        const query = destUser
            ? `?dest_user=${encodeURIComponent(destUser)}`
            : '';

        return this.request(`/users/${encodeURIComponent(username)}${query}`, {
            method: 'DELETE'
        });
    }

    async getUserApiKeys(username) {
        this.assertApiFamilySupported('users');
        return this.request(`/users/${encodeURIComponent(username)}/apikeys`);
    }

    async getUserLockStatus(username) {
        this.assertApiFamilySupported('users');
        return this.request(`/users/${encodeURIComponent(username)}/lock`);
    }

    async unlockUser(username) {
        this.assertApiFamilySupported('users');
        return this.request(`/users/${encodeURIComponent(username)}/lock`, {
            method: 'DELETE'
        });
    }

    async getAppliances(options = {}) {
        return this.request('/appliances', options);
    }

    async getApplianceFirmwareVersions(ids = [], options = {}) {
        this.assertApiFamilySupported('applianceFirmware');
        const normalizedIds = ExtraHopAPI.validateOpaqueIds(ids, MAX_FIRMWARE_APPLIANCE_IDS);
        const query = normalizedIds.length
            ? `?ids=${encodeURIComponent(normalizedIds.join(','))}`
            : '';
        return this.request(`/appliances/firmware/next${query}`, options);
    }

    async upgradeApplianceFirmware(systemIds, version, options = {}) {
        this.assertApiFamilySupported('applianceFirmware');
        const normalizedIds = ExtraHopAPI.validateOpaqueIds(systemIds, MAX_FIRMWARE_APPLIANCE_IDS);
        if (!normalizedIds.length) {
            throw new TypeError('At least one appliance ID is required for a firmware upgrade.');
        }
        const normalizedVersion = String(version || '').trim();
        if (!normalizedVersion || normalizedVersion.length > 128) {
            throw new TypeError('A valid firmware version is required.');
        }

        const response = await this.requestResponse('/appliances/firmware/upgrade', {
            ...options,
            method: 'POST',
            body: JSON.stringify({ system_ids: normalizedIds, version: normalizedVersion })
        });
        const data = await this.parseResponse(response);
        return {
            data,
            status: response.status,
            location: response.headers?.get?.('location') || null
        };
    }

    async getApplianceCloudServices(options = {}) {
        this.assertApiFamilySupported('applianceCloudServices');
        return this.request('/appliances/0/cloudservices', options);
    }

    async getApplianceProductKeys(applianceId, options = {}) {
        this.assertApiFamilySupported('applianceProductKeys');
        const [normalizedId] = ExtraHopAPI.validateOpaqueIds([applianceId], 1);
        return this.request(`/appliances/${encodeURIComponent(normalizedId)}/productkey`, options);
    }

    async getFirmwareUpgradeJob(location, options = {}) {
        const normalizedLocation = String(location || '');
        if (!/^\/api\/v1\/jobs\/[A-Za-z0-9._~-]+$/.test(normalizedLocation)) {
            throw new TypeError('The firmware job location is invalid.');
        }
        return this.request(normalizedLocation, options);
    }

    static validateOpaqueIds(ids, maximum) {
        if (!Array.isArray(ids) || ids.length > maximum) {
            throw new TypeError(`Expected at most ${maximum} appliance IDs.`);
        }
        return ids.map(value => {
            const normalized = String(value);
            if (!/^(?:0|[1-9][0-9]*)$/.test(normalized)) {
                throw new TypeError('Appliance IDs must be opaque decimal strings.');
            }
            return normalized;
        });
    }

    async getAuditLog(limit = 100, offset = 0, options = {}) {
        return this.request(`/auditlog?limit=${limit}&offset=${offset}`, options);
    }
}
