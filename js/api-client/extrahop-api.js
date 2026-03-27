const LAMBDA_PROXY_URL = 'https://mdpg23urni.execute-api.us-east-2.amazonaws.com/default/extrahop-api-wrapper-proxy';
const DEFAULT_360_TOKEN_TTL_SECONDS = 30 * 60;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MIN_TOKEN_REFRESH_DELAY_MS = 60 * 1000;

class ExtraHopAPI {
    constructor(config) {
        this.config = config;
        this.proxyUrl = LAMBDA_PROXY_URL;
        this.refreshPromise = null;
        this.refreshTimerId = null;
        this.accessTokenExpiresAt = null;
        
        // For Enterprise, set up direct API URL
        if (config.type === 'enterprise') {
            this.baseUrl = `https://${config.host}/api/v1`;
        }
    }

    setAccessToken(token, expiresInSeconds = DEFAULT_360_TOKEN_TTL_SECONDS) {
        this.accessToken = token;
        this.accessTokenExpiresAt = Date.now() + (expiresInSeconds * 1000);
        sessionStorage.setItem('eh_access_token', token);
        sessionStorage.setItem('eh_access_token_expires_at', String(this.accessTokenExpiresAt));
        this.scheduleAccessTokenRefresh();
    }

    clearAccessTokenRefresh() {
        if (this.refreshTimerId) {
            clearTimeout(this.refreshTimerId);
            this.refreshTimerId = null;
        }
    }

    clearStoredAccessToken() {
        this.accessToken = null;
        this.accessTokenExpiresAt = null;
        sessionStorage.removeItem('eh_access_token');
        sessionStorage.removeItem('eh_access_token_expires_at');
    }

    scheduleAccessTokenRefresh() {
        this.clearAccessTokenRefresh();

        if (this.config.type !== '360' || !this.accessToken || !this.accessTokenExpiresAt) {
            return;
        }

        const refreshDelay = Math.max(
            MIN_TOKEN_REFRESH_DELAY_MS,
            this.accessTokenExpiresAt - Date.now() - TOKEN_REFRESH_BUFFER_MS
        );

        this.refreshTimerId = setTimeout(async () => {
            try {
                await this.refreshAccessToken({ silentFailure: true });
            } catch (error) {
                console.warn('Scheduled access token refresh failed:', error);
            }
        }, refreshDelay);
    }

    shouldRefreshAccessTokenSoon() {
        return this.config.type === '360'
            && !!this.accessToken
            && !!this.accessTokenExpiresAt
            && Date.now() >= (this.accessTokenExpiresAt - TOKEN_REFRESH_BUFFER_MS);
    }

    async refreshAccessToken({ silentFailure = false } = {}) {
        if (this.config.type !== '360') {
            return false;
        }

        if (this.refreshPromise) {
            return this.refreshPromise;
        }

        this.refreshPromise = (async () => {
            try {
                await this.authenticate({ suppressErrors: silentFailure });
                console.log('Access token refreshed successfully');
                return true;
            } catch (error) {
                this.clearAccessTokenRefresh();

                if (!silentFailure) {
                    this.clearStoredAccessToken();
                    if (window.apiClient === this) {
                        alert('Your session has expired. Please reconnect.');
                        hideConnectedState();
                        state.connected = false;
                    }
                }

                throw error;
            } finally {
                this.refreshPromise = null;
            }
        })();

        return this.refreshPromise;
    }

    dispose() {
        this.clearAccessTokenRefresh();
    }

    async authenticate(options = {}) {
        const { suppressErrors = false } = options;

        if (this.config.type === '360') {
            if (this.config.useProxy === false) {
                // Direct 360 API call (no proxy)
                const authUrl = `https://${this.config.tenant}.api.cloud.extrahop.com/oauth2/token`;
                const authPayload = new URLSearchParams({
                    grant_type: 'client_credentials',
                    client_id: this.config.apiId,
                    client_secret: this.config.apiSecret
                });

                try {
                    const response = await fetch(authUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded'
                        },
                        body: authPayload
                    });

                    if (!response.ok) {
                        const errorData = await response.json().catch(() => ({}));
                        throw new Error(`Authentication failed: ${response.status} - ${errorData.error_description || response.statusText}`);
                    }

                    const data = await response.json();
                    this.setAccessToken(data.access_token, data.expires_in || DEFAULT_360_TOKEN_TTL_SECONDS);
                    return true;
                } catch (error) {
                    throw new Error(`Direct 360 authentication failed: ${error.message}. Ensure CORS is configured on your tenant.`);
                }
            }
            
