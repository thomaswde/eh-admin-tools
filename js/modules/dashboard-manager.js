// Dashboard Manager Module

const DASHBOARD_USAGE_LOOKBACK_DAYS = 365;
const DASHBOARD_USAGE_FILTER_DAYS = new Set(['30', '90', '180', '365']);

const dashboardUsageState = {
    status: 'not_loaded',
    fromMs: null,
    untilMs: null,
    lookbackDays: DASHBOARD_USAGE_LOOKBACK_DAYS,
    cycle: 'auto',
    notice: '',
    error: ''
};

const dashboardMutationState = {
    promise: null,
    operation: null
};

const dashboardMutationUi = {
    owner: {
        progressLabel: 'Changing dashboard owners',
        confirmButtonId: 'confirmChangeOwner',
        idleButtonLabel: 'Change owner'
    },
    sharing: {
        progressLabel: 'Updating dashboard sharing',
        confirmButtonId: 'confirmModifySharing',
        idleButtonLabel: 'Update sharing'
    },
    delete: {
        progressLabel: 'Deleting dashboards',
        confirmButtonId: 'confirmDelete',
        idleButtonLabel: 'Delete'
    }
};

function isDashboardMutationRunning() {
    return dashboardMutationState.promise !== null;
}

function dashboardFiniteTimestamp(value) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function attachDashboardUsage(dashboards, usage) {
    const byId = usage?.lastViewedByDashboardId || {};
    (dashboards || []).forEach(dashboard => {
        const activity = byId[String(dashboard.id)];
        dashboard._usage = activity && typeof activity === 'object'
            ? {
                lastViewedBucketStartMs: dashboardFiniteTimestamp(activity.lastViewedBucketStartMs),
                lastViewedBucketEndMs: dashboardFiniteTimestamp(activity.lastViewedBucketEndMs),
                viewsInWindow: Number(activity.viewsInWindow) || 0
            }
            : null;
    });
}

function dashboardMatchesUsageFilter(
    dashboard,
    filterValue,
    nowMs = dashboardUsageState.untilMs || Date.now()
) {
    const normalized = String(filterValue || '');
    if (!normalized) return true;
    if (!DASHBOARD_USAGE_FILTER_DAYS.has(normalized)) return true;
    if (dashboardUsageState.status !== 'complete') return false;

    const days = Number(normalized);
    const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
    const lastBucketEnd = dashboardFiniteTimestamp(dashboard?._usage?.lastViewedBucketEndMs);
    if (lastBucketEnd !== null) return lastBucketEnd <= cutoff;
    const coverageFrom = dashboardFiniteTimestamp(dashboardUsageState.fromMs);
    return coverageFrom !== null && coverageFrom <= cutoff;
}

function formatDashboardLastViewed(dashboard) {
    if (dashboardUsageState.status !== 'complete') return 'Unavailable';
    const bucketStart = dashboardFiniteTimestamp(dashboard?._usage?.lastViewedBucketStartMs);
    if (bucketStart === null) return `No recorded views (${dashboardUsageState.lookbackDays}d)`;
    return new Date(bucketStart).toLocaleString();
}

function describeDashboardFilters(searchValue, ownerValue, usageValue, usageLabel = '') {
    const filters = [];
    const search = String(searchValue || '').trim();
    const owner = String(ownerValue || '').trim();
    const usage = String(usageValue || '');
    if (search) filters.push(`Name contains “${search}”`);
    if (owner) filters.push(`Owner contains “${owner}”`);
    if (DASHBOARD_USAGE_FILTER_DAYS.has(usage)) {
        filters.push(usageLabel || `No view recorded in ${usage} days`);
    }
    return filters;
}

function getDashboardFilterDescription() {
    const search = document.getElementById('searchDashboards');
    const owner = document.getElementById('filterOwner');
    const usage = document.getElementById('filterDashboardActivity');
    const usageLabel = usage?.options?.[usage.selectedIndex]?.textContent || '';
    return describeDashboardFilters(search?.value, owner?.value, usage?.value, usageLabel);
}

function dashboardFilterCountText(matchedCount, totalCount, appliedFilterCount) {
    const totalLabel = Number(totalCount || 0).toLocaleString();
    if (appliedFilterCount === 0) {
        return `Showing all ${totalLabel} dashboard${totalCount === 1 ? '' : 's'}`;
    }
    const matchedLabel = Number(matchedCount || 0).toLocaleString();
    return `${matchedLabel} of ${totalLabel} dashboard${totalCount === 1 ? '' : 's'} match ${appliedFilterCount} applied filter${appliedFilterCount === 1 ? '' : 's'}`;
}

