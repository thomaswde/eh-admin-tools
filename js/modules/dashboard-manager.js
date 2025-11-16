// Dashboard Manager Module

async function loadDashboards() {
    if (!state.connected) {
        alert('Please connect to your ExtraHop instance first');
        return;
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
        
        // Load users for owner dropdown
        state.allUsers = await window.apiClient.getUsers();

        // Get unique owners from dashboards
        const ownerSet = new Set();
        state.dashboards.forEach(d => {
            if (d.owner) ownerSet.add(d.owner);
        });

        // Combine API users with owners found in dashboards
        const userSet = new Set([...state.allUsers.map(u => u.username), ...ownerSet]);
        state.allUsers = Array.from(userSet).sort().map(u => ({ username: u }));

        // Populate user dropdowns
        populateUserDropdowns();

        // Load sharing info for each dashboard (in background)
        loadDashboardSharing();

        // Initial render
        applyFilters();
        renderDashboards();

        loadingDiv.style.display = 'none';
        tableContainer.style.display = 'block';
        document.getElementById('paginationContainer').style.display = 'flex';

    } catch (error) {
        alert('Error loading dashboards: ' + error.message);
        loadingDiv.style.display = 'none';
    } finally {
        loadBtn.textContent = 'Refresh';
        loadBtn.disabled = false;
    }
}

async function loadDashboardSharing() {
    // Load sharing info for visible dashboards
    const promises = state.dashboards.map(async (dashboard) => {
        try {
            const sharing = await window.apiClient.getDashboardSharing(dashboard.id);
            dashboard.sharing = sharing;
        } catch (e) {
            dashboard.sharing = { anyone: false, users: {}, groups: {} };
        }
    });

    await Promise.all(promises);
    renderDashboards(); // Re-render with sharing info
}