            // 360: Use Lambda proxy for OAuth
            const proxyRequest = {
                deploymentType: '360',
                tenant: this.config.tenant,
                apiId: this.config.apiId,
                apiSecret: this.config.apiSecret,
                method: 'POST',
                endpoint: '/oauth2/token'
            };

            try {
                const response = await fetch(this.proxyUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(proxyRequest)
                });

                const responseText = await response.text();
                let responseData;
                try {
                    responseData = JSON.parse(responseText);
                } catch (e) {
                    responseData = responseText;
                }

                if (!response.ok) {
                    const errorDetails = {
                        url: this.proxyUrl,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(proxyRequest, null, 2),
                        status: `${response.status} ${response.statusText}`,
                        response: responseData
                    };
                    
                    let errorMessage = 'Authentication failed. ';
                    if (response.status === 401) {
                        errorMessage += 'Invalid API ID or Secret (401 Unauthorized).';
                    } else if (response.status === 403) {
                        errorMessage += 'Access forbidden (403 Forbidden). Check API permissions.';
                    } else if (response.status === 404) {
                        errorMessage += 'Endpoint not found (404). Check tenant name.';
                    } else if (response.status === 400) {
                        errorMessage += `Bad request: ${responseData.error || 'Check configuration'}`;
                    } else {
                        errorMessage += `Server returned ${response.status} ${response.statusText}.`;
                    }

                    if (!suppressErrors) {
                        showErrorModal(errorMessage, errorDetails);
                    }
                    throw new Error(errorMessage);
                }