function renderDashboardAppliedFilters(filters = getDashboardFilterDescription()) {
    const summary = document.getElementById('dashboardAppliedFilters');
    const chips = document.getElementById('dashboardAppliedFilterChips');
    if (!summary || !chips) return;
    chips.replaceChildren();
    filters.forEach(label => {
        const chip = document.createElement('span');
        chip.className = 'badge';
        chip.textContent = label;
        chips.appendChild(chip);
    });
    summary.hidden = filters.length === 0;
}

function renderDashboardUsageStatus() {
    const status = document.getElementById('dashboardUsageStatus');
    const filter = document.getElementById('filterDashboardActivity');
    if (!status || !filter) return;

    if (dashboardUsageState.status === 'complete') {
        status.textContent = dashboardUsageState.notice
            || `Last viewed is derived from hourly dashboard-view metrics over ${dashboardUsageState.lookbackDays} days.`;
        filter.disabled = false;
        window.refreshCustomSelect?.(filter);
        return;
    }
    if (dashboardUsageState.status === 'loading') {
        status.textContent = 'Loading dashboard usage metrics…';
    } else if (dashboardUsageState.status === 'unavailable') {
        status.textContent = `Dashboard usage is unavailable: ${dashboardUsageState.error}`;
    } else {
        status.textContent = '';
    }
    if (dashboardUsageState.status !== 'loading') {
        filter.value = '';
    }
    filter.disabled = true;
    window.refreshCustomSelect?.(filter);
}

async function loadDashboardUsage(dashboards) {
    dashboardUsageState.status = 'loading';
    dashboardUsageState.error = '';
    renderDashboardUsageStatus();
    try {
        const usage = await window.apiClient.getDashboardUsage(DASHBOARD_USAGE_LOOKBACK_DAYS);
        dashboardUsageState.status = usage?.status === 'complete' ? 'complete' : 'unavailable';
        dashboardUsageState.fromMs = dashboardFiniteTimestamp(usage?.fromMs);
        dashboardUsageState.untilMs = dashboardFiniteTimestamp(usage?.untilMs);
        dashboardUsageState.lookbackDays = Number(usage?.lookbackDays) || DASHBOARD_USAGE_LOOKBACK_DAYS;
        dashboardUsageState.cycle = String(usage?.cycle || 'auto');
        dashboardUsageState.notice = String(usage?.notice || '');
        dashboardUsageState.error = dashboardUsageState.status === 'complete'
            ? ''
            : 'the metric query did not complete';
        attachDashboardUsage(dashboards, usage);
    } catch (error) {
        dashboardUsageState.status = 'unavailable';
        dashboardUsageState.error = error?.message || 'metric query failed';
        attachDashboardUsage(dashboards, null);
    }
    renderDashboardUsageStatus();
}

function setDashboardMutationProgress(operation, completed, total, phase = 'mutating') {
    const ui = dashboardMutationUi[operation];
    if (!ui) return;

    const message = phase === 'refreshing'
        ? `${ui.progressLabel}: ${total} of ${total} complete. Refreshing dashboards…`
        : `${ui.progressLabel}: ${completed} of ${total} complete…`;
    const button = document.getElementById(ui.confirmButtonId);
    if (button) {
        button.textContent = phase === 'refreshing'
            ? 'Refreshing…'
            : `${ui.progressLabel.replace('dashboards', '').trim()} ${completed}/${total}…`;
    }
    document.querySelectorAll?.('.dashboard-mutation-progress').forEach(element => {
        element.style.display = 'flex';
        element.querySelector('.dashboard-mutation-progress-text').textContent = message;
    });
}

function setDashboardMutationBusy(operation, busy) {
    const ui = dashboardMutationUi[operation];
    if (!ui) return;

    [
        'bulkChangeOwnerBtn',
        'bulkShareBtn',
        'bulkDeleteBtn',
        'selectAllFilteredBtn',
        'clearDashboardSelectionBtn',
        'loadDashboardsBtn',
        'confirmChangeOwner',
        'confirmModifySharing',
        'confirmDelete',
        'cancelChangeOwner',
        'cancelModifySharing',
        'cancelDelete'
    ].forEach(id => {
        const control = document.getElementById(id);
        if (control) control.disabled = busy;
    });

    const module = document.getElementById('dashboardsModule');
    if (module) module.setAttribute('aria-busy', busy ? 'true' : 'false');

    if (!busy) {
        const button = document.getElementById(ui.confirmButtonId);
        if (button) button.textContent = ui.idleButtonLabel;
        document.querySelectorAll?.('.dashboard-mutation-progress').forEach(element => {
            element.style.display = 'none';
        });
        updateDashboardBulkActions();
        syncDashboardSelectAllCheckbox();
    }
}