function populateUserDropdowns() {
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

function applyFilters() {
    const searchTerm = document.getElementById('searchDashboards').value.toLowerCase();
    const ownerFilter = document.getElementById('filterOwner').value.toLowerCase();

    state.filteredDashboards = state.dashboards.filter(dashboard => {
        const nameMatch = !searchTerm || dashboard.name.toLowerCase().includes(searchTerm);
        const ownerMatch = !ownerFilter || (dashboard.owner && dashboard.owner.toLowerCase().includes(ownerFilter));
        return nameMatch && ownerMatch;
    });

    state.currentPage = 1;
}

function renderDashboards() {
    const tbody = document.getElementById('dashboardsTableBody');
    const start = (state.currentPage - 1) * state.itemsPerPage;
    const end = start + state.itemsPerPage;
    const pageData = state.filteredDashboards.slice(start, end);

    tbody.innerHTML = '';

    if (pageData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center py-8" style="color: var(--text-muted);">No dashboards found</td></tr>';
        return;
    }

    pageData.forEach(dashboard => {
        const row = document.createElement('tr');
        const isShared = dashboard.sharing?.anyone || 
                        Object.keys(dashboard.sharing?.users || {}).length > 0 || 
                        Object.keys(dashboard.sharing?.groups || {}).length > 0;

        row.innerHTML = `
            <td>
                <input type="checkbox" class="dashboard-checkbox" data-id="${dashboard.id}" ${state.selectedDashboards.has(dashboard.id) ? 'checked' : ''}>
            </td>
            <td>
                <div class="font-semibold">${escapeHtml(dashboard.name)}</div>
            </td>
            <td>${escapeHtml(dashboard.owner || 'System')}</td>
            <td>
                ${isShared ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-warning">Private</span>'}
            </td>
            <td>
                <div class="flex gap-2">
                    <button class="btn-secondary px-3 py-1 rounded text-sm change-owner-btn" data-id="${dashboard.id}">
                        Change Owner
                    </button>
                    <button class="btn-danger px-3 py-1 rounded text-sm delete-btn" data-id="${dashboard.id}">
                        Delete
                    </button>
                </div>
            </td>
        `;

        tbody.appendChild(row);
    });

    updatePagination();
    updateBulkActions();
}

function updatePagination() {
    const totalPages = Math.ceil(state.filteredDashboards.length / state.itemsPerPage);
    const paginationInfo = document.getElementById('paginationInfo');
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');

    const start = (state.currentPage - 1) * state.itemsPerPage + 1;
    const end = Math.min(start + state.itemsPerPage - 1, state.filteredDashboards.length);

    paginationInfo.textContent = `Showing ${start}-${end} of ${state.filteredDashboards.length}`;

    prevBtn.disabled = state.currentPage === 1;
    nextBtn.disabled = state.currentPage >= totalPages;
}

function updateBulkActions() {
    const bulkActions = document.getElementById('bulkActions');
    const selectedCount = document.getElementById('selectedCount');

    if (state.selectedDashboards.size > 0) {
        bulkActions.style.display = 'flex';
        selectedCount.textContent = `${state.selectedDashboards.size} selected`;
    } else {
        bulkActions.style.display = 'none';
    }
}

async function handleBulkChangeOwner() {
    showModal('changeOwnerModal');
}

async function confirmChangeOwner() {
    const newOwner = document.getElementById('newOwnerSelect').value;
    const grantAccess = document.getElementById('grantEditAccess').checked;

    if (!newOwner) {
        alert('Please select a new owner');
        return;
    }

    const dashboardIds = Array.from(state.selectedDashboards);
    let successCount = 0;

    try {
        for (const id of dashboardIds) {
            const dashboard = state.dashboards.find(d => d.id === id);
            const oldOwner = dashboard.owner;

            await window.apiClient.updateDashboard(id, { owner: newOwner });

            if (grantAccess && oldOwner) {
                await window.apiClient.updateDashboardSharing(id, {
                    users: { [oldOwner]: 'editor' }
                });
            }

            successCount++;
        }

        alert(`Successfully changed owner for ${successCount} dashboard(s)`);
        hideModal('changeOwnerModal');
        loadDashboards();
    } catch (error) {
        alert(`Error: ${error.message}. Changed ${successCount} of ${dashboardIds.length} dashboards.`);
    }
}

async function handleBulkShare() {
    showModal('modifySharingModal');
}

async function confirmModifySharing() {
    const shareWithAll = document.getElementById('shareWithAll').checked;
    const editorsSelect = document.getElementById('additionalEditorsSelect');
    const selectedEditors = Array.from(editorsSelect.selectedOptions).map(opt => opt.value);

    const dashboardIds = Array.from(state.selectedDashboards);
    let successCount = 0;

    try {
        for (const id of dashboardIds) {
            const sharingPayload = {};

            if (shareWithAll) {
                sharingPayload.anyone = 'viewer';
            }

            if (selectedEditors.length > 0) {
                sharingPayload.users = {};
                selectedEditors.forEach(username => {
                    sharingPayload.users[username] = 'editor';
                });
            }

            await window.apiClient.updateDashboardSharing(id, sharingPayload);
            successCount++;
        }

        alert(`Successfully updated sharing for ${successCount} dashboard(s)`);
        hideModal('modifySharingModal');
        loadDashboards();
    } catch (error) {
        alert(`Error: ${error.message}. Updated ${successCount} of ${dashboardIds.length} dashboards.`);
    }
}

async function handleBulkDelete() {
    const count = state.selectedDashboards.size;
    document.getElementById('deleteCount').textContent = `${count} dashboard${count > 1 ? 's' : ''}`;
    showModal('deleteConfirmModal');
}

async function confirmDelete() {
    const dashboardIds = Array.from(state.selectedDashboards);
    let successCount = 0;

    try {
        for (const id of dashboardIds) {
            const success = await window.apiClient.deleteDashboard(id);
            if (success) successCount++;
        }

        alert(`Successfully deleted ${successCount} dashboard(s)`);
        hideModal('deleteConfirmModal');
        state.selectedDashboards.clear();
        loadDashboards();
    } catch (error) {
        alert(`Error: ${error.message}. Deleted ${successCount} of ${dashboardIds.length} dashboards.`);
    }
}

// Dashboard module initialization function
function initDashboardsModule() {
    console.log('Initializing Dashboard Manager module');
    
    // Set up event listeners specific to dashboard module
    if (!document.getElementById('loadDashboardsBtn').hasAttribute('data-listener-added')) {
        document.getElementById('loadDashboardsBtn').addEventListener('click', loadDashboards);
        document.getElementById('loadDashboardsBtn').setAttribute('data-listener-added', 'true');
        
        document.getElementById('searchDashboards').addEventListener('input', () => {
            applyFilters();
            renderDashboards();
        });
        
        document.getElementById('filterOwner').addEventListener('input', () => {
            applyFilters();
            renderDashboards();
        });

        document.getElementById('selectAll').addEventListener('change', (e) => {
            const checkboxes = document.querySelectorAll('.dashboard-checkbox');
            checkboxes.forEach(cb => {
                cb.checked = e.target.checked;
                const id = parseInt(cb.dataset.id);
                if (e.target.checked) {
                    state.selectedDashboards.add(id);
                } else {
                    state.selectedDashboards.delete(id);
                }
            });
            updateBulkActions();
        });

        document.getElementById('dashboardsTableBody').addEventListener('change', (e) => {
            if (e.target.classList.contains('dashboard-checkbox')) {
                const id = parseInt(e.target.dataset.id);
                if (e.target.checked) {
                    state.selectedDashboards.add(id);
                } else {
                    state.selectedDashboards.delete(id);
                }
                updateBulkActions();
            }
        });

        document.getElementById('dashboardsTableBody').addEventListener('click', (e) => {
            if (e.target.classList.contains('change-owner-btn')) {
                const id = parseInt(e.target.dataset.id);
                state.selectedDashboards.clear();
                state.selectedDashboards.add(id);
                handleBulkChangeOwner();
            } else if (e.target.classList.contains('delete-btn')) {
                const id = parseInt(e.target.dataset.id);
                state.selectedDashboards.clear();
                state.selectedDashboards.add(id);
                handleBulkDelete();
            }
        });

        document.getElementById('bulkChangeOwnerBtn').addEventListener('click', handleBulkChangeOwner);
        document.getElementById('bulkShareBtn').addEventListener('click', handleBulkShare);
        document.getElementById('bulkDeleteBtn').addEventListener('click', handleBulkDelete);

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
        document.getElementById('confirmChangeOwner').addEventListener('click', confirmChangeOwner);

        document.getElementById('cancelModifySharing').addEventListener('click', () => hideModal('modifySharingModal'));
        document.getElementById('confirmModifySharing').addEventListener('click', confirmModifySharing);

        document.getElementById('cancelDelete').addEventListener('click', () => hideModal('deleteConfirmModal'));
        document.getElementById('confirmDelete').addEventListener('click', confirmDelete);
    }
}