                this.setAccessToken(responseData.access_token, responseData.expires_in || DEFAULT_360_TOKEN_TTL_SECONDS);
                return true;
            } catch (error) {
                if (error.message.includes('Authentication failed')) {
                    throw error;
                }
                const errorDetails = {
                    url: this.proxyUrl,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(proxyRequest, null, 2),
                    status: 'Network Error',
                    response: error.message
                };
                const errorMessage = `Network error: ${error.message}. Check Lambda proxy URL: ${this.proxyUrl}`;
                if (!suppressErrors) {
                    showErrorModal(errorMessage, errorDetails);
                }
                throw new Error(errorMessage);
            }
        } else {
            // Enterprise: Direct API call to test connection
            const requestUrl = `${this.baseUrl}/extrahop`;
            const requestHeaders = {
                'Authorization': `ExtraHop apikey=${this.config.apiKey}`,
                'Accept': 'application/json'
            };

            try {
                const response = await fetch(requestUrl, {
                    headers: requestHeaders
                });

                const responseText = await response.text();
                let responseData;
                try {
                    responseData = JSON.parse(responseText);
                } catch (e) {
                    responseData = responseText;
                }

                if (!response.ok) {
                    const errorDetails = {
                        url: requestUrl,
                        headers: requestHeaders,
                        body: 'N/A',
                        status: `${response.status} ${response.statusText}`,
                        response: responseData
                    };
                    
                    let errorMessage = 'Authentication failed. ';
                    if (response.status === 401) {
                        errorMessage += 'Invalid API key (401 Unauthorized).';
                    } else if (response.status === 403) {
                        errorMessage += 'Access forbidden (403 Forbidden). Check API key permissions.';
                    } else if (response.status === 404) {
                        errorMessage += 'Endpoint not found (404). Check hostname.';
                    } else if (response.status === 400) {
                        errorMessage += `Bad request: ${responseData.error_message || 'Check configuration'}`;
                    } else {
                        errorMessage += `Server returned ${response.status} ${response.statusText}.`;
                    }

                    showErrorModal(errorMessage, errorDetails);
                    throw new Error(errorMessage);
                }

                return true;
            } catch (error) {
                if (error.message.includes('Authentication failed')) {
                    throw error;
                }
                const errorDetails = {
                    url: requestUrl,
                    headers: requestHeaders,
                    body: 'N/A',
                    status: 'Network Error',
                    response: error.message
                };
                
                let errorMessage = `Network error: ${error.message}. `;
                if (error.message.includes('Failed to fetch')) {
                    errorMessage += 'This is likely a CORS issue. For Enterprise instances, you need to either:\n' +
                        '1. Enable CORS on your ExtraHop appliance for this domain\n' +
                        '2. Use a browser extension version of this tool\n' +
                        '3. Run locally with CORS disabled for testing';
                }
                
                showErrorModal(errorMessage, errorDetails);
                throw new Error(errorMessage);
            }
        }
    }

    async request(endpoint, options = {}) {
        // Ensure endpoint starts with /api/v1 unless it's the OAuth token endpoint
        if (!endpoint.startsWith('/api/v1') && !endpoint.startsWith('/oauth2')) {
            endpoint = '/api/v1' + endpoint;
        }

        if (this.shouldRefreshAccessTokenSoon()) {
            try {
                await this.refreshAccessToken({ silentFailure: true });
            } catch (error) {
                console.warn('Proactive access token refresh failed, continuing with current token', error);
            }
        }

        const makeRequest = async () => {
            if (this.config.type === '360') {
                if (this.config.useProxy === false) {
                    // Direct 360 API call (no proxy)
                    const url = `https://${this.config.tenant}.api.cloud.extrahop.com${endpoint}`;
                    
                    const response = await fetch(url, {
                        method: options.method || 'GET',
                        headers: {
                            'Authorization': `Bearer ${this.accessToken}`,
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        body: options.body
                    });

                    if (response.status < 200 || response.status >= 300) {
                        const error = await response.text();
                        let errorMessage;
                        try {
                            const errorJson = JSON.parse(error);
                            errorMessage = errorJson.error_message || error;
                        } catch (e) {
                            errorMessage = error;
                        }
                        throw new Error(`API Error: ${response.status} - ${errorMessage}`);
                    }

                    if (response.status === 204) {
                        return {};
                    }

                    const text = await response.text();
                    return text ? JSON.parse(text) : {};
                }
                
                // 360: Use Lambda proxy
                const proxyRequest = {
                    deploymentType: '360',
                    tenant: this.config.tenant,
                    accessToken: this.accessToken,
                    method: options.method || 'GET',
                    endpoint: endpoint
                };

                if (options.body) {
                    proxyRequest.requestBody = JSON.parse(options.body);
                }

                const response = await fetch(this.proxyUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(proxyRequest)
                });

                // Check for success status codes (2xx)
                if (response.status < 200 || response.status >= 300) {
                    const error = await response.text();
                    let errorMessage;
                    try {
                        const errorJson = JSON.parse(error);
                        errorMessage = errorJson.error_message || error;
                    } catch (e) {
                        errorMessage = error;
                    }
                    throw new Error(`API Error: ${response.status} - ${errorMessage}`);
                }

                // Handle different success responses
                if (response.status === 204) {
                    return {};
                }

                const text = await response.text();
                return text ? JSON.parse(text) : {};
            } else {
                // Enterprise: Direct API call
                const url = `${this.baseUrl}${endpoint.startsWith('/api/v1') ? endpoint.substring(7) : endpoint}`;
                
                const response = await fetch(url, {
                    method: options.method || 'GET',
                    headers: {
                        'Authorization': `ExtraHop apikey=${this.config.apiKey}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: options.body
                });

                // Check for success status codes (2xx)
                if (response.status < 200 || response.status >= 300) {
                    const error = await response.text();
                    let errorMessage;
                    try {
                        const errorJson = JSON.parse(error);
                        errorMessage = errorJson.error_message || error;
                    } catch (e) {
                        errorMessage = error;
                    }
                    throw new Error(`API Error: ${response.status} - ${errorMessage}`);
                }

                // Handle different success responses
                if (response.status === 204) {
                    return {};
                }

                const text = await response.text();
                return text ? JSON.parse(text) : {};
            }
        };

        // Try the request, if 401 and 360, refresh token and retry once
        try {
            return await makeRequest();
        } catch (error) {
            if (error.message.includes('401') && this.config.type === '360') {
                console.log('Token expired, attempting refresh...');
                await this.refreshAccessToken();
                console.log('Token refreshed, retrying request...');
                return await makeRequest();
            }
            throw error;
        }
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
