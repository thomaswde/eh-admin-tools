// Network Localities Module

const localitiesState = {
    currentLocalities: [],   // Working copy with edits
    deletedIds: new Set(),   // Track deleted entries
    selectedKeys: new Set(),
    filterTerm: '',
    isLoaded: false,
    page: 0,
    pageSize: 200,
    importJobs: [],
    selectedImportJobId: null,
    importPollTimer: null
};

const LOCALITY_CSV_MAX_BYTES = 25 * 1024 * 1024;
const LOCALITY_IMPORT_TERMINAL_STATES = new Set([
    'completed', 'completed_with_errors', 'failed', 'timed_out', 'cancelled', 'interrupted'
]);

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
    localitiesState.selectedKeys.clear();
    localitiesState.page = 0;
    localitiesState.isLoaded = true;
}

function localitySelectionKey(locality) {
    if (locality.id != null && locality.id !== '') return `id:${String(locality.id)}`;
    return `draft:${String(locality._clientId || '')}`;
}

function localityMatchesFilter(locality) {
    const term = localitiesState.filterTerm.trim().toLowerCase();
    if (!term) return true;
    return [
        locality.name,
        ...(locality.networks || []),
        locality.external ? 'external' : 'internal',
        locality.description,
        locality.id
    ].some(value => String(value || '').toLowerCase().includes(term));
}

function getFilteredLocalityEntries() {
    return localitiesState.currentLocalities
        .map((locality, index) => ({ locality, index }))
        .filter(({ locality }) => !locality._deleted && localityMatchesFilter(locality));
}

function getVisibleLocalityEntries() {
    const filtered = getFilteredLocalityEntries();
    const pageCount = Math.max(1, Math.ceil(filtered.length / localitiesState.pageSize));
    localitiesState.page = Math.min(Math.max(0, localitiesState.page), pageCount - 1);
    const start = localitiesState.page * localitiesState.pageSize;
    return filtered.slice(start, start + localitiesState.pageSize);
}

function pruneLocalitySelection() {
    const selectableKeys = new Set(
        localitiesState.currentLocalities
            .filter(locality => !locality._deleted)
            .map(localitySelectionKey)
    );
    localitiesState.selectedKeys.forEach(key => {
        if (!selectableKeys.has(key)) localitiesState.selectedKeys.delete(key);
    });
}

function updateLocalitySelectionUi() {
    pruneLocalitySelection();
    const filteredEntries = getFilteredLocalityEntries();
    const visibleEntries = getVisibleLocalityEntries();
    const activeCount = localitiesState.currentLocalities.filter(locality => !locality._deleted).length;
    const visibleKeys = visibleEntries.map(({ locality }) => localitySelectionKey(locality));
    const selectedVisibleCount = visibleKeys.filter(key => localitiesState.selectedKeys.has(key)).length;
    const selectAll = document.getElementById('selectAllLocalities');
    const bulkActions = document.getElementById('localitiesBulkActions');
    const selectedCount = document.getElementById('selectedLocalitiesCount');
    const filterCount = document.getElementById('localitiesFilterCount');
    const pageSummary = document.getElementById('localitiesPageSummary');
    const previousPage = document.getElementById('previousLocalitiesPage');
    const nextPage = document.getElementById('nextLocalitiesPage');

    if (selectAll) {
        selectAll.checked = visibleKeys.length > 0 && selectedVisibleCount === visibleKeys.length;
        selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleKeys.length;
        selectAll.disabled = visibleKeys.length === 0;
    }
    if (bulkActions) {
        bulkActions.style.display = localitiesState.selectedKeys.size > 0 ? 'flex' : 'none';
    }
    if (selectedCount) {
        selectedCount.textContent = `${localitiesState.selectedKeys.size} selected`;
    }
    if (filterCount) {
        filterCount.textContent = `${filteredEntries.length} of ${activeCount} localit${activeCount === 1 ? 'y' : 'ies'} match`;
    }
    const pageCount = Math.max(1, Math.ceil(filteredEntries.length / localitiesState.pageSize));
    if (pageSummary) {
        const first = filteredEntries.length ? localitiesState.page * localitiesState.pageSize + 1 : 0;
        const last = filteredEntries.length
            ? Math.min(filteredEntries.length, first + visibleEntries.length - 1)
            : 0;
        pageSummary.textContent = `${first.toLocaleString()}–${last.toLocaleString()} of ${filteredEntries.length.toLocaleString()}`;
    }
    if (previousPage) {
        previousPage.disabled = localitiesState.page === 0;
    }
    if (nextPage) {
        nextPage.disabled = localitiesState.page >= pageCount - 1;
    }
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
        document.getElementById('filterLocalities').style.display = 'inline-block';
        document.getElementById('localitiesFilterCount').style.display = 'inline';
        document.getElementById('localitiesPagination').style.display = 'flex';

        showLocalityStatus(`Loaded ${response.length} network localities`, 'success');
    } catch (error) {
        document.getElementById('localitiesLoading').style.display = 'none';
        showLocalityStatus(`Error loading localities: ${error.message}`, 'error');
    }
}

