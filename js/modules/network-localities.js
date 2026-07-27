// Network Localities Module

const localitiesState = {
    currentLocalities: [],   // Working copy with edits
    deletedIds: new Set(),   // Track deleted entries
    isLoaded: false
};

let nextLocalityDraftId = 1;

function createLocalityDraftId() {
    return `locality-draft-${nextLocalityDraftId++}`;
}

function cloneLocality(locality) {
    return {
        ...locality,
        networks: Array.isArray(locality.networks) ? [...locality.networks] : []
    };
}

function replaceLocalityState(localities) {
    localitiesState.currentLocalities = localities.map(cloneLocality);
    localitiesState.deletedIds.clear();
    localitiesState.isLoaded = true;
}

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
        
        replaceLocalityState(response);

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
        
        row.innerHTML = `
            <td>
                <input type="text" class="locality-field" data-field="name"
                       value="${escapeAttribute(locality.name || '')}">
            </td>
            <td>
                <input type="text" class="locality-field" data-field="networks"
                       value="${escapeAttribute((locality.networks || []).join(', '))}"
                       placeholder="e.g. 192.168.1.0/24, 10.0.0.1">
            </td>
            <td>
                <select class="locality-field" data-field="external">
                    <option value="false" ${!locality.external ? 'selected' : ''}>Internal</option>
                    <option value="true" ${locality.external ? 'selected' : ''}>External</option>
                </select>
            </td>
            <td>
                <input type="text" class="locality-field" data-field="description"
                       value="${escapeAttribute(locality.description || '')}">
            </td>
            <td class="actions">
                <button class="btn-danger btn-sm delete-locality-btn">Delete</button>
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
    const locality = localitiesState.currentLocalities[index];
    const label = locality.name || (id ? `ID ${id}` : 'this new row');

    if (!confirm(`Stage "${label}" for deletion? The deletion is not sent until you click Save Changes.`)) {
        return;
    }
    
    if (id) {
        // Existing locality - mark for deletion
        localitiesState.deletedIds.add(id);
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
        _isNew: true,
        _clientId: createLocalityDraftId()
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

function reconcileCreatedLocality(locality, response) {
    const index = localitiesState.currentLocalities.indexOf(locality);
    if (index === -1) return;

    if (response && response.id != null) {
        localitiesState.currentLocalities[index] = {
            ...cloneLocality(response),
            _clientId: locality._clientId
        };
        return;
    }

    // POST is documented to return 201 without a response schema. If no identity
    // is returned, remove the completed draft so a retry cannot create it again.
    localitiesState.currentLocalities.splice(index, 1);
}

function reconcileUpdatedLocality(locality, response) {
    if (response && typeof response === 'object' && response.id != null) {
        Object.assign(locality, cloneLocality(response));
    }
    delete locality._modified;
}

function reconcileDeletedLocality(id) {
    localitiesState.deletedIds.delete(id);
    localitiesState.currentLocalities = localitiesState.currentLocalities.filter(
        locality => String(locality.id) !== String(id)
    );
}

function localityDraftMatches(authoritative, draft) {
    const normalizedNetworks = locality => [...(locality.networks || [])].map(String).sort();
    return String(authoritative.name || '') === String(draft.name || '')
        && JSON.stringify(normalizedNetworks(authoritative)) === JSON.stringify(normalizedNetworks(draft))
        && Boolean(authoritative.external) === Boolean(draft.external)
        && String(authoritative.description || '') === String(draft.description || '');
}

function reapplyUnresolvedLocalityDrafts(authoritative, unresolved) {
    const current = authoritative.map(cloneLocality);
    const byId = new Map(current.map((locality, index) => [String(locality.id), index]));
    const deletedIds = new Set();

    unresolved.updates.forEach(draft => {
        const index = byId.get(String(draft.id));
        if (index == null) return;
        if (localityDraftMatches(current[index], draft)) return;
        current[index] = {
            ...current[index],
            ...cloneLocality(draft),
            _modified: true
        };
    });

    unresolved.deletes.forEach(id => {
        const index = byId.get(String(id));
        if (index == null) return;
        current[index]._deleted = true;
        deletedIds.add(id);
    });

    unresolved.creates.forEach(draft => {
        if (current.some(locality => localityDraftMatches(locality, draft))) return;
        current.push({
            ...cloneLocality(draft),
            _isNew: true,
            _clientId: draft._clientId || createLocalityDraftId()
        });
    });

    localitiesState.currentLocalities = current;
    localitiesState.deletedIds = deletedIds;
    localitiesState.isLoaded = true;
}

async function reloadLocalitiesPreservingUnresolved(unresolved) {
    const authoritative = await window.apiClient.request('/networklocalities');
    reapplyUnresolvedLocalityDrafts(authoritative, unresolved);
}

async function saveLocalityChanges() {
    const invalidLocalities = localitiesState.currentLocalities.filter(locality =>
        !locality._deleted &&
        (!locality.name || !Array.isArray(locality.networks) || locality.networks.length === 0)
    );
    if (invalidLocalities.length > 0) {
        showLocalityStatus('Fix incomplete rows before saving. Name and at least one network are required.', 'error');
        alert('Nothing was changed. Fix all incomplete rows before saving.');
        return;
    }

    if (
        localitiesState.deletedIds.size > 0 &&
        !confirm(`Save all changes and permanently delete ${localitiesState.deletedIds.size} existing localit${localitiesState.deletedIds.size === 1 ? 'y' : 'ies'}?`)
    ) {
        return;
    }

    try {
        document.getElementById('saveLocalityChanges').disabled = true;
        document.getElementById('saveLocalityChanges').textContent = 'Saving...';
        
        const results = {
            created: [],
            updated: [],
            deleted: [],
            errors: [],
            reconciliationError: null
        };
        const unresolved = { creates: [], updates: [], deletes: [] };
        const pendingSaves = localitiesState.currentLocalities.filter(locality => !locality._deleted);
        const pendingDeletes = Array.from(localitiesState.deletedIds);

        // Process creations and updates
        for (const locality of pendingSaves) {
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
                    reconcileCreatedLocality(locality, response);
                } else if (locality._modified && locality.id) {
                    // Update existing locality
                    await window.apiClient.request(`/networklocalities/${locality.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify(payload)
                    });
                    results.updated.push(locality.name);
                    reconcileUpdatedLocality(locality);
                }
            } catch (error) {
                results.errors.push(`Failed to save "${locality.name}": ${error.message}`);
                if (locality._isNew && !locality.id) {
                    unresolved.creates.push(cloneLocality(locality));
                } else if (locality._modified && locality.id) {
                    unresolved.updates.push(cloneLocality(locality));
                }
            }
        }

        // Apply destructive changes last, after all rows have passed validation.
        for (const id of pendingDeletes) {
            try {
                await window.apiClient.request(`/networklocalities/${id}`, { method: 'DELETE' });
                results.deleted.push(id);
                reconcileDeletedLocality(id);
            } catch (error) {
                results.errors.push(`Failed to delete locality ID ${id}: ${error.message}`);
                unresolved.deletes.push(id);
            }
        }

        const successfulMutationCount = results.created.length + results.updated.length + results.deleted.length;
        if (successfulMutationCount > 0) {
            try {
                await reloadLocalitiesPreservingUnresolved(unresolved);
            } catch (error) {
                results.reconciliationError = `Could not reload authoritative localities: ${error.message}`;
                results.errors.push(results.reconciliationError);
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

        renderLocalitiesTable();

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
            const importedRows = parseNetworkLocalitiesCsv(event.target.result);

            // Parse rows
            const newLocalities = [];
            const duplicates = [];

            for (const imported of importedRows) {
                const { name, cidrs, external, description, rowNumber } = imported;

                if (!name || cidrs.length === 0) {
                    console.warn(`Skipping row ${rowNumber}: missing name or CIDR`);
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
                    _isNew: true,
                    _clientId: createLocalityDraftId()
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

function parseNetworkLocalitiesCsv(csvText) {
    const rows = CsvUtils.parseRows(csvText, { skipEmptyRows: true });
    if (rows.length < 2) throw new Error('CSV file appears to be empty');
    const header = rows[0].map(value => value.trim().toLowerCase());
    const nameIdx = header.findIndex(value => value.includes('name'));
    const cidrIdx = header.findIndex(value => value.includes('cidr') || value.includes('ip') || value.includes('network'));
    const externalIdx = header.findIndex(value => value.includes('external') || value.includes('type'));
    const descIdx = header.findIndex(value => value.includes('description') || value.includes('desc'));
    if (nameIdx === -1 || cidrIdx === -1) {
        throw new Error('CSV must contain Name and CIDR/Network columns');
    }
    return rows.slice(1).map((columns, index) => {
        const externalValue = externalIdx === -1 ? 'false' : String(columns[externalIdx] ?? '').trim().toLowerCase();
        return {
            name: String(columns[nameIdx] ?? '').trim(),
            cidrs: String(columns[cidrIdx] ?? '').split(',').map(value => value.trim()).filter(Boolean),
            external: ['true', 'external', '1', 'yes'].includes(externalValue),
            description: descIdx === -1 ? '' : String(columns[descIdx] ?? '').trim(),
            rowNumber: index + 2
        };
    });
}

function showLocalityStatus(message, type = 'success') {
    const statusDiv = document.getElementById('localityStatus');
    const statusText = document.getElementById('localityStatusText');
    
    statusDiv.style.display = 'block';
    statusText.textContent = message;
    
    const colors = {
        success: { bg: 'var(--ok-bg)', border: 'var(--ok-border)', text: 'var(--ok-text)' },
        warning: { bg: 'var(--warn-bg)', border: 'var(--warn-border)', text: 'var(--warn)' },
        error: { bg: 'var(--danger-bg)', border: 'var(--danger-border)', text: 'var(--danger-text)' }
    };
    
    const color = colors[type] || colors.success;
    statusDiv.querySelector('div').style.backgroundColor = color.bg;
    statusDiv.querySelector('div').style.borderColor = color.border;
    statusText.style.color = color.text;
    
    setTimeout(() => {
        statusDiv.style.display = 'none';
    }, 5000);
}

// Network Localities module activation function (called when module is shown)
async function activateLocalitiesModule() {
    console.log('Activating Network Localities module');
    
    // Auto-load existing localities on first activation when connected
    if (state.connected && !localitiesState.isLoaded) {
        await loadNetworkLocalities();
    }
}

// Network Localities module initialization function
function initLocalitiesModule() {
    console.log('Initializing Network Localities module');
    
    // Set up event listeners specific to localities module
    if (!document.getElementById('loadLocalities').hasAttribute('data-listener-added')) {
        document.getElementById('loadLocalities').addEventListener('click', loadNetworkLocalities);
        document.getElementById('addLocalityRow').addEventListener('click', addLocalityRow);
        document.getElementById('saveLocalityChanges').addEventListener('click', saveLocalityChanges);
        document.getElementById('localityCsvInput').addEventListener('change', handleCsvUpload);
        
        document.getElementById('loadLocalities').setAttribute('data-listener-added', 'true');
    }
}

if (typeof featureRegistry !== 'undefined') {
    featureRegistry.register('localities', {
        initialize: initLocalitiesModule,
        activate: activateLocalitiesModule
    });
}
