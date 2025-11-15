class DashboardManager {
    constructor() {
        this.dashboards = [];
        this.allUsers = [];
        this.filteredDashboards = [];
        this.selectedDashboards = new Set();
        this.currentPage = 1;
        this.itemsPerPage = 50;
    }

    async load() {
        if (!window.auth.isConnected) {
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
            this.dashboards = await window.apiClient.getDashboards();
            
            // Load users for owner dropdown
            this.allUsers = await window.apiClient.getUsers();

            // Get unique owners from dashboards
            const ownerSet = new Set();
            this.dashboards.forEach(d => {
                if (d.owner) ownerSet.add(d.owner);
            });

            // Combine API users with owners found in dashboards
            const userSet = new Set([...this.allUsers.map(u => u.username), ...ownerSet]);
            this.allUsers = Array.from(userSet).sort().map(u => ({ username: u }));

            // Populate user dropdowns
            this.populateUserDropdowns();

            // Load sharing info for each dashboard (in background)
            this.loadDashboardSharing();

            // Initial render
            this.applyFilters();
            this.render();

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

    async loadDashboardSharing() {
        // Load sharing info for visible dashboards
        const promises = this.dashboards.map(async (dashboard) => {
            try {
                const sharing = await window.apiClient.getDashboardSharing(dashboard.id);
                dashboard.sharing = sharing;
            } catch (e) {
                dashboard.sharing = { anyone: false, users: {}, groups: {} };
            }
        });

        await Promise.all(promises);
        this.render(); // Re-render with sharing info
    }

    populateUserDropdowns() {
        const newOwnerSelect = document.getElementById('newOwnerSelect');
        const additionalEditorsSelect = document.getElementById('additionalEditorsSelect');

        // Clear existing options
        newOwnerSelect.innerHTML = '<option value="">Select a user...</option>';
        additionalEditorsSelect.innerHTML = '';

        // Populate with users
        this.allUsers.forEach(user => {
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

    applyFilters() {
        const searchTerm = document.getElementById('searchDashboards').value.toLowerCase();
        const ownerFilter = document.getElementById('filterOwner').value.toLowerCase();

        this.filteredDashboards = this.dashboards.filter(dashboard => {
            const nameMatch = !searchTerm || dashboard.name.toLowerCase().includes(searchTerm);
            const ownerMatch = !ownerFilter || (dashboard.owner && dashboard.owner.toLowerCase().includes(ownerFilter));
            return nameMatch && ownerMatch;
        });

        this.currentPage = 1;
    }

    render() {
        const tbody = document.getElementById('dashboardsTableBody');
        const start = (this.currentPage - 1) * this.itemsPerPage;
        const end = start + this.itemsPerPage;
        const pageData = this.filteredDashboards.slice(start, end);

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
                    <input type="checkbox" class="dashboard-checkbox" data-id="${dashboard.id}" ${this.selectedDashboards.has(dashboard.id) ? 'checked' : ''}>
                </td>
                <td>
                    <div class="font-semibold">${this.escapeHtml(dashboard.name)}</div>
                </td>
                <td>${this.escapeHtml(dashboard.owner || 'System')}</td>
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

        this.updatePagination();
        this.updateBulkActions();
    }

    updatePagination() {
        const totalPages = Math.ceil(this.filteredDashboards.length / this.itemsPerPage);
        const paginationInfo = document.getElementById('paginationInfo');
        const prevBtn = document.getElementById('prevPageBtn');
        const nextBtn = document.getElementById('nextPageBtn');

        const start = (this.currentPage - 1) * this.itemsPerPage + 1;
        const end = Math.min(start + this.itemsPerPage - 1, this.filteredDashboards.length);

        paginationInfo.textContent = `Showing ${start}-${end} of ${this.filteredDashboards.length}`;

        prevBtn.disabled = this.currentPage === 1;
        nextBtn.disabled = this.currentPage >= totalPages;
    }

    updateBulkActions() {
        const bulkActions = document.getElementById('bulkActions');
        const selectedCount = document.getElementById('selectedCount');

        if (this.selectedDashboards.size > 0) {
            bulkActions.style.display = 'flex';
            selectedCount.textContent = `${this.selectedDashboards.size} selected`;
        } else {
            bulkActions.style.display = 'none';
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Modal Functions
    showModal(modalId) {
        document.getElementById(modalId).classList.add('show');
    }

    hideModal(modalId) {
        document.getElementById(modalId).classList.remove('show');
    }

    async handleBulkChangeOwner() {
        this.showModal('changeOwnerModal');
    }

    async confirmChangeOwner() {
        const newOwner = document.getElementById('newOwnerSelect').value;
        const grantAccess = document.getElementById('grantEditAccess').checked;

        if (!newOwner) {
            alert('Please select a new owner');
            return;
        }

        const dashboardIds = Array.from(this.selectedDashboards);
        let successCount = 0;

        try {
            for (const id of dashboardIds) {
                const dashboard = this.dashboards.find(d => d.id === id);
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
            this.hideModal('changeOwnerModal');
            this.load();
        } catch (error) {
            alert(`Error: ${error.message}. Changed ${successCount} of ${dashboardIds.length} dashboards.`);
        }
    }

    async handleBulkShare() {
        this.showModal('modifySharingModal');
    }

    async confirmModifySharing() {
        const shareWithAll = document.getElementById('shareWithAll').checked;
        const editorsSelect = document.getElementById('additionalEditorsSelect');
        const selectedEditors = Array.from(editorsSelect.selectedOptions).map(opt => opt.value);

        const dashboardIds = Array.from(this.selectedDashboards);
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
            this.hideModal('modifySharingModal');
            this.load();
        } catch (error) {
            alert(`Error: ${error.message}. Updated ${successCount} of ${dashboardIds.length} dashboards.`);
        }
    }

    async handleBulkDelete() {
        const count = this.selectedDashboards.size;
        document.getElementById('deleteCount').textContent = `${count} dashboard${count > 1 ? 's' : ''}`;
        this.showModal('deleteConfirmModal');
    }

    async confirmDelete() {
        const dashboardIds = Array.from(this.selectedDashboards);
        let successCount = 0;

        try {
            for (const id of dashboardIds) {
                const success = await window.apiClient.deleteDashboard(id);
                if (success) successCount++;
            }

            alert(`Successfully deleted ${successCount} dashboard(s)`);
            this.hideModal('deleteConfirmModal');
            this.selectedDashboards.clear();
            this.load();
        } catch (error) {
            alert(`Error: ${error.message}. Deleted ${successCount} of ${dashboardIds.length} dashboards.`);
        }
    }

    setupEventListeners() {
        // Load button
        document.getElementById('loadDashboardsBtn').addEventListener('click', () => this.load());
        
        // Search and filter
        document.getElementById('searchDashboards').addEventListener('input', () => {
            this.applyFilters();
            this.render();
        });
        
        document.getElementById('filterOwner').addEventListener('input', () => {
            this.applyFilters();
            this.render();
        });

        // Select all checkbox
        document.getElementById('selectAll').addEventListener('change', (e) => {
            const checkboxes = document.querySelectorAll('.dashboard-checkbox');
            checkboxes.forEach(cb => {
                cb.checked = e.target.checked;
                const id = parseInt(cb.dataset.id);
                if (e.target.checked) {
                    this.selectedDashboards.add(id);
                } else {
                    this.selectedDashboards.delete(id);
                }
            });
            this.updateBulkActions();
        });

        // Individual checkboxes
        document.getElementById('dashboardsTableBody').addEventListener('change', (e) => {
            if (e.target.classList.contains('dashboard-checkbox')) {
                const id = parseInt(e.target.dataset.id);
                if (e.target.checked) {
                    this.selectedDashboards.add(id);
                } else {
                    this.selectedDashboards.delete(id);
                }
                this.updateBulkActions();
            }
        });

        // Individual actions
        document.getElementById('dashboardsTableBody').addEventListener('click', (e) => {
            if (e.target.classList.contains('change-owner-btn')) {
                const id = parseInt(e.target.dataset.id);
                this.selectedDashboards.clear();
                this.selectedDashboards.add(id);
                this.handleBulkChangeOwner();
            } else if (e.target.classList.contains('delete-btn')) {
                const id = parseInt(e.target.dataset.id);
                this.selectedDashboards.clear();
                this.selectedDashboards.add(id);
                this.handleBulkDelete();
            }
        });

        // Bulk actions
        document.getElementById('bulkChangeOwnerBtn').addEventListener('click', () => this.handleBulkChangeOwner());
        document.getElementById('bulkShareBtn').addEventListener('click', () => this.handleBulkShare());
        document.getElementById('bulkDeleteBtn').addEventListener('click', () => this.handleBulkDelete());

        // Pagination
        document.getElementById('prevPageBtn').addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.render();
            }
        });

        document.getElementById('nextPageBtn').addEventListener('click', () => {
            const totalPages = Math.ceil(this.filteredDashboards.length / this.itemsPerPage);
            if (this.currentPage < totalPages) {
                this.currentPage++;
                this.render();
            }
        });

        // Modal event listeners
        document.getElementById('cancelChangeOwner').addEventListener('click', () => this.hideModal('changeOwnerModal'));
        document.getElementById('confirmChangeOwner').addEventListener('click', () => this.confirmChangeOwner());
        document.getElementById('cancelModifySharing').addEventListener('click', () => this.hideModal('modifySharingModal'));
        document.getElementById('confirmModifySharing').addEventListener('click', () => this.confirmModifySharing());
        document.getElementById('cancelDelete').addEventListener('click', () => this.hideModal('deleteConfirmModal'));
        document.getElementById('confirmDelete').addEventListener('click', () => this.confirmDelete());
    }

    getTemplate() {
        return `
            <div class="mb-6">
                <h2 class="text-2xl font-bold" style="color: var(--sapphire);">Dashboard Manager</h2>
                <p class="mt-2" style="color: var(--text-muted);">Manage dashboard ownership, sharing, and deletion at scale</p>
            </div>

            <!-- Controls -->
            <div class="mb-6 space-y-4">
                <div class="flex flex-wrap gap-4">
                    <input type="text" id="searchDashboards" placeholder="Search dashboards..." class="flex-1 min-w-[200px] px-4 py-2 rounded border">
                    <input type="text" id="filterOwner" placeholder="Filter by owner..." class="flex-1 min-w-[200px] px-4 py-2 rounded border">
                    <button id="loadDashboardsBtn" class="btn-primary px-6 py-2 rounded font-semibold">
                        Load Dashboards
                    </button>
                </div>

                <!-- Bulk Actions -->
                <div id="bulkActions" class="flex flex-wrap gap-3" style="display: none;">
                    <button id="bulkChangeOwnerBtn" class="btn-secondary px-4 py-2 rounded font-semibold">
                        Change Owner
                    </button>
                    <button id="bulkShareBtn" class="btn-secondary px-4 py-2 rounded font-semibold">
                        Modify Sharing
                    </button>
                    <button id="bulkDeleteBtn" class="btn-danger px-4 py-2 rounded font-semibold">
                        Delete Selected
                    </button>
                    <span id="selectedCount" class="px-4 py-2 font-semibold" style="color: var(--text-secondary);"></span>
                </div>
            </div>

            <!-- Loading State -->
            <div id="dashboardsLoading" class="text-center py-20" style="display: none;">
                <div class="spinner mx-auto mb-4"></div>
                <p style="color: var(--text-muted);">Loading dashboards...</p>
            </div>

            <!-- Dashboard Table -->
            <div id="dashboardsTableContainer" class="table-container rounded-lg overflow-hidden" style="display: none;">
                <table id="dashboardsTable">
                    <thead>
                        <tr>
                            <th width="40">
                                <input type="checkbox" id="selectAll">
                            </th>
                            <th>Dashboard Name</th>
                            <th width="150">Owner</th>
                            <th width="100">Shared</th>
                            <th width="200">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="dashboardsTableBody">
                        <!-- Populated dynamically -->
                    </tbody>
                </table>
            </div>

            <!-- Pagination -->
            <div id="paginationContainer" class="mt-6 flex justify-between items-center" style="display: none;">
                <div style="color: var(--text-secondary);">
                    <span id="paginationInfo"></span>
                </div>
                <div class="flex gap-2">
                    <button id="prevPageBtn" class="btn-secondary px-4 py-2 rounded">Previous</button>
                    <button id="nextPageBtn" class="btn-secondary px-4 py-2 rounded">Next</button>
                </div>
            </div>

            <!-- Change Owner Modal -->
            <div id="changeOwnerModal" class="modal">
                <div class="modal-content">
                    <h3 class="text-lg font-semibold mb-4" style="color: var(--text-primary);">Change Dashboard Owner</h3>
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm font-medium mb-2" style="color: var(--text-secondary);">New Owner</label>
                            <select id="newOwnerSelect" class="w-full px-3 py-2 rounded border">
                                <option value="">Select a user...</option>
                            </select>
                        </div>
                        <div>
                            <label class="flex items-center">
                                <input type="checkbox" id="grantEditAccess" class="mr-2">
                                <span class="text-sm" style="color: var(--text-secondary);">Grant edit access to previous owner</span>
                            </label>
                        </div>
                    </div>
                    <div class="flex justify-end gap-3 mt-6">
                        <button id="cancelChangeOwner" class="btn-secondary px-4 py-2 rounded">Cancel</button>
                        <button id="confirmChangeOwner" class="btn-primary px-4 py-2 rounded">Change Owner</button>
                    </div>
                </div>
            </div>

            <!-- Modify Sharing Modal -->
            <div id="modifySharingModal" class="modal">
                <div class="modal-content">
                    <h3 class="text-lg font-semibold mb-4" style="color: var(--text-primary);">Modify Dashboard Sharing</h3>
                    <div class="space-y-4">
                        <div>
                            <label class="flex items-center">
                                <input type="checkbox" id="shareWithAll" class="mr-2">
                                <span class="text-sm" style="color: var(--text-secondary);">Share with all users (read-only)</span>
                            </label>
                        </div>
                        <div>
                            <label class="block text-sm font-medium mb-2" style="color: var(--text-secondary);">Additional Editors</label>
                            <select id="additionalEditorsSelect" multiple class="w-full px-3 py-2 rounded border" style="height: 120px;">
                            </select>
                            <p class="text-xs mt-1" style="color: var(--text-muted);">Hold Ctrl/Cmd to select multiple users</p>
                        </div>
                    </div>
                    <div class="flex justify-end gap-3 mt-6">
                        <button id="cancelModifySharing" class="btn-secondary px-4 py-2 rounded">Cancel</button>
                        <button id="confirmModifySharing" class="btn-primary px-4 py-2 rounded">Update Sharing</button>
                    </div>
                </div>
            </div>

            <!-- Delete Confirmation Modal -->
            <div id="deleteConfirmModal" class="modal">
                <div class="modal-content">
                    <h3 class="text-lg font-semibold mb-4" style="color: var(--text-primary);">Confirm Deletion</h3>
                    <p style="color: var(--text-secondary);">Are you sure you want to delete <span id="deleteCount"></span>? This action cannot be undone.</p>
                    <div class="flex justify-end gap-3 mt-6">
                        <button id="cancelDelete" class="btn-secondary px-4 py-2 rounded">Cancel</button>
                        <button id="confirmDelete" class="btn-danger px-4 py-2 rounded">Delete</button>
                    </div>
                </div>
            </div>
        `;
    }

    activate() {
        // Setup event listeners when module is activated
        this.setupEventListeners();
        
        // Set module title
        document.getElementById('ribbonModuleTitle').textContent = 'Dashboard Manager';
    }

    deactivate() {
        // Clean up when switching modules
        this.selectedDashboards.clear();
    }
}

// Export for global use
window.DashboardManager = DashboardManager;