async function runDashboardMutation(operation, dashboardIds, mutation) {
    if (dashboardMutationState.promise) return null;

    setDashboardMutationBusy(operation, true);
    setDashboardMutationProgress(operation, 0, dashboardIds.length);
    dashboardMutationState.operation = operation;
    dashboardMutationState.promise = mutation(progress => {
        setDashboardMutationProgress(
            operation,
            progress.completed,
            progress.total,
            progress.phase
        );
    });

    try {
        return await dashboardMutationState.promise;
    } finally {
        dashboardMutationState.promise = null;
        dashboardMutationState.operation = null;
        setDashboardMutationBusy(operation, false);
    }
}

async function loadDashboards() {
    if (!state.connected) {
        alert('Please connect to your ExtraHop instance first');
        return false;
    }

    const loadBtn = document.getElementById('loadDashboardsBtn');
    const loadingDiv = document.getElementById('dashboardsLoading');
    const tableContainer = document.getElementById('dashboardsTableContainer');

    try {
        loadBtn.disabled = true;
        loadBtn.textContent = 'Loading...';
        loadingDiv.style.display = 'block';
        tableContainer.style.display = 'none';

        // Load dashboards
        state.dashboards = await window.apiClient.getDashboards();

        // Dashboard usage is advisory and must not make dashboard administration unavailable.
        const [users] = await Promise.all([
            window.apiClient.getUsers(),
            loadDashboardUsage(state.dashboards)
        ]);
        state.allUsers = users;

        // Get unique owners from dashboards
        const ownerSet = new Set();
        state.dashboards.forEach(d => {
            if (d.owner) ownerSet.add(d.owner);
        });

        // Combine API users with owners found in dashboards
        const userSet = new Set([...state.allUsers.map(u => u.username), ...ownerSet]);
        state.allUsers = Array.from(userSet).sort().map(u => ({ username: u }));

        // Populate user dropdowns
        populateDashboardUserDropdowns();

        // Initial render
        applyDashboardFilters();
        renderDashboards();

        loadingDiv.style.display = 'none';
        tableContainer.style.display = 'block';
        document.getElementById('paginationContainer').style.display = 'flex';
        return true;

    } catch (error) {
        alert('Error loading dashboards: ' + error.message);
        loadingDiv.style.display = 'none';
        return false;
    } finally {
        loadBtn.textContent = 'Refresh';
        loadBtn.disabled = false;
    }
}

async function loadDashboardSharing(dashboard) {
    if (!dashboard) return;

    try {
        const sharing = await window.apiClient.getDashboardSharing(dashboard.id);
        dashboard.sharing = normalizeDashboardSharing(sharing);
        delete dashboard._sharingError;
    } catch (e) {
        delete dashboard.sharing;
        dashboard._sharingError = e?.message || 'Sharing details could not be retrieved.';
    }
}

function normalizeDashboardSharing(sharing) {
    return {
        anyone: sharing?.anyone === 'viewer' ? 'viewer' : null,
        users: { ...(sharing?.users || {}) },
        groups: { ...(sharing?.groups || {}) }
    };
}

function buildCompleteDashboardSharingPayload(currentSharing, changes = {}) {
    const current = normalizeDashboardSharing(currentSharing);
    const hasAnyoneChange = Object.prototype.hasOwnProperty.call(changes, 'anyone');

    return {
        anyone: hasAnyoneChange
            ? (changes.anyone === 'viewer' ? 'viewer' : null)
            : current.anyone,
        users: { ...current.users, ...(changes.users || {}) },
        groups: { ...current.groups, ...(changes.groups || {}) }
    };
}

async function mergeAndUpdateDashboardSharing(dashboardId, changes) {
    const currentSharing = await window.apiClient.getDashboardSharing(dashboardId);
    const payload = buildCompleteDashboardSharingPayload(currentSharing, changes);
    await window.apiClient.updateDashboardSharing(dashboardId, payload);
    return payload;
}

function newDashboardMutationResults() {
    return {
        mutations: 0,
        ownerChanges: 0,
        sharingChanges: 0,
        deletions: 0,
        items: [],
        errors: []
    };
}

function describeDashboardMutationError(dashboardId, operation, error) {
    return `Dashboard ${dashboardId} ${operation} failed: ${error?.message || error}`;
}

function findDashboardById(dashboardId) {
    return state.dashboards.find(item => String(item.id) === String(dashboardId));
}

async function refreshDashboardsAfterMutations(results) {
    if (results.mutations === 0) return;

    try {
        const refreshed = await loadDashboards();
        if (refreshed !== true) {
            throw new Error('authoritative reload did not complete');
        }
    } catch (error) {
        results.errors.push(`Dashboard refresh failed: ${error?.message || error}`);
    }
}

