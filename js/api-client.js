// Configuration - Lambda proxy URL (360 only)
const LAMBDA_PROXY_URL = 'https://mdpg23urni.execute-api.us-east-2.amazonaws.com/default/extrahop-api-wrapper-proxy';

// API Client (hybrid: Lambda for 360, direct for Enterprise)
class ExtraHopAPI {
    constructor(config) {
        this.config = config;
        this.proxyUrl = LAMBDA_PROXY_URL;
        
        // For Enterprise, set up direct API URL
        if (config.type === 'enterprise') {
            this.baseUrl = `https://${config.host}/api/v1`;
        }
    }

    async authenticate() {
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
                    this.accessToken = data.access_token;
                    sessionStorage.setItem('eh_access_token', data.access_token);
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

                    showErrorModal(errorMessage, errorDetails);
                    throw new Error(errorMessage);
                }

                this.accessToken = responseData.access_token;
                sessionStorage.setItem('eh_access_token', responseData.access_token);
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
                showErrorModal(errorMessage, errorDetails);
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
                
                // Refresh the token
                const tempApi = new ExtraHopAPI(this.config);
                await tempApi.authenticate();
                this.accessToken = tempApi.accessToken;
                
                console.log('Token refreshed, retrying request...');
                
                // Retry once with new token
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
        const proxyRequest = {
            deploymentType: this.config.type,
            method: 'DELETE',
            endpoint: `/dashboards/${dashboardId}`
        };

        if (this.config.type === '360') {
            proxyRequest.tenant = this.config.tenant;
            proxyRequest.accessToken = this.accessToken;
        } else {
            proxyRequest.host = this.config.host;
            proxyRequest.apiKey = this.config.apiKey;
        }

        // Need to prepend /api/v1 manually here since deleteDashboard bypasses request()
        proxyRequest.endpoint = '/api/v1' + proxyRequest.endpoint;

        const response = await fetch(this.proxyUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(proxyRequest)
        });
        
        return response.ok;
    }

    async getUsers() {
        // For Enterprise, this endpoint may not be available
        // For 360, users endpoint should work
        try {
            return await this.request('/users');
        } catch (e) {
            console.warn('Could not fetch users:', e);
            return [];
        }
    }

    async getAppliances() {
        return this.request('/appliances');
    }

    async getAuditLog(limit = 100, offset = 0) {
        return this.request(`/auditlog?limit=${limit}&offset=${offset}`);
    }
}