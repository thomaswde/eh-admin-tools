// Network Localities Module

const localitiesState = {
    originalLocalities: [],  // Original data from GET
    currentLocalities: [],   // Working copy with edits
    deletedIds: new Set(),   // Track deleted entries
    isLoaded: false
};

// API Functions for Network Localities
async function loadNetworkLocalities() {
    if (!state.connected || !window.apiClient) {
        alert('Please connect to your ExtraHop instance first');
        return;
    }

    try {
        document.getElementById('localitiesLoading').style.display = 'block';
        document.getElementById('localitiesTable').style.display = 'none';
        document.getElementById('localityStatus').style.display = 'none';

        const response = await window.apiClient.request('/networklocalities');
        
        localitiesState.originalLocalities = response.map(loc => ({...loc}));
        localitiesState.currentLocalities = response.map(loc => ({...loc}));
        localitiesState.deletedIds.clear();
        localitiesState.isLoaded = true;

        renderLocalitiesTable();
        
        document.getElementById('localitiesLoading').style.display = 'none';
        document.getElementById('localitiesTable').style.display = 'block';
        document.getElementById('addLocalityRow').style.display = 'inline-block';
        document.getElementById('saveLocalityChanges').style.display = 'inline-block';
        document.getElementById('uploadCsvLabel').style.display = 'inline-block';

        showLocalityStatus(`Loaded ${response.length} network localities`, 'success');
    } catch (error) {
        document.getElementById('localitiesLoading').style.display = 'none';
        showLocalityStatus(`Error loading localities: ${error.message}`, 'error');
    }
}

function renderLocalitiesTable() {
    const tbody = document.getElementById('localitiesTableBody');
    tbody.innerHTML = '';

    localitiesState.currentLocalities.forEach((locality, index) => {
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
                       value="${escapeHtml(locality.name || '')}"
                       style="background-color: var(--bg-input); border-color: var(--border-color); color: var(--text-primary);">
            </td>
            <td>
                <input type="text" 
                       class="w-full px-2 py-1 border rounded locality-field" 
                       data-field="networks" 
                       value="${escapeHtml((locality.networks || []).join(', '))}"
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
                       value="${escapeHtml(locality.description || '')}"
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
        input.addEventListener('change', handleLocalityFieldChange);
    });

    // Add event listeners for delete buttons
    document.querySelectorAll('.delete-locality-btn').forEach(btn => {
        btn.addEventListener('click', handleDeleteLocality);
    });
}

function handleLocalityFieldChange(e) {
    const field = e.target.dataset.field;
    const row = e.target.closest('tr');
    const index = parseInt(row.dataset.index);
    
    let value = e.target.value;
    
    if (field === 'external') {
        value = value === 'true';
    } else if (field === 'networks') {
        // Convert comma-separated string to array
        value = value.split(',').map(s => s.trim()).filter(s => s);
    }
    
    localitiesState.currentLocalities[index][field] = value;
    localitiesState.currentLocalities[index]._modified = true;
}

function handleDeleteLocality(e) {
    const row = e.target.closest('tr');
    const index = parseInt(row.dataset.index);
    const id = row.dataset.id;
    
    if (id) {
        // Existing locality - mark for deletion
        localitiesState.deletedIds.add(parseInt(id));
    }
    
    // Mark as deleted in current state
    localitiesState.currentLocalities[index]._deleted = true;
    
    renderLocalitiesTable();
}

function addLocalityRow() {
    const newLocality = {
        name: '',
        networks: [],
        external: false,
        description: '',
        _isNew: true
    };
    
    localitiesState.currentLocalities.push(newLocality);
    renderLocalitiesTable();
    
    // Focus on the name field of the new row
    setTimeout(() => {
        const lastRow = document.querySelector('#localitiesTableBody tr:last-child');
        if (lastRow) {
            lastRow.querySelector('input[data-field="name"]')?.focus();
        }
    }, 100);
}