async function performDashboardOwnerChanges(dashboardIds, newOwner, grantAccess, onProgress) {
    const results = newDashboardMutationResults();

    for (const [index, id] of dashboardIds.entries()) {
        const dashboard = findDashboardById(id);
        const oldOwner = dashboard?.owner;
        let ownerChanged = false;
        const itemResult = {
            id,
            owner: { status: 'pending' },
            sharing: { status: grantAccess && oldOwner ? 'pending' : 'not_requested' }
        };
        results.items.push(itemResult);

        try {
            await window.apiClient.updateDashboard(id, { owner: newOwner });
            ownerChanged = true;
            results.ownerChanges++;
            results.mutations++;
            itemResult.owner.status = 'succeeded';
        } catch (error) {
            const message = describeDashboardMutationError(id, 'owner change', error);
            itemResult.owner = { status: 'failed', error: message };
            if (itemResult.sharing.status === 'pending') itemResult.sharing.status = 'skipped';
            results.errors.push(message);
        }

        if (ownerChanged && grantAccess && oldOwner) {
            try {
                await mergeAndUpdateDashboardSharing(id, {
                    users: { [oldOwner]: 'editor' }
                });
                results.sharingChanges++;
                results.mutations++;
                itemResult.sharing.status = 'succeeded';
            } catch (error) {
                const message = describeDashboardMutationError(id, 'old-owner access update', error);
                itemResult.sharing = { status: 'failed', error: message };
                results.errors.push(message);
            }
        }
        onProgress?.({ completed: index + 1, total: dashboardIds.length, phase: 'mutating' });
    }

    onProgress?.({ completed: dashboardIds.length, total: dashboardIds.length, phase: 'refreshing' });
    await refreshDashboardsAfterMutations(results);
    return results;
}

async function performDashboardSharingChanges(dashboardIds, changes, onProgress) {
    const results = newDashboardMutationResults();

    for (const [index, id] of dashboardIds.entries()) {
        const itemResult = { id, sharing: { status: 'pending' } };
        results.items.push(itemResult);
        try {
            await mergeAndUpdateDashboardSharing(id, changes);
            results.sharingChanges++;
            results.mutations++;
            itemResult.sharing.status = 'succeeded';
        } catch (error) {
            const message = describeDashboardMutationError(id, 'sharing update', error);
            itemResult.sharing = { status: 'failed', error: message };
            results.errors.push(message);
        }
        onProgress?.({ completed: index + 1, total: dashboardIds.length, phase: 'mutating' });
    }

    onProgress?.({ completed: dashboardIds.length, total: dashboardIds.length, phase: 'refreshing' });
    await refreshDashboardsAfterMutations(results);
    return results;
}

async function performDashboardDeletes(dashboardIds, onProgress) {
    const results = newDashboardMutationResults();

    for (const [index, id] of dashboardIds.entries()) {
        const itemResult = { id, deletion: { status: 'pending' } };
        results.items.push(itemResult);
        try {
            const deleted = await window.apiClient.deleteDashboard(id);
            if (!deleted) throw new Error('API did not confirm deletion');
            results.deletions++;
            results.mutations++;
            itemResult.deletion.status = 'succeeded';
        } catch (error) {
            const message = describeDashboardMutationError(id, 'deletion', error);
            itemResult.deletion = { status: 'failed', error: message };
            results.errors.push(message);
        }
        onProgress?.({ completed: index + 1, total: dashboardIds.length, phase: 'mutating' });
    }

    onProgress?.({ completed: dashboardIds.length, total: dashboardIds.length, phase: 'refreshing' });
    await refreshDashboardsAfterMutations(results);
    return results;
}

function populateDashboardUserDropdowns() {
    const newOwnerSelect = document.getElementById('newOwnerSelect');
    const additionalEditorsSelect = document.getElementById('additionalEditorsSelect');

    // Clear existing options
    newOwnerSelect.innerHTML = '<option value="">Select a user...</option>';
    additionalEditorsSelect.innerHTML = '';

    // Populate with users
    state.allUsers.forEach(user => {
        const option1 = document.createElement('option');
        option1.value = user.username;
        option1.textContent = user.username;
        newOwnerSelect.appendChild(option1);

        const option2 = document.createElement('option');
        option2.value = user.username;
        option2.textContent = user.username;
        additionalEditorsSelect.appendChild(option2);
    });
}

function applyDashboardFilters() {
    const searchTerm = document.getElementById('searchDashboards').value.toLowerCase();
    const ownerFilter = document.getElementById('filterOwner').value.toLowerCase();
    const usageFilter = document.getElementById('filterDashboardActivity').value;

    state.filteredDashboards = state.dashboards.filter(dashboard => {
        const nameMatch = !searchTerm || dashboard.name.toLowerCase().includes(searchTerm);
        const ownerMatch = !ownerFilter || (dashboard.owner && dashboard.owner.toLowerCase().includes(ownerFilter));
        const usageMatch = dashboardMatchesUsageFilter(dashboard, usageFilter);
        return nameMatch && ownerMatch && usageMatch;
    });

    state.currentPage = 1;
}

