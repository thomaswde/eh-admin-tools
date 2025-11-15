class NetworkLocalities {
    constructor() {
        this.state = {
            originalLocalities: [],  // Original data from GET
            currentLocalities: [],   // Working copy with edits
            deletedIds: new Set(),   // Track deleted entries
            isLoaded: false
        };
    }

    async load() {
        if (!window.auth.isConnected) {
            alert('Please connect to your ExtraHop instance first');
            return;
        }

        if (this.state.isLoading) return;

        const btn = document.getElementById('loadLocalities');
        const originalText = btn.textContent;
        
        try {
            this.state.isLoading = true;
            btn.textContent = 'Loading...';
            btn.disabled = true;

            document.getElementById('localitiesLoading').style.display = 'block';
            document.getElementById('localitiesTable').style.display = 'none';
            document.getElementById('localityStatus').style.display = 'none';

            const response = await window.apiClient.request('/networklocalities');
            
            this.state.originalLocalities = response.map(loc => ({...loc}));
            this.state.currentLocalities = response.map(loc => ({...loc}));
            this.state.deletedIds.clear();
            this.state.isLoaded = true;

            this.render();

            document.getElementById('localitiesLoading').style.display = 'none';
            document.getElementById('localitiesTable').style.display = 'block';
            document.getElementById('addLocalityRow').style.display = 'inline-block';
            document.getElementById('saveLocalityChanges').style.display = 'inline-block';
            document.getElementById('uploadCsvLabel').style.display = 'inline-block';

            this.showLocalityStatus(`Loaded ${response.length} network localities`, 'success');

        } catch (error) {
            document.getElementById('localitiesLoading').style.display = 'none';
            this.showLocalityStatus(`Error loading localities: ${error.message}`, 'error');
        } finally {
            this.state.isLoading = false;
            btn.textContent = originalText;
            btn.disabled = false;
        }
    }

    render() {
        const tbody = document.getElementById('localitiesTableBody');
        tbody.innerHTML = '';

        this.state.currentLocalities.forEach((locality, index) => {
            if (locality._deleted) return; // Skip deleted rows
            
            const row = document.createElement('tr');
            row.dataset.index = index;
            row.dataset.id = locality.id || '';
            
            // Determine if this is new (no ID) or existing
            const isNew = !locality.id;
            
            row.innerHTML = `
                <td>
                    <input type="text" 
                           class="w-full px-2 py-1 border rounded locality-field" 
                           data-field="name" 
                           value="${this.escapeHtml(locality.name || '')}"
                           style="background-color: var(--bg-input); border-color: var(--border-color); color: var(--text-primary);">
                </td>
                <td>
                    <input type="text" 
                           class="w-full px-2 py-1 border rounded locality-field" 
                           data-field="networks" 
                           value="${this.escapeHtml((locality.networks || []).join(', '))}"
                           placeholder="e.g., 192.168.1.0/24, 10.0.0.1"
                           style="background-color: var(--bg-input); border-color: var(--border-color); color: var(--text-primary);">
                </td>
                <td>
                    <select class="w-full px-2 py-1 border rounded locality-field" 
                            data-field="external"
                            style="background-color: var(--bg-input); border-color: var(--border-color); color: var(--text-primary);">
                        <option value="false" ${!locality.external ? 'selected' : ''}>Internal</option>
                        <option value="true" ${locality.external ? 'selected' : ''}>External</option>
                    </select>
                </td>
                <td>
                    <input type="text" 
                           class="w-full px-2 py-1 border rounded locality-field" 
                           data-field="description" 
                           value="${this.escapeHtml(locality.description || '')}"
                           style="background-color: var(--bg-input); border-color: var(--border-color); color: var(--text-primary);">
                </td>
                <td class="text-center">
                    <button class="btn-danger px-3 py-1 rounded text-sm delete-locality-btn">
                        Delete
                    </button>
                </td>
            `;
            
            tbody.appendChild(row);
        });
        
        // Add event listeners for inline editing
        document.querySelectorAll('.locality-field').forEach(input => {
            input.addEventListener('change', (e) => this.handleLocalityFieldChange(e));
        });

        // Add event listeners for delete buttons
        document.querySelectorAll('.delete-locality-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.handleDeleteLocality(e));
        });
    }

    handleLocalityFieldChange(e) {
        const row = e.target.closest('tr');
        const index = parseInt(row.dataset.index);
        const field = e.target.getAttribute('data-field');
        let value = e.target.value;
        
        if (field === 'external') {
            value = value === 'true';
        } else if (field === 'networks') {
            // Convert comma-separated string to array
            value = value.split(',').map(s => s.trim()).filter(s => s);
        }
        
        this.state.currentLocalities[index][field] = value;
        this.state.currentLocalities[index]._modified = true;
    }

    handleDeleteLocality(e) {
        const row = e.target.closest('tr');
        const index = parseInt(row.dataset.index);
        const id = row.dataset.id;
        
        if (id) {
            // Existing locality - mark for deletion
            this.state.deletedIds.add(parseInt(id));
        }
        
        // Mark as deleted in current state
        this.state.currentLocalities[index]._deleted = true;
        
        this.render();
    }

    addRow() {
        const newLocality = {
            name: '',
            networks: [],
            external: false,
            description: '',
            _isNew: true
        };
        
        this.state.currentLocalities.push(newLocality);
        this.render();
        
        // Focus on the name field of the new row
        setTimeout(() => {
            const lastRow = document.querySelector('#localitiesTableBody tr:last-child');
            if (lastRow) {
                lastRow.querySelector('input[data-field="name"]')?.focus();
            }
        }, 100);
    }

    async saveChanges() {
        if (!this.state.isLoaded) {
            alert('Please load network localities first');
            return;
        }

        const saveBtn = document.getElementById('saveLocalityChanges');
        const originalText = saveBtn.textContent;

        try {
            saveBtn.textContent = 'Saving...';
            saveBtn.disabled = true;

            const results = {
                created: [],
                updated: [],
                deleted: [],
                errors: []
            };

            // Process deletions
            for (const id of this.state.deletedIds) {
                try {
                    await window.apiClient.request(`/networklocalities/${id}`, { method: 'DELETE' });
                    results.deleted.push(id);
                } catch (error) {
                    results.errors.push(`Failed to delete locality ID ${id}: ${error.message}`);
                }
            }

            // Process creations and updates
            for (const locality of this.state.currentLocalities) {
                if (locality._deleted) continue;

                // Validate required fields
                if (!locality.name || !locality.networks || locality.networks.length === 0) {
                    results.errors.push(`Skipped entry: Name and at least one network are required`);
                    continue;
                }

                const payload = {
                    name: locality.name,
                    networks: locality.networks,
                    external: locality.external,
                    description: locality.description || ''
                };

                try {
                    if (locality._isNew && !locality.id) {
                        // Create new locality
                        const response = await window.apiClient.request('/networklocalities', {
                            method: 'POST',
                            body: JSON.stringify(payload)
                        });
                        results.created.push(locality.name);
                    } else if (locality._modified && locality.id) {
                        // Update existing locality
                        await window.apiClient.request(`/networklocalities/${locality.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify(payload)
                        });
                        results.updated.push(locality.name);
                    }
                } catch (error) {
                    results.errors.push(`Failed to save "${locality.name}": ${error.message}`);
                }
            }

            // Build status message
            let statusMsg = [];
            if (results.created.length > 0) statusMsg.push(`${results.created.length} created`);
            if (results.updated.length > 0) statusMsg.push(`${results.updated.length} updated`);
            if (results.deleted.length > 0) statusMsg.push(`${results.deleted.length} deleted`);
            
            if (statusMsg.length > 0) {
                this.showLocalityStatus(`Changes saved: ${statusMsg.join(', ')}`, 'success');
            }

            if (results.errors.length > 0) {
                console.error('Errors during save:', results.errors);
                alert('Some operations failed. Check the console for details.\\n\\n' + results.errors.join('\\n'));
            }

            // Reload localities to get fresh data
            await this.load();

        } catch (error) {
            this.showLocalityStatus(`Error saving changes: ${error.message}`, 'error');
        } finally {
            saveBtn.textContent = originalText;
            saveBtn.disabled = false;
        }
    }

    handleCsvUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const csv = e.target.result;
                const lines = csv.split('\\n');
                const newLocalities = [];
                const duplicates = [];

                // Parse CSV (skip header)
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    // Parse: Name,CIDR_Blocks,Type(Internal/External),Description
                    const [name, cidrs, type, description] = this.parseCsvLine(line);
                    const networkArray = cidrs ? cidrs.split(',').map(s => s.trim()).filter(s => s) : [];

                    if (!name || networkArray.length === 0) {
                        console.warn(`Skipping row ${i + 1}: missing name or CIDR`);
                        continue;
                    }

                    // Check for duplicates in existing localities
                    const isDuplicateName = this.state.currentLocalities.some(
                        loc => !loc._deleted && loc.name.toLowerCase() === name.toLowerCase()
                    );
                    const isDuplicateNetwork = this.state.currentLocalities.some(
                        loc => !loc._deleted && loc.networks && loc.networks.some(net => networkArray.includes(net))
                    );

                    if (isDuplicateName || isDuplicateNetwork) {
                        duplicates.push({ name, networks: networkArray.join(', '), reason: isDuplicateName ? 'name' : 'CIDR' });
                        continue;
                    }

                    newLocalities.push({
                        name,
                        networks: networkArray,
                        external: type && type.toLowerCase() === 'external',
                        description: description || '',
                        _isNew: true
                    });
                }

                // Add new localities to current state
                this.state.currentLocalities.push(...newLocalities);
                this.render();

                // Show status
                let msg = `Loaded ${newLocalities.length} localities from CSV`;
                if (duplicates.length > 0) {
                    msg += ` (${duplicates.length} duplicates skipped)`;
                    console.warn('Duplicate localities skipped:', duplicates);
                }
                this.showLocalityStatus(msg, duplicates.length > 0 ? 'warning' : 'success');

                // Show duplicate report if any
                if (duplicates.length > 0) {
                    const duplicateReport = duplicates.map(d => `${d.name} (${d.reason}): ${d.networks}`).join('\\n');
                    alert(`${duplicates.length} duplicate entries were skipped:\\n\\n${duplicateReport}`);
                }

            } catch (error) {
                alert('Error parsing CSV: ' + error.message);
            }
        };

        reader.readAsText(file);
    }

    parseCsvLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        
        result.push(current.trim());
        
        return result;
    }

    showLocalityStatus(message, type = 'success') {
        const statusDiv = document.getElementById('localityStatus');
        const statusText = document.getElementById('localityStatusText');
        
        statusDiv.style.display = 'block';
        statusText.textContent = message;
        
        const colors = {
            success: { bg: '#dcfce7', border: '#166534', text: '#166534' },
            warning: { bg: '#fef3c7', border: '#92400e', text: '#92400e' },
            error: { bg: '#fee2e2', border: '#dc2626', text: '#dc2626' }
        };
        
        const color = colors[type] || colors.success;
        statusDiv.querySelector('div').style.backgroundColor = color.bg;
        statusDiv.querySelector('div').style.borderColor = color.border;
        statusText.style.color = color.text;
        
        setTimeout(() => {
            statusDiv.style.display = 'none';
        }, 5000);
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    setupEventListeners() {
        // Load button
        document.getElementById('loadLocalities').addEventListener('click', () => this.load());
        
        // Add row button
        document.getElementById('addLocalityRow').addEventListener('click', () => this.addRow());
        
        // Save changes button
        document.getElementById('saveLocalityChanges').addEventListener('click', () => this.saveChanges());
        
        // CSV upload
        document.getElementById('localityCsvInput').addEventListener('change', (e) => this.handleCsvUpload(e));
    }

    getTemplate() {
        return `
            <div class="mb-6">
                <h2 class="text-2xl font-bold" style="color: var(--sapphire);">Network Localities Manager</h2>
                <p class="mt-2" style="color: var(--text-muted);">Manage network locality entries to designate IP addresses and CIDR blocks as internal or external</p>
            </div>

            <!-- Action Buttons -->
            <div class="flex flex-wrap gap-3 mb-6">
                <button id="loadLocalities" class="btn-primary px-6 py-2 rounded font-semibold">
                    Load Network Localities
                </button>
                <button id="addLocalityRow" class="btn-secondary px-6 py-2 rounded font-semibold" style="display: none;">
                    Add New Locality
                </button>
                <button id="saveLocalityChanges" class="btn-primary px-6 py-2 rounded font-semibold" style="display: none;">
                    Save Changes
                </button>
                <label class="btn-secondary px-6 py-2 rounded font-semibold cursor-pointer" style="display: none;" id="uploadCsvLabel">
                    Upload CSV
                    <input type="file" id="localityCsvInput" accept=".csv" class="hidden">
                </label>
            </div>

            <!-- Status Messages -->
            <div id="localityStatus" class="mb-4" style="display: none;">
                <div class="p-4 rounded" style="background-color: var(--bg-card); border: 1px solid var(--border-color);">
                    <p id="localityStatusText" class="text-sm"></p>
                </div>
            </div>

            <!-- Loading Indicator -->
            <div id="localitiesLoading" class="text-center py-12" style="display: none;">
                <div class="spinner mx-auto mb-4"></div>
                <p style="color: var(--text-muted);">Loading network localities...</p>
            </div>

            <!-- Localities Table -->
            <div id="localitiesTable" class="table-container rounded-lg overflow-x-auto" style="display: none;">
                <table id="localitiesDataTable" class="w-full">
                    <thead>
                        <tr>
                            <th style="width: 20%;">Network Locality Name</th>
                            <th style="width: 30%;">IP Addresses and CIDR Blocks</th>
                            <th style="width: 15%;">Network Locality Type</th>
                            <th style="width: 25%;">Description</th>
                            <th style="width: 10%;">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="localitiesTableBody">
                        <!-- Populated dynamically -->
                    </tbody>
                </table>
            </div>
        `;
    }

    activate() {
        // Setup event listeners when module is activated
        this.setupEventListeners();
        
        // Set module title
        document.getElementById('ribbonModuleTitle').textContent = 'Network Localities Manager';
    }

    deactivate() {
        // Clean up when switching modules
        this.state.originalLocalities = [];
        this.state.currentLocalities = [];
        this.state.deletedIds.clear();
        this.state.isLoaded = false;
        document.getElementById('localitiesTable').style.display = 'none';
        document.getElementById('addLocalityRow').style.display = 'none';
        document.getElementById('saveLocalityChanges').style.display = 'none';
        document.getElementById('uploadCsvLabel').style.display = 'none';
    }
}

// Export for global use
window.NetworkLocalities = NetworkLocalities;