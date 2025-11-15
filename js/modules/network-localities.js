class NetworkLocalities {
    constructor() {
        this.state = {
            localities: [],
            isLoading: false
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

            const response = await window.apiClient.request('/networklocalities');
            this.state.localities = response;
            this.render();

        } catch (error) {
            alert('Error loading network localities: ' + error.message);
        } finally {
            this.state.isLoading = false;
            btn.textContent = originalText;
            btn.disabled = false;
        }
    }

    render() {
        const tbody = document.getElementById('localitiesTableBody');
        tbody.innerHTML = '';

        this.state.localities.forEach(locality => {
            const row = this.createLocalityRow(locality);
            tbody.appendChild(row);
        });

        this.showLocalitiesTable();
    }

    createLocalityRow(locality = null) {
        const row = document.createElement('tr');
        const isNew = !locality;
        
        if (isNew) {
            locality = { name: '', description: '', vlan_ids: '', subnets: '' };
        }

        row.innerHTML = `
            <td>
                <input type="text" value="${locality.name || ''}" class="w-full px-2 py-1 border rounded" data-field="name">
            </td>
            <td>
                <input type="text" value="${locality.description || ''}" class="w-full px-2 py-1 border rounded" data-field="description">
            </td>
            <td>
                <input type="text" value="${locality.vlan_ids || ''}" class="w-full px-2 py-1 border rounded" data-field="vlan_ids" placeholder="1,2,3">
            </td>
            <td>
                <input type="text" value="${locality.subnets || ''}" class="w-full px-2 py-1 border rounded" data-field="subnets" placeholder="192.168.1.0/24,10.0.0.0/8">
            </td>
            <td>
                <button class="btn-danger px-3 py-1 rounded text-sm delete-locality-btn" data-id="${locality.id || ''}">
                    Delete
                </button>
            </td>
        `;

        return row;
    }

    addRow() {
        const tbody = document.getElementById('localitiesTableBody');
        const newRow = this.createLocalityRow();
        tbody.appendChild(newRow);
    }

    showLocalitiesTable() {
        document.getElementById('localitiesLoading').style.display = 'none';
        document.getElementById('localitiesTableContainer').style.display = 'block';
        document.getElementById('localitiesActions').style.display = 'block';
    }

    async saveChanges() {
        const rows = document.querySelectorAll('#localitiesTableBody tr');
        const changes = [];

        for (const row of rows) {
            const inputs = row.querySelectorAll('input[data-field]');
            const data = {};
            
            inputs.forEach(input => {
                const field = input.getAttribute('data-field');
                let value = input.value.trim();
                
                if (field === 'vlan_ids') {
                    data[field] = value ? value.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)) : [];
                } else if (field === 'subnets') {
                    data[field] = value ? value.split(',').map(subnet => subnet.trim()).filter(subnet => subnet) : [];
                } else {
                    data[field] = value;
                }
            });

            if (data.name) {
                const deleteBtn = row.querySelector('.delete-locality-btn');
                const id = deleteBtn.getAttribute('data-id');
                
                if (id) {
                    data.id = parseInt(id);
                }
                
                changes.push(data);
            }
        }

        if (changes.length === 0) {
            alert('No valid localities to save');
            return;
        }

        const saveBtn = document.getElementById('saveLocalityChanges');
        const originalText = saveBtn.textContent;

        try {
            saveBtn.textContent = 'Saving...';
            saveBtn.disabled = true;

            // Delete localities that are no longer in the table
            for (const locality of this.state.localities) {
                if (!changes.find(c => c.id === locality.id)) {
                    try {
                        await window.apiClient.request(`/networklocalities/${locality.id}`, { method: 'DELETE' });
                    } catch (error) {
                        console.error(`Failed to delete locality ${locality.id}:`, error);
                    }
                }
            }

            // Create or update localities
            for (const change of changes) {
                try {
                    if (change.id) {
                        // Update existing
                        const { id, ...updateData } = change;
                        await window.apiClient.request(`/networklocalities/${id}`, {
                            method: 'PATCH',
                            body: JSON.stringify(updateData)
                        });
                    } else {
                        // Create new
                        const response = await window.apiClient.request('/networklocalities', {
                            method: 'POST',
                            body: JSON.stringify(change)
                        });
                    }
                } catch (error) {
                    console.error(`Failed to save locality ${change.name}:`, error);
                }
            }

            alert('Network localities saved successfully');
            this.load(); // Reload to get fresh data

        } catch (error) {
            alert('Error saving changes: ' + error.message);
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
                const lines = csv.split('\n');
                const tbody = document.getElementById('localitiesTableBody');
                
                // Clear existing rows
                tbody.innerHTML = '';

                // Parse CSV (skip header)
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    const [name, description, vlans, subnets] = line.split(',').map(field => field.trim().replace(/"/g, ''));
                    
                    if (name) {
                        const locality = {
                            name: name,
                            description: description || '',
                            vlan_ids: vlans || '',
                            subnets: subnets || ''
                        };
                        
                        const row = this.createLocalityRow(locality);
                        tbody.appendChild(row);
                    }
                }

                this.showLocalitiesTable();

            } catch (error) {
                alert('Error parsing CSV: ' + error.message);
            }
        };

        reader.readAsText(file);
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
        
        // Delete button event delegation
        document.getElementById('localitiesTableBody').addEventListener('click', (e) => {
            if (e.target.classList.contains('delete-locality-btn')) {
                const row = e.target.closest('tr');
                if (confirm('Are you sure you want to delete this locality?')) {
                    row.remove();
                }
            }
        });
    }

    getTemplate() {
        return `
            <div class="mb-6">
                <h2 class="text-2xl font-bold" style="color: var(--sapphire);">Network Localities Manager</h2>
                <p class="mt-2" style="color: var(--text-muted);">Manage network locality entries for flow monitoring</p>
            </div>

            <!-- Controls -->
            <div class="mb-6 space-y-4">
                <div class="flex flex-wrap gap-4">
                    <button id="loadLocalities" class="btn-primary px-6 py-2 rounded font-semibold">
                        Load Network Localities
                    </button>
                    <button id="addLocalityRow" class="btn-secondary px-6 py-2 rounded font-semibold">
                        Add New Locality
                    </button>
                    <button id="saveLocalityChanges" class="btn-primary px-6 py-2 rounded font-semibold">
                        Save Changes
                    </button>
                </div>

                <!-- CSV Upload -->
                <div class="flex flex-wrap gap-4 items-center">
                    <label class="btn-secondary px-6 py-2 rounded font-semibold cursor-pointer">
                        Upload CSV
                        <input type="file" id="localityCsvInput" accept=".csv" class="hidden">
                    </label>
                    <span class="text-sm" style="color: var(--text-muted);">
                        CSV format: name, description, vlan_ids, subnets
                    </span>
                </div>
            </div>

            <!-- Loading State -->
            <div id="localitiesLoading" class="text-center py-20" style="display: none;">
                <div class="spinner mx-auto mb-4"></div>
                <p style="color: var(--text-muted);">Loading network localities...</p>
            </div>

            <!-- Network Localities Table -->
            <div id="localitiesTableContainer" class="table-container rounded-lg overflow-hidden" style="display: none;">
                <table id="localitiesTable">
                    <thead>
                        <tr>
                            <th width="200">Name</th>
                            <th width="300">Description</th>
                            <th width="150">VLAN IDs</th>
                            <th>Subnets</th>
                            <th width="100">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="localitiesTableBody">
                        <!-- Populated dynamically -->
                    </tbody>
                </table>
            </div>

            <!-- Actions -->
            <div id="localitiesActions" class="mt-6 flex gap-3" style="display: none;">
                <button id="addLocalityRow2" class="btn-secondary px-4 py-2 rounded">
                    Add Row
                </button>
                <button id="saveLocalityChanges2" class="btn-primary px-4 py-2 rounded font-semibold">
                    Save All Changes
                </button>
            </div>
        `;
    }

    activate() {
        // Setup event listeners when module is activated
        this.setupEventListeners();
        
        // Set module title
        document.getElementById('ribbonModuleTitle').textContent = 'Network Localities';
    }

    deactivate() {
        // Clean up when switching modules
        this.state.localities = [];
        document.getElementById('localitiesTableContainer').style.display = 'none';
        document.getElementById('localitiesActions').style.display = 'none';
    }
}

// Export for global use
window.NetworkLocalities = NetworkLocalities;