function getCurrentPageDashboards() {
    const start = (state.currentPage - 1) * state.itemsPerPage;
    const end = start + state.itemsPerPage;
    return state.filteredDashboards.slice(start, end);
}

function pruneSelectedDashboards() {
    const validDashboardIds = new Set(state.dashboards.map(dashboard => dashboard.id));
    state.selectedDashboards.forEach(id => {
        if (!validDashboardIds.has(id)) {
            state.selectedDashboards.delete(id);
        }
    });
}

function syncDashboardSelectAllCheckbox() {
    const selectAllCheckbox = document.getElementById('selectAll');
    const pageDashboards = getCurrentPageDashboards();
    const selectedOnPage = pageDashboards.filter(dashboard => state.selectedDashboards.has(dashboard.id)).length;

    if (pageDashboards.length === 0 || isDashboardMutationRunning()) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
        selectAllCheckbox.disabled = true;
        return;
    }

    selectAllCheckbox.disabled = false;
    selectAllCheckbox.checked = selectedOnPage === pageDashboards.length;
    selectAllCheckbox.indeterminate = selectedOnPage > 0 && selectedOnPage < pageDashboards.length;
}

function selectAllFilteredDashboards() {
    if (state.filteredDashboards.length === 0) {
        return;
    }

    state.filteredDashboards.forEach(dashboard => {
        state.selectedDashboards.add(dashboard.id);
    });
    renderDashboards();
}

function clearDashboardSelection() {
    state.selectedDashboards.clear();
    renderDashboards();
}

// Editor is the notable role, so it gets the emphasised badge; viewer stays neutral.
function dashboardRoleBadge(name, role) {
    const isEditor = (role || '').toString().toLowerCase() === 'editor';
    return `<span class="badge${isEditor ? ' badge-editor' : ''}">${escapeHtml(name)}<span class="muted">${isEditor ? 'Editor' : 'Viewer'}</span></span>`;
}

function renderDashboardRoleBadges(entries) {
    const list = Object.entries(entries || {});
    if (list.length === 0) return '<span class="small muted">None</span>';
    return list.map(([name, role]) => dashboardRoleBadge(name, role)).join('');
}

function renderDashboardSharingSection(dashboard) {
    if (dashboard._loadingSharing) {
        return '<p class="small muted">Loading sharing details…</p>';
    }

    if (dashboard._sharingError) {
        return '<p class="small muted">Sharing details unavailable.</p>';
    }

    if (!dashboard.sharing) {
        return '<p class="small muted">Sharing details not loaded.</p>';
    }

    const sharing = dashboard.sharing;
    const anyoneBubble = sharing.anyone
        ? dashboardRoleBadge('All users', sharing.anyone)
        : '<span class="small muted">No public access</span>';
    const userBubbles = renderDashboardRoleBadges(sharing.users);
    const groupBubbles = renderDashboardRoleBadges(sharing.groups);

    return `
        <div class="stack-sm">
            <div><span class="label">Public access</span><div class="row-tight" style="margin-top: 4px;">${anyoneBubble}</div></div>
            <div><span class="label">Users</span><div class="row-tight" style="margin-top: 4px;">${userBubbles}</div></div>
            <div><span class="label">Groups</span><div class="row-tight" style="margin-top: 4px;">${groupBubbles}</div></div>
        </div>
    `;
}