function renderLocalitiesTable() {
    const tbody = document.getElementById('localitiesTableBody');
    tbody.innerHTML = '';
    const visibleEntries = getVisibleLocalityEntries();

    visibleEntries.forEach(({ locality, index }) => {
        const row = document.createElement('tr');
        row.dataset.index = index;
        row.dataset.id = locality.id || '';
        const selectionKey = localitySelectionKey(locality);
        
        row.innerHTML = `
            <td class="col-check">
                <input type="checkbox" class="locality-checkbox"
                       data-selection-key="${escapeAttribute(selectionKey)}"
                       aria-label="Select ${escapeAttribute(locality.name || 'new locality')}"
                       ${localitiesState.selectedKeys.has(selectionKey) ? 'checked' : ''}>
            </td>
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

    if (visibleEntries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6"><div class="empty-inline">No network localities match the current filter</div></td></tr>';
    }

    // Add event listeners for inline editing
    document.querySelectorAll('.locality-field').forEach(input => {
        input.addEventListener('change', handleLocalityFieldChange);
    });

    // Add event listeners for delete buttons
    document.querySelectorAll('.delete-locality-btn').forEach(btn => {
        btn.addEventListener('click', handleDeleteLocality);
    });

    document.querySelectorAll('.locality-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', handleLocalitySelectionChange);
    });
    updateLocalitySelectionUi();
}

function handleLocalitySelectionChange(e) {
    const key = e.target.dataset.selectionKey;
    if (e.target.checked) {
        localitiesState.selectedKeys.add(key);
    } else {
        localitiesState.selectedKeys.delete(key);
    }
    updateLocalitySelectionUi();
}

function handleSelectAllLocalities(e) {
    getVisibleLocalityEntries().forEach(({ locality }) => {
        const key = localitySelectionKey(locality);
        if (e.target.checked) {
            localitiesState.selectedKeys.add(key);
        } else {
            localitiesState.selectedKeys.delete(key);
        }
    });
    renderLocalitiesTable();
}

function handleLocalityFilter(e) {
    localitiesState.filterTerm = e.target.value;
    localitiesState.page = 0;
    renderLocalitiesTable();
}

function changeLocalitiesPage(delta) {
    localitiesState.page = Math.max(0, localitiesState.page + delta);
    renderLocalitiesTable();
    document.getElementById('localitiesTable')?.scrollIntoView({ block: 'start' });
}

function clearLocalitySelection() {
    localitiesState.selectedKeys.clear();
    renderLocalitiesTable();
}

function stageLocalitiesForDeletion(selectionKeys) {
    const selected = new Set(selectionKeys);
    let staged = 0;
    localitiesState.currentLocalities.forEach(locality => {
        if (!selected.has(localitySelectionKey(locality)) || locality._deleted) return;
        if (locality.id != null && locality.id !== '') {
            localitiesState.deletedIds.add(String(locality.id));
        }
        locality._deleted = true;
        staged++;
    });
    selected.forEach(key => localitiesState.selectedKeys.delete(key));
    return staged;
}

function handleBulkDeleteLocalities() {
    const selectionKeys = Array.from(localitiesState.selectedKeys);
    if (selectionKeys.length === 0) return;

    const noun = selectionKeys.length === 1 ? 'locality' : 'localities';
    if (!confirm(
        `Stage ${selectionKeys.length} selected ${noun} for deletion? ` +
        'Existing localities are not deleted until you click Save Changes.'
    )) {
        return;
    }

    const staged = stageLocalitiesForDeletion(selectionKeys);
    renderLocalitiesTable();
    showLocalityStatus(
        `Staged ${staged} ${staged === 1 ? 'locality' : 'localities'} for deletion. Click Save Changes to apply.`,
        'warning'
    );
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
    
    stageLocalitiesForDeletion([localitySelectionKey(locality)]);
    renderLocalitiesTable();
}

function addLocalityRow() {
    localitiesState.filterTerm = '';
    const filterInput = document.getElementById('filterLocalities');
    if (filterInput) filterInput.value = '';
    const newLocality = {
        name: '',
        networks: [],
        external: false,
        description: '',
        _isNew: true,
        _clientId: createLocalityDraftId()
    };
    
    localitiesState.currentLocalities.push(newLocality);
    const activeCount = localitiesState.currentLocalities.filter(locality => !locality._deleted).length;
    localitiesState.page = Math.max(0, Math.ceil(activeCount / localitiesState.pageSize) - 1);
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
        localitiesState.selectedKeys.clear();
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

async function handleCsvUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    if (file.size > LOCALITY_CSV_MAX_BYTES) {
        showLocalityStatus('CSV exceeds the 25 MiB upload limit.', 'error');
        return;
    }
    if (!confirm(
        `Import "${file.name}" now? CSV imports apply valid, non-duplicate rows immediately. ` +
        'Every row will be recorded in a downloadable outcome CSV.'
    )) {
        return;
    }

    const label = document.getElementById('uploadCsvLabel');
    if (label) label.classList.add('disabled');
    try {
        const job = await window.apiClient.createNetworkLocalityImport(file);
        localitiesState.selectedImportJobId = job.id;
        showLocalityStatus(`Import started for ${file.name}.`, 'success');
        await loadLocalityImportJobs(job.id);
        scheduleLocalityImportPoll(job.id);
    } catch (error) {
        showLocalityStatus(`Could not start CSV import: ${error.message}`, 'error');
    } finally {
        if (label) label.classList.remove('disabled');
    }
}

function localityImportOutcomeText(job) {
    const counts = job?.counts || {};
    const parts = [
        `Created ${Number(counts.created || 0).toLocaleString()}`,
        `Failed ${Number(counts.failed || 0).toLocaleString()}`,
        `Skipped ${Number(counts.skipped || 0).toLocaleString()}`,
        `Invalid ${Number(counts.invalid || 0).toLocaleString()}`,
        `Unknown ${Number(counts.unknown || 0).toLocaleString()}`
    ];
    if (job?.notAttempted) parts.push(`Not attempted ${Number(job.notAttempted).toLocaleString()}`);
    return parts.join(' · ');
}

function renderLocalityImportJob(job) {
    const panel = document.getElementById('localityImportPanel');
    if (!panel) return;
    panel.style.display = job ? 'block' : 'none';
    if (!job) return;
    const processed = Number(job.processedRows || 0);
    const total = Number(job.totalRows || 0);
    const progress = document.getElementById('localityImportProgress');
    const status = document.getElementById('localityImportStatus');
    const summary = document.getElementById('localityImportSummary');
    const download = document.getElementById('downloadLocalityImportResults');
    const cancelButton = document.getElementById('cancelLocalityImport');
    if (progress) {
        progress.max = Math.max(1, total);
        progress.value = processed;
    }
    if (status) {
        status.textContent = `${job.filename} — ${job.state.replaceAll('_', ' ')}. ${job.message || ''}`;
    }
    if (summary) {
        summary.textContent = `${processed.toLocaleString()} of ${total.toLocaleString()} rows tracked · ${localityImportOutcomeText(job)}`;
    }
    if (download) {
        download.href = job.resultsUrl;
        download.removeAttribute('aria-disabled');
    }
    if (cancelButton) {
        cancelButton.style.display = LOCALITY_IMPORT_TERMINAL_STATES.has(job.state) ? 'none' : 'inline-block';
    }
}

function renderLocalityImportHistory() {
    const select = document.getElementById('localityImportHistory');
    if (!select) return;
    select.innerHTML = '';
    localitiesState.importJobs.forEach(job => {
        const option = document.createElement('option');
        option.value = job.id;
        const created = job.createdAt ? new Date(job.createdAt).toLocaleString() : 'Unknown time';
        option.textContent = `${created} — ${job.filename} — ${job.state.replaceAll('_', ' ')}`;
        select.appendChild(option);
    });
    const selected = localitiesState.importJobs.find(job => job.id === localitiesState.selectedImportJobId)
        || localitiesState.importJobs[0]
        || null;
    localitiesState.selectedImportJobId = selected?.id || null;
    if (selected) select.value = selected.id;
    renderLocalityImportJob(selected);
}

async function loadLocalityImportJobs(preferredJobId = null) {
    if (!state.connected || !window.apiClient) return;
    try {
        const response = await window.apiClient.listNetworkLocalityImports();
        localitiesState.importJobs = Array.isArray(response.jobs) ? response.jobs : [];
        if (preferredJobId) localitiesState.selectedImportJobId = preferredJobId;
        renderLocalityImportHistory();
    } catch (error) {
        console.warn('Could not load network locality import history:', error);
    }
}

async function pollLocalityImport(jobId) {
    if (!state.connected || !window.apiClient || localitiesState.selectedImportJobId !== jobId) return;
    try {
        const job = await window.apiClient.getNetworkLocalityImport(jobId);
        const index = localitiesState.importJobs.findIndex(item => item.id === job.id);
        if (index === -1) localitiesState.importJobs.unshift(job);
        else localitiesState.importJobs[index] = job;
        renderLocalityImportHistory();
        if (!LOCALITY_IMPORT_TERMINAL_STATES.has(job.state)) scheduleLocalityImportPoll(jobId);
    } catch (error) {
        console.warn('Could not refresh network locality import:', error);
    }
}

function scheduleLocalityImportPoll(jobId) {
    stopLocalityImportPolling();
    localitiesState.importPollTimer = setTimeout(() => pollLocalityImport(jobId), 1000);
}

function stopLocalityImportPolling() {
    if (localitiesState.importPollTimer) clearTimeout(localitiesState.importPollTimer);
    localitiesState.importPollTimer = null;
}

function handleLocalityImportHistoryChange(e) {
    stopLocalityImportPolling();
    localitiesState.selectedImportJobId = e.target.value;
    const job = localitiesState.importJobs.find(item => item.id === e.target.value);
    renderLocalityImportJob(job || null);
    if (job && !LOCALITY_IMPORT_TERMINAL_STATES.has(job.state)) scheduleLocalityImportPoll(job.id);
}

async function cancelSelectedLocalityImport() {
    const jobId = localitiesState.selectedImportJobId;
    if (!jobId || !confirm('Cancel this import? Completed row outcomes will remain available for export.')) return;
    try {
        await window.apiClient.cancelNetworkLocalityImport(jobId);
        await loadLocalityImportJobs(jobId);
    } catch (error) {
        showLocalityStatus(`Could not cancel import: ${error.message}`, 'error');
    }
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
    if (state.connected) {
        await loadLocalityImportJobs();
        const activeJob = localitiesState.importJobs.find(job => !LOCALITY_IMPORT_TERMINAL_STATES.has(job.state));
        if (activeJob) {
            localitiesState.selectedImportJobId = activeJob.id;
            renderLocalityImportHistory();
            scheduleLocalityImportPoll(activeJob.id);
        }
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
        document.getElementById('filterLocalities').addEventListener('input', handleLocalityFilter);
        document.getElementById('selectAllLocalities').addEventListener('change', handleSelectAllLocalities);
        document.getElementById('bulkDeleteLocalities').addEventListener('click', handleBulkDeleteLocalities);
        document.getElementById('clearLocalitySelection').addEventListener('click', clearLocalitySelection);
        document.getElementById('previousLocalitiesPage').addEventListener('click', () => changeLocalitiesPage(-1));
        document.getElementById('nextLocalitiesPage').addEventListener('click', () => changeLocalitiesPage(1));
        document.getElementById('localityImportHistory').addEventListener('change', handleLocalityImportHistoryChange);
        document.getElementById('cancelLocalityImport').addEventListener('click', cancelSelectedLocalityImport);
        
        document.getElementById('loadLocalities').setAttribute('data-listener-added', 'true');
    }
}

if (typeof featureRegistry !== 'undefined') {
    featureRegistry.register('localities', {
        initialize: initLocalitiesModule,
        activate: activateLocalitiesModule,
        cancel: stopLocalityImportPolling
    });
}