async function saveLocalityChanges() {
    try {
        document.getElementById('saveLocalityChanges').disabled = true;
        document.getElementById('saveLocalityChanges').textContent = 'Saving...';
        
        const results = {
            created: [],
            updated: [],
            deleted: [],
            errors: []
        };

        // Process deletions
        for (const id of localitiesState.deletedIds) {
            try {
                await window.apiClient.request(`/networklocalities/${id}`, { method: 'DELETE' });
                results.deleted.push(id);
            } catch (error) {
                results.errors.push(`Failed to delete locality ID ${id}: ${error.message}`);
            }
        }

        // Process creations and updates
        for (const locality of localitiesState.currentLocalities) {
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
        if (results.created.length > 0) statusMsg.push(`Created: ${results.created.length}`);
        if (results.updated.length > 0) statusMsg.push(`Updated: ${results.updated.length}`);
        if (results.deleted.length > 0) statusMsg.push(`Deleted: ${results.deleted.length}`);
        if (results.errors.length > 0) statusMsg.push(`Errors: ${results.errors.length}`);

        showLocalityStatus(statusMsg.join(' | '), results.errors.length > 0 ? 'warning' : 'success');

        if (results.errors.length > 0) {
            console.error('Errors during save:', results.errors);
            alert('Some operations failed. Check the console for details.\n\n' + results.errors.join('\n'));
        }

        // Reload localities to get fresh data
        await loadNetworkLocalities();

    } catch (error) {
        showLocalityStatus(`Error saving changes: ${error.message}`, 'error');
    } finally {
        document.getElementById('saveLocalityChanges').disabled = false;
        document.getElementById('saveLocalityChanges').textContent = 'Save Changes';
    }
}

function handleCsvUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
        try {
            const csv = event.target.result;
            const lines = csv.split('\n').map(line => line.trim()).filter(line => line);
            
            if (lines.length < 2) {
                throw new Error('CSV file appears to be empty');
            }

            // Parse header
            const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
            const nameIdx = header.findIndex(h => h.toLowerCase().includes('name'));
            const cidrIdx = header.findIndex(h => h.toLowerCase().includes('cidr') || h.toLowerCase().includes('ip') || h.toLowerCase().includes('network'));
            const externalIdx = header.findIndex(h => h.toLowerCase().includes('external') || h.toLowerCase().includes('type'));
            const descIdx = header.findIndex(h => h.toLowerCase().includes('description') || h.toLowerCase().includes('desc'));

            if (nameIdx === -1 || cidrIdx === -1) {
                throw new Error('CSV must contain Name and CIDR/Network columns');
            }

            // Parse rows
            const newLocalities = [];
            const duplicates = [];

            for (let i = 1; i < lines.length; i++) {
                const cols = parseCSVLine(lines[i]);
                
                const name = cols[nameIdx]?.trim();
                const cidrs = cols[cidrIdx]?.split(',').map(s => s.trim()).filter(s => s) || [];
                const externalStr = externalIdx !== -1 ? cols[externalIdx]?.trim().toLowerCase() : 'false';
                const external = ['true', 'external', '1', 'yes'].includes(externalStr);
                const description = descIdx !== -1 ? cols[descIdx]?.trim() : '';

                if (!name || cidrs.length === 0) {
                    console.warn(`Skipping row ${i + 1}: missing name or CIDR`);
                    continue;
                }

                // Check for duplicates in existing localities
                const isDuplicateName = localitiesState.currentLocalities.some(
                    loc => !loc._deleted && loc.name.toLowerCase() === name.toLowerCase()
                );
                const isDuplicateCidr = localitiesState.currentLocalities.some(
                    loc => !loc._deleted && loc.networks && loc.networks.some(net => cidrs.includes(net))
                );

                if (isDuplicateName || isDuplicateCidr) {
                    duplicates.push({ name, cidrs: cidrs.join(', '), reason: isDuplicateName ? 'name' : 'CIDR' });
                    continue;
                }

                newLocalities.push({
                    name,
                    networks: cidrs,
                    external,
                    description,
                    _isNew: true
                });
            }

            // Add new localities to current state
            localitiesState.currentLocalities.push(...newLocalities);
            renderLocalitiesTable();

            // Show status
            let msg = `Loaded ${newLocalities.length} localities from CSV`;
            if (duplicates.length > 0) {
                msg += ` (${duplicates.length} duplicates skipped)`;
                console.warn('Duplicate localities skipped:', duplicates);
            }
            showLocalityStatus(msg, duplicates.length > 0 ? 'warning' : 'success');

            // Show duplicate report if any
            if (duplicates.length > 0) {
                const report = duplicates.map(d => `${d.name} (${d.reason} collision)`).join('\n');
                alert(`Duplicate Detection Report:\n\n${report}\n\nThese entries were not added. Please review and modify if needed.`);
            }

        } catch (error) {
            showLocalityStatus(`Error parsing CSV: ${error.message}`, 'error');
        }
    };
    reader.readAsText(file);
    
    // Reset file input
    e.target.value = '';
}

function parseCSVLine(line) {
    // Simple CSV parser that handles quoted fields
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

function showLocalityStatus(message, type = 'success') {
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

// Network Localities module initialization function
function initLocalitiesModule() {
    console.log('Initializing Network Localities module');
    
    // Set up event listeners specific to localities module
    if (!document.getElementById('loadLocalities').hasAttribute('data-listener-added')) {
        document.getElementById('loadLocalities').addEventListener('click', loadNetworkLocalities);
        document.getElementById('addLocalityRow').addEventListener('click', addLocalityRow);
        document.getElementById('saveLocalityChanges').addEventListener('click', saveLocalityChanges);
        document.getElementById('uploadCsv').addEventListener('change', handleCsvUpload);
        
        document.getElementById('loadLocalities').setAttribute('data-listener-added', 'true');
    }
}