function renderDashboards() {
    const tbody = document.getElementById('dashboardsTableBody');
    const pageData = getCurrentPageDashboards();

    pruneSelectedDashboards();

    tbody.innerHTML = '';

    if (pageData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5"><div class="empty-inline">No dashboards found</div></td></tr>';
        updateDashboardPagination();
        updateDashboardBulkActions();
        syncDashboardSelectAllCheckbox();
        return;
    }

    pageData.forEach(dashboard => {
        const row = document.createElement('tr');
        const isExpanded = !!dashboard._expanded;

        row.dataset.id = dashboard.id;
        row.classList.toggle('is-selected', state.selectedDashboards.has(dashboard.id));

        row.innerHTML = `
            <td>
                <input type="checkbox" class="dashboard-checkbox" data-id="${escapeAttribute(dashboard.id)}" ${state.selectedDashboards.has(dashboard.id) ? 'checked' : ''}>
            </td>
            <td>
                <div class="row-tight">
                    <span class="disclosure-caret${isExpanded ? ' is-open' : ''}"></span>
                    <span class="primary-cell">${escapeHtml(dashboard.name)}</span>
                </div>
            </td>
            <td>${escapeHtml(dashboard.owner || 'System')}</td>
            <td>${escapeHtml(formatDashboardLastViewed(dashboard))}</td>
            <td class="actions">
                <button class="btn btn-sm change-owner-btn" data-id="${escapeAttribute(dashboard.id)}">Change owner</button>
                <button class="btn-danger btn-sm delete-btn" data-id="${escapeAttribute(dashboard.id)}">Delete</button>
            </td>
        `;
        tbody.appendChild(row);

        if (dashboard._expanded) {
            const detailRow = document.createElement('tr');
            detailRow.classList.add('dashboard-details-row');

            // Metadata section from initial /dashboards response
            const metaItems = [];
            if (dashboard.id != null) {
                metaItems.push(detailItem('ID', dashboard.id.toString()));
            }
            const shortcode = dashboard.shortcode || dashboard.short_code;
            if (shortcode) {
                metaItems.push(detailItem('Shortcode', shortcode.toString()));
            }
            if (dashboard.description) {
                metaItems.push(detailItem('Description', dashboard.description));
            }
            if (dashboard.mod_time) {
                metaItems.push(detailItem('Last modified', new Date(Number(dashboard.mod_time)).toLocaleString()));
            }
            if (dashboard._usage) {
                metaItems.push(detailItem(
                    `Views in ${dashboardUsageState.lookbackDays}d`,
                    Number(dashboard._usage.viewsInWindow || 0).toLocaleString()
                ));
            }

            const metadataSection = metaItems.length > 0
                ? `<div class="grid-fields">${metaItems.join('')}</div>`
                : '';

            const sharingSection = renderDashboardSharingSection(dashboard);

            const detailsContent = `
                <div class="detail-panel stack-sm" style="margin: 4px 0 10px;">
                    ${metadataSection}
                    ${sharingSection}
                </div>
            `;

            detailRow.innerHTML = `
                <td></td>
                <td colspan="4">${detailsContent}</td>
            `;

            tbody.appendChild(detailRow);
        }
    });

    updateDashboardPagination();
    updateDashboardBulkActions();
    syncDashboardSelectAllCheckbox();
}

function updateDashboardPagination() {
    const totalPages = Math.ceil(state.filteredDashboards.length / state.itemsPerPage);
    const paginationInfo = document.getElementById('paginationInfo');
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    const filterCount = document.getElementById('dashboardFilterCount');
    const appliedFilters = getDashboardFilterDescription();
    renderDashboardAppliedFilters(appliedFilters);
    filterCount.textContent = dashboardFilterCountText(
        state.filteredDashboards.length,
        state.dashboards.length,
        appliedFilters.length
    );

    if (state.filteredDashboards.length === 0) {
        paginationInfo.textContent = 'Showing 0 of 0';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        return;
    }

    const start = (state.currentPage - 1) * state.itemsPerPage + 1;
    const end = Math.min(start + state.itemsPerPage - 1, state.filteredDashboards.length);

    paginationInfo.textContent = `Showing ${start}-${end} of ${state.filteredDashboards.length}`;

    prevBtn.disabled = state.currentPage === 1;
    nextBtn.disabled = state.currentPage >= totalPages;
}

function updateDashboardBulkActions() {
    const bulkActions = document.getElementById('bulkActions');
    const selectedCount = document.getElementById('selectedCount');
    const selectAllFilteredBtn = document.getElementById('selectAllFilteredBtn');
    const clearSelectionBtn = document.getElementById('clearDashboardSelectionBtn');
    const allFilteredSelected = state.filteredDashboards.length > 0
        && state.filteredDashboards.every(dashboard => state.selectedDashboards.has(dashboard.id));

    const mutationRunning = isDashboardMutationRunning();
    selectAllFilteredBtn.disabled = mutationRunning;
    selectAllFilteredBtn.textContent = allFilteredSelected ? 'All Selected' : 'Select All';
    clearSelectionBtn.disabled = mutationRunning || state.selectedDashboards.size === 0;
    ['bulkChangeOwnerBtn', 'bulkShareBtn', 'bulkDeleteBtn'].forEach(id => {
        document.getElementById(id).disabled = mutationRunning;
    });

    if (state.selectedDashboards.size > 0) {
        bulkActions.style.display = 'flex';
        selectedCount.textContent = allFilteredSelected
            ? `${state.selectedDashboards.size} selected (all filtered dashboards)`
            : `${state.selectedDashboards.size} selected`;
    } else {
        bulkActions.style.display = 'none';
        selectedCount.textContent = '';
    }
}

async function handleDashboardBulkChangeOwner() {
    if (isDashboardMutationRunning()) return;
    showModal('changeOwnerModal');
}

async function confirmDashboardChangeOwner() {
    const newOwner = document.getElementById('newOwnerSelect').value;
    const grantAccess = document.getElementById('grantEditAccess').checked;

    if (!newOwner) {
        alert('Please select a new owner');
        return;
    }

    const dashboardIds = Array.from(state.selectedDashboards);
    const results = await runDashboardMutation(
        'owner',
        dashboardIds,
        onProgress => performDashboardOwnerChanges(dashboardIds, newOwner, grantAccess, onProgress)
    );
    if (!results) return;

    if (results.ownerChanges > 0) {
        hideModal('changeOwnerModal');
    }

    const accessSummary = grantAccess ? `; granted old-owner access on ${results.sharingChanges}` : '';
    const errorSummary = results.errors.length > 0 ? ` ${results.errors.length} operation(s) failed.` : '';
    alert(`Changed owner for ${results.ownerChanges} of ${dashboardIds.length} dashboard(s)${accessSummary}.${errorSummary}`);
}

async function handleDashboardBulkShare() {
    if (isDashboardMutationRunning()) return;
    showModal('modifySharingModal');
}

async function confirmDashboardModifySharing() {
    const shareWithAll = document.getElementById('shareWithAll').checked;
    const editorsSelect = document.getElementById('additionalEditorsSelect');
    const selectedEditors = Array.from(editorsSelect.selectedOptions).map(opt => opt.value);

    const dashboardIds = Array.from(state.selectedDashboards);
    const sharingChanges = {};
    if (shareWithAll) sharingChanges.anyone = 'viewer';
    if (selectedEditors.length > 0) {
        sharingChanges.users = Object.fromEntries(selectedEditors.map(username => [username, 'editor']));
    }

    const results = await runDashboardMutation(
        'sharing',
        dashboardIds,
        onProgress => performDashboardSharingChanges(dashboardIds, sharingChanges, onProgress)
    );
    if (!results) return;
    if (results.sharingChanges > 0) {
        hideModal('modifySharingModal');
    }

    const errorSummary = results.errors.length > 0 ? ` ${results.errors.length} update(s) failed.` : '';
    alert(`Updated sharing for ${results.sharingChanges} of ${dashboardIds.length} dashboard(s).${errorSummary}`);
}

async function handleDashboardBulkDelete() {
    if (isDashboardMutationRunning()) return;
    const count = state.selectedDashboards.size;
    document.getElementById('deleteCount').textContent = `${count} dashboard${count > 1 ? 's' : ''}`;
    showModal('deleteConfirmModal');
}

async function confirmDashboardDelete() {
    const dashboardIds = Array.from(state.selectedDashboards);
    const results = await runDashboardMutation(
        'delete',
        dashboardIds,
        onProgress => performDashboardDeletes(dashboardIds, onProgress)
    );
    if (!results) return;

    if (results.deletions > 0) {
        hideModal('deleteConfirmModal');
        results.deletions === dashboardIds.length
            ? state.selectedDashboards.clear()
            : dashboardIds.forEach(id => {
                if (!findDashboardById(id)) {
                    state.selectedDashboards.delete(id);
                }
            });
    }

    const errorSummary = results.errors.length > 0 ? ` ${results.errors.length} deletion(s) failed.` : '';
    alert(`Deleted ${results.deletions} of ${dashboardIds.length} dashboard(s).${errorSummary}`);
}

function handleDashboardRowClick(dashboardId) {
    const dashboard = findDashboardById(dashboardId);
    if (!dashboard) return;

    // Toggle expanded state
    if (dashboard._expanded) {
        dashboard._expanded = false;
        renderDashboards();
        return;
    }

    dashboard._expanded = true;

    // If sharing is already loaded, just re-render
    if (dashboard.sharing) {
        renderDashboards();
        return;
    }

    // Lazily load sharing info
    dashboard._loadingSharing = true;
    renderDashboards();

    loadDashboardSharing(dashboard)
        .finally(() => {
            dashboard._loadingSharing = false;
            renderDashboards();
        });
}

async function activateDashboardsModule() {
    console.log('Activating Dashboard Manager module');

    if (!state.connected) {
        return;
    }

    // If we already have dashboards loaded, just ensure filters and table are in sync
    if (state.dashboards && state.dashboards.length > 0) {
        applyDashboardFilters();
        renderDashboards();
        document.getElementById('dashboardsTableContainer').style.display = 'block';
        document.getElementById('paginationContainer').style.display = 'flex';
        return;
    }

    // Auto-load dashboards on first activation when connected
    await loadDashboards();
}

// Dashboard module initialization function
function initDashboardsModule() {
    console.log('Initializing Dashboard Manager module');
    
    // Set up event listeners specific to dashboard module
    if (!document.getElementById('loadDashboardsBtn').hasAttribute('data-listener-added')) {
        document.getElementById('loadDashboardsBtn').addEventListener('click', loadDashboards);
        document.getElementById('loadDashboardsBtn').setAttribute('data-listener-added', 'true');
        
        document.getElementById('searchDashboards').addEventListener('input', () => {
            applyDashboardFilters();
            renderDashboards();
        });
        
        document.getElementById('filterOwner').addEventListener('input', () => {
            applyDashboardFilters();
            renderDashboards();
        });

        document.getElementById('filterDashboardActivity').addEventListener('change', () => {
            applyDashboardFilters();
            renderDashboards();
        });

        document.getElementById('clearDashboardFiltersBtn').addEventListener('click', () => {
            document.getElementById('searchDashboards').value = '';
            document.getElementById('filterOwner').value = '';
            const activityFilter = document.getElementById('filterDashboardActivity');
            activityFilter.value = '';
            window.refreshCustomSelect?.(activityFilter);
            applyDashboardFilters();
            renderDashboards();
        });

        document.getElementById('selectAll').addEventListener('change', (e) => {
            getCurrentPageDashboards().forEach(dashboard => {
                if (e.target.checked) {
                    state.selectedDashboards.add(dashboard.id);
                } else {
                    state.selectedDashboards.delete(dashboard.id);
                }
            });
            renderDashboards();
        });

        document.getElementById('dashboardsTableBody').addEventListener('change', (e) => {
            if (isDashboardMutationRunning()) return;
            if (e.target.classList.contains('dashboard-checkbox')) {
                const id = e.target.dataset.id;
                if (e.target.checked) {
                    state.selectedDashboards.add(id);
                } else {
                    state.selectedDashboards.delete(id);
                }
                updateDashboardBulkActions();
                syncDashboardSelectAllCheckbox();
            }
        });

        document.getElementById('dashboardsTableBody').addEventListener('click', (e) => {
            if (isDashboardMutationRunning()) return;
            const checkbox = e.target.closest('input[type="checkbox"]');
            if (checkbox) {
                return;
            }

            const changeOwnerBtn = e.target.closest('.change-owner-btn');
            const deleteBtn = e.target.closest('.delete-btn');

            if (changeOwnerBtn) {
                const id = changeOwnerBtn.dataset.id;
                state.selectedDashboards.clear();
                state.selectedDashboards.add(id);
                updateDashboardBulkActions();
                syncDashboardSelectAllCheckbox();
                handleDashboardBulkChangeOwner();
            } else if (deleteBtn) {
                const id = deleteBtn.dataset.id;
                state.selectedDashboards.clear();
                state.selectedDashboards.add(id);
                updateDashboardBulkActions();
                syncDashboardSelectAllCheckbox();
                handleDashboardBulkDelete();
            } else {
                const row = e.target.closest('tr');
                if (!row || !row.dataset.id) return;
                const id = row.dataset.id;
                handleDashboardRowClick(id);
            }
        });

        document.getElementById('bulkChangeOwnerBtn').addEventListener('click', handleDashboardBulkChangeOwner);
        document.getElementById('bulkShareBtn').addEventListener('click', handleDashboardBulkShare);
        document.getElementById('bulkDeleteBtn').addEventListener('click', handleDashboardBulkDelete);
        document.getElementById('selectAllFilteredBtn').addEventListener('click', selectAllFilteredDashboards);
        document.getElementById('clearDashboardSelectionBtn').addEventListener('click', clearDashboardSelection);

        document.getElementById('prevPageBtn').addEventListener('click', () => {
            if (state.currentPage > 1) {
                state.currentPage--;
                renderDashboards();
            }
        });

        document.getElementById('nextPageBtn').addEventListener('click', () => {
            const totalPages = Math.ceil(state.filteredDashboards.length / state.itemsPerPage);
            if (state.currentPage < totalPages) {
                state.currentPage++;
                renderDashboards();
            }
        });

        // Modal event listeners
        document.getElementById('cancelChangeOwner').addEventListener('click', () => hideModal('changeOwnerModal'));
        document.getElementById('confirmChangeOwner').addEventListener('click', confirmDashboardChangeOwner);

        document.getElementById('cancelModifySharing').addEventListener('click', () => hideModal('modifySharingModal'));
        document.getElementById('confirmModifySharing').addEventListener('click', confirmDashboardModifySharing);

        document.getElementById('cancelDelete').addEventListener('click', () => hideModal('deleteConfirmModal'));
        document.getElementById('confirmDelete').addEventListener('click', confirmDashboardDelete);
    }
}

if (typeof featureRegistry !== 'undefined') {
    featureRegistry.register('dashboards', {
        initialize: initDashboardsModule,
        activate: activateDashboardsModule
    });
}
