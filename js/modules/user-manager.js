// User Manager Module

const USER_BASE_ACCESS_OPTIONS = [
    { value: 'system_full', label: 'System Full', roles: { system: 'full' } },
    { value: 'write_full', label: 'Write Full', roles: { write: 'full' } },
    { value: 'write_limited', label: 'Write Limited', roles: { write: 'limited' } },
    { value: 'write_personal', label: 'Write Personal', roles: { write: 'personal' } },
    { value: 'metrics_full', label: 'Metrics Full', roles: { metrics: 'full' } },
    { value: 'metrics_restricted', label: 'Metrics Restricted', roles: { metrics: 'restricted' } },
    { value: 'no_access', label: 'No Base Access', roles: { write: null } }
];

const USER_MODULE_ACCESS_OPTIONS = {
    ndr: [
        { value: 'not_set', label: 'Not Set' },
        { value: 'full', label: 'Full', roleValue: 'full' },
        { value: 'none', label: 'None', roleValue: 'none' }
    ],
    npm: [
        { value: 'not_set', label: 'Not Set' },
        { value: 'full', label: 'Full', roleValue: 'full' },
        { value: 'none', label: 'None', roleValue: 'none' }
    ],
    packets: [
        { value: 'not_set', label: 'Not Set' },
        { value: 'slices_only', label: 'Slices Only', roleValue: 'slices_only' },
        { value: 'full', label: 'Full', roleValue: 'full' },
        { value: 'full_with_keys', label: 'Full With Keys', roleValue: 'full_with_keys' }
    ]
};

const USER_ROLE_ORDER = ['system', 'write', 'metrics', 'ndr', 'npm', 'packets'];
const USER_BASE_FAMILIES = ['system', 'write', 'metrics'];
const USER_KNOWN_FAMILIES = [...USER_ROLE_ORDER];

const userManagerState = {
    isLoaded: false,
    currentPage: 1,
    itemsPerPage: 20,
    roleForms: {
        create: null,
        edit: null
    },
    activeDeleteUsername: null
};

function cloneRoleObject(roles) {
    if (!roles || typeof roles !== 'object') {
        return {};
    }

    return Object.entries(roles).reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
    }, {});
}

function orderGrantedRoles(roles) {
    const ordered = {};
    const source = cloneRoleObject(roles);

    USER_ROLE_ORDER.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            ordered[key] = source[key];
            delete source[key];
        }
    });

    Object.keys(source).sort().forEach(key => {
        ordered[key] = source[key];
    });

    return ordered;
}

function roleObjectsEqual(a, b) {
    const left = a || {};
    const right = b || {};
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    if (leftKeys.length !== rightKeys.length) {
        return false;
    }

    return leftKeys.every(key => rightKeys.includes(key) && left[key] === right[key]);
}

function getBaseAccessOptionByValue(value) {
    return USER_BASE_ACCESS_OPTIONS.find(option => option.value === value);
}

function getModuleAccessOption(family, value) {
    return (USER_MODULE_ACCESS_OPTIONS[family] || []).find(option => option.value === value);
}

function getDefaultRoleSelections() {
    return {
        baseAccess: 'write_limited',
        ndr: 'not_set',
        npm: 'not_set',
        packets: 'not_set'
    };
}

function parseRoleSelections(roles = {}) {
    const normalizedRoles = cloneRoleObject(roles);
    const selections = getDefaultRoleSelections();
    const warnings = [];
    const preserveAvailability = {
        baseAccess: false,
        ndr: false,
        npm: false,
        packets: false
    };

    const baseSubset = {};
    USER_BASE_FAMILIES.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(normalizedRoles, key)) {
            baseSubset[key] = normalizedRoles[key];
        }
    });

    const matchedBase = USER_BASE_ACCESS_OPTIONS.find(option => roleObjectsEqual(option.roles, baseSubset));
    if (matchedBase) {
        selections.baseAccess = matchedBase.value;
    } else if (Object.keys(baseSubset).length === 0) {
        selections.baseAccess = 'preserve_existing';
        preserveAvailability.baseAccess = true;
        warnings.push('This user has no explicit base access in granted_roles. It will stay unchanged unless you choose a new base access preset.');
    } else {
        selections.baseAccess = 'preserve_existing';
        preserveAvailability.baseAccess = true;
        warnings.push('This user has a custom or unsupported base access configuration. It will be preserved unless you change Base Access.');
    }

    ['ndr', 'npm', 'packets'].forEach(family => {
        if (!Object.prototype.hasOwnProperty.call(normalizedRoles, family)) {
            selections[family] = 'not_set';
            return;
        }

        const matched = (USER_MODULE_ACCESS_OPTIONS[family] || []).find(option => option.roleValue === normalizedRoles[family]);
        if (matched) {
            selections[family] = matched.value;
            return;
        }

        selections[family] = 'preserve_existing';
        preserveAvailability[family] = true;
        warnings.push(`This user has an unsupported ${family.toUpperCase()} privilege value. It will be preserved unless you change ${family.toUpperCase()}.`);
    });

    const unknownFamilies = Object.keys(normalizedRoles).filter(key => !USER_KNOWN_FAMILIES.includes(key));
    if (unknownFamilies.length > 0) {
        warnings.push(`Additional granted_roles entries will be preserved: ${unknownFamilies.join(', ')}.`);
    }

    return {
        selections,
        warnings,
        preserveAvailability,
        originalRoles: normalizedRoles
    };
}

function buildGrantedRolesFromSelections(selections, originalRoles = {}) {
    const roles = cloneRoleObject(originalRoles);

    if (selections.baseAccess !== 'preserve_existing') {
        USER_BASE_FAMILIES.forEach(key => {
            delete roles[key];
        });

        const baseOption = getBaseAccessOptionByValue(selections.baseAccess);
        if (baseOption) {
            Object.entries(baseOption.roles).forEach(([key, value]) => {
                roles[key] = value;
            });
        }
    }

    ['ndr', 'npm', 'packets'].forEach(family => {
        if (selections[family] === 'preserve_existing') {
            return;
        }

        delete roles[family];

        const option = getModuleAccessOption(family, selections[family]);
        if (option && Object.prototype.hasOwnProperty.call(option, 'roleValue')) {
            roles[family] = option.roleValue;
        }
    });

    return orderGrantedRoles(roles);
}

function selectionsEqual(left, right) {
    return ['baseAccess', 'ndr', 'npm', 'packets'].every(key => left[key] === right[key]);
}

function getRoleFormContext(mode) {
    return userManagerState.roleForms[mode];
}

function setRoleFormContext(mode, context) {
    userManagerState.roleForms[mode] = context;
}

function buildSelectHtml(options, selectedValue, includePreserveOption = false) {
    const html = [];

    if (includePreserveOption) {
        html.push(`<option value="preserve_existing" ${selectedValue === 'preserve_existing' ? 'selected' : ''}>Preserve Existing</option>`);
    }

    options.forEach(option => {
        html.push(`<option value="${option.value}" ${selectedValue === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`);
    });

    return html.join('');
}

function renderRoleFormControls(mode, context) {
    const baseSelect = document.getElementById(`${mode}UserBaseAccess`);
    const ndrSelect = document.getElementById(`${mode}UserNdrAccess`);
    const npmSelect = document.getElementById(`${mode}UserNpmAccess`);
    const packetsSelect = document.getElementById(`${mode}UserPacketsAccess`);

    baseSelect.innerHTML = buildSelectHtml(
        USER_BASE_ACCESS_OPTIONS,
        context.selections.baseAccess,
        mode === 'edit' && context.preserveAvailability.baseAccess
    );
    ndrSelect.innerHTML = buildSelectHtml(
        USER_MODULE_ACCESS_OPTIONS.ndr,
        context.selections.ndr,
        mode === 'edit' && context.preserveAvailability.ndr
    );
    npmSelect.innerHTML = buildSelectHtml(
        USER_MODULE_ACCESS_OPTIONS.npm,
        context.selections.npm,
        mode === 'edit' && context.preserveAvailability.npm
    );
    packetsSelect.innerHTML = buildSelectHtml(
        USER_MODULE_ACCESS_OPTIONS.packets,
        context.selections.packets,
        mode === 'edit' && context.preserveAvailability.packets
    );

    updateRolePreview(mode);
}

function getCurrentRoleSelections(mode) {
    return {
        baseAccess: document.getElementById(`${mode}UserBaseAccess`).value,
        ndr: document.getElementById(`${mode}UserNdrAccess`).value,
        npm: document.getElementById(`${mode}UserNpmAccess`).value,
        packets: document.getElementById(`${mode}UserPacketsAccess`).value
    };
}

function updateRolePreview(mode) {
    const context = getRoleFormContext(mode);
    if (!context) {
        return;
    }

    const selections = getCurrentRoleSelections(mode);
    const previewEl = document.getElementById(`${mode}UserRolePreview`);
    const warningEl = document.getElementById(`${mode}UserRoleWarning`);
    const grantedRoles = buildGrantedRolesFromSelections(selections, context.originalRoles);

    previewEl.textContent = JSON.stringify(grantedRoles, null, 2);

    if (context.warnings.length > 0) {
        warningEl.style.display = 'block';
        warningEl.textContent = context.warnings.join(' ');
    } else {
        warningEl.style.display = 'none';
        warningEl.textContent = '';
    }
}

function formatTimestamp(value) {
    if (value == null || value === '' || value === 0 || value === '0') {
        return 'Never';
    }

    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return escapeHtml(String(value));
    }

    const date = new Date(numericValue);
    if (Number.isNaN(date.getTime())) {
        return 'Unknown';
    }

    return date.toLocaleString();
}

function isRx360Deployment() {
    return state.apiConfig?.type === '360';
}

function getBaseAccessInfo(roles = {}) {
    const baseSubset = {};
    USER_BASE_FAMILIES.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(roles, key)) {
            baseSubset[key] = roles[key];
        }
    });

    if (Object.keys(baseSubset).length === 0) {
        return {
            label: 'Not Set',
            color: 'var(--text-muted)'
        };
    }

    const matched = USER_BASE_ACCESS_OPTIONS.find(option => roleObjectsEqual(option.roles, baseSubset));
    if (!matched) {
        return {
            label: 'Custom',
            color: 'var(--plum)'
        };
    }

    return {
        label: matched.label,
        color: matched.value === 'system_full' ? 'var(--magenta)' : 'var(--sapphire)'
    };
}

function getDisplayedBaseAccess(user) {
    const granted = getBaseAccessInfo(user.granted_roles || {});
    if (granted.label !== 'Not Set') {
        return granted;
    }

    const effective = getBaseAccessInfo(user.effective_roles || {});
    if (effective.label !== 'Not Set') {
        return {
            label: `${effective.label} (effective)`,
            color: effective.color
        };
    }

    return granted;
}

function renderRoleBadgesHtml(roles = {}) {
    const orderedRoles = orderGrantedRoles(roles);
    const entries = Object.entries(orderedRoles);

    if (entries.length === 0) {
        return '<span class="small muted">None</span>';
    }

    return entries.map(([key, value]) => {
        const roleValue = value === null ? 'null' : String(value);
        return `<span class="badge">${escapeHtml(key.toUpperCase())}<span class="muted">${escapeHtml(roleValue)}</span></span>`;
    }).join('');
}

function renderRolesPanel(title, roles) {
    return `
        <div class="detail-panel">
            <div class="detail-label">${escapeHtml(title)}</div>
            <div class="row-tight" style="margin: 8px 0 12px;">${renderRoleBadgesHtml(roles)}</div>
            <pre class="json-preview">${escapeHtml(JSON.stringify(orderGrantedRoles(roles || {}), null, 2))}</pre>
        </div>
    `;
}

function renderApiKeysPanel(apiKeys) {
    if (!Array.isArray(apiKeys) || apiKeys.length === 0) {
        return `
            <div class="detail-panel">
                <div class="detail-label">API keys</div>
                <p class="small muted">No API keys found.</p>
            </div>
        `;
    }

    const items = apiKeys.map(apiKey => `
        <div class="card" style="box-shadow: none; padding: 12px 14px;">
            <div class="strong">${escapeHtml(apiKey.description || `Key ${String(apiKey.id)}`)}</div>
            <div class="small muted">ID ${escapeHtml(String(apiKey.id))} · Last 4 ${escapeHtml(String(apiKey.key || ''))}</div>
            <div class="small muted">Created ${escapeHtml(formatTimestamp(apiKey.time_added))}</div>
        </div>
    `).join('');

    return `
        <div class="detail-panel">
            <div class="detail-label">API keys</div>
            <div class="stack-sm" style="margin-top: 8px;">${items}</div>
        </div>
    `;
}

function renderLockPanel(user) {
    const lockStatus = user.detailLockStatus;
    const lockErrors = user.detailErrors || [];

    if (!lockStatus) {
        const lockError = lockErrors.find(error => error.startsWith('Lock status'));
        return `
            <div class="detail-panel">
                <div class="detail-label">Account lock</div>
                <p class="small muted">${escapeHtml(lockError || 'Lock status unavailable.')}</p>
            </div>
        `;
    }

    const isLocked = !!lockStatus.is_locked;
    const expirationText = isLocked
        ? `Locked until ${formatTimestamp(lockStatus.lockout_expiration)}`
        : 'Not currently locked';

    return `
        <div class="detail-panel">
            <div class="row">
                <div>
                    <div class="detail-label">Account lock</div>
                    <span class="badge ${isLocked ? 'badge-warning' : 'badge-success'}">
                        <span class="badge-dot"></span>${escapeHtml(expirationText)}
                    </span>
                </div>
                <div class="spacer"></div>
                ${isLocked ? `
                    <button class="btn btn-sm unlock-user-btn" data-username="${escapeHtml(user.username)}">Unlock account</button>
                ` : ''}
            </div>
        </div>
    `;
}

function applyUserFilters() {
    const searchTerm = document.getElementById('searchUsers').value.trim().toLowerCase();
    const typeFilter = document.getElementById('filterUserType').value;
    const stateFilter = document.getElementById('filterUserState').value;

    state.filteredUsers = state.users.filter(user => {
        const matchesSearch = !searchTerm
            || (user.username || '').toLowerCase().includes(searchTerm)
            || (user.name || '').toLowerCase().includes(searchTerm);
        const matchesType = !typeFilter || user.type === typeFilter;
        const enabledState = user.enabled ? 'enabled' : 'disabled';
        const matchesState = !stateFilter || enabledState === stateFilter;
        return matchesSearch && matchesType && matchesState;
    });

    userManagerState.currentPage = 1;
}

function updateUsersPagination() {
    const totalItems = state.filteredUsers.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / userManagerState.itemsPerPage));
    const infoEl = document.getElementById('usersPaginationInfo');
    const prevBtn = document.getElementById('usersPrevPageBtn');
    const nextBtn = document.getElementById('usersNextPageBtn');

    if (totalItems === 0) {
        infoEl.textContent = 'Showing 0 of 0';
    } else {
        const start = (userManagerState.currentPage - 1) * userManagerState.itemsPerPage + 1;
        const end = Math.min(start + userManagerState.itemsPerPage - 1, totalItems);
        infoEl.textContent = `Showing ${start}-${end} of ${totalItems}`;
    }

    prevBtn.disabled = userManagerState.currentPage <= 1;
    nextBtn.disabled = userManagerState.currentPage >= totalPages;
}

function renderUsers() {
    const tbody = document.getElementById('usersTableBody');
    const tableContainer = document.getElementById('usersTableContainer');
    const paginationContainer = document.getElementById('usersPaginationContainer');
    const start = (userManagerState.currentPage - 1) * userManagerState.itemsPerPage;
    const end = start + userManagerState.itemsPerPage;
    const pageData = state.filteredUsers.slice(start, end);

    tbody.innerHTML = '';

    if (pageData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-inline">No users found</div></td></tr>';
        tableContainer.style.display = 'block';
        paginationContainer.style.display = 'flex';
        updateUsersPagination();
        return;
    }

    pageData.forEach(user => {
        const row = document.createElement('tr');
        row.dataset.username = user.username;

        const baseAccess = getDisplayedBaseAccess(user);
        const lastLogin = formatTimestamp(user.last_ui_login_time);
        const enabledLabel = user.enabled ? 'Enabled' : 'Disabled';
        const isExpanded = !!user._expanded;

        row.innerHTML = `
            <td>
                <div class="row-tight">
                    <span class="disclosure-caret${isExpanded ? ' is-open' : ''}"></span>
                    <span class="primary-cell">${escapeHtml(user.username)}</span>
                </div>
            </td>
            <td>${escapeHtml(user.name || '')}</td>
            <td>${escapeHtml((user.type || 'unknown').toUpperCase())}</td>
            <td><span class="badge">${escapeHtml(baseAccess.label)}</span></td>
            <td>
                <span class="badge ${user.enabled ? 'badge-success' : 'badge-warning'}">
                    <span class="badge-dot"></span>${enabledLabel}
                </span>
            </td>
            <td>${escapeHtml(lastLogin)}</td>
            <td class="actions">
                <button class="btn btn-sm edit-user-btn" data-username="${escapeAttribute(user.username)}">Edit</button>
                <button class="btn-danger btn-sm delete-user-btn" data-username="${escapeAttribute(user.username)}">Delete</button>
            </td>
        `;

        tbody.appendChild(row);

        if (user._expanded) {
            const detailRow = document.createElement('tr');
            detailRow.classList.add('user-details-row');

            let detailContent = '<div class="detail-panel"><p class="small muted">Loading user details…</p></div>';

            if (user.detailError && !user._loadingDetails) {
                detailContent = `<div class="notice notice-danger">${escapeHtml(user.detailError)}</div>`;
            } else if (!user._loadingDetails && user.detailUser) {
                const detailUser = user.detailUser;
                const isRx360 = isRx360Deployment();
                const metaPanel = `
                    <div class="detail-panel">
                        <div class="grid-fields">
                            ${detailItem('Username', detailUser.username || '')}
                            ${detailItem('Friendly name', detailUser.name || '')}
                            ${detailItem('Type', (detailUser.type || '').toUpperCase())}
                            ${detailItem('Enabled', detailUser.enabled ? 'Yes' : 'No')}
                            ${detailItem('Date joined', formatTimestamp(detailUser.date_joined))}
                            ${detailItem('Last UI login', formatTimestamp(detailUser.last_ui_login_time))}
                            ${detailItem('ExtraHop Account Team', detailUser.eh_account_team ? 'Yes' : 'No')}
                        </div>
                    </div>
                `;

                const errorsHtml = (user.detailErrors || []).length > 0
                    ? `<div class="notice notice-warn">${escapeHtml(user.detailErrors.join(' '))}</div>`
                    : '';

                detailContent = `
                    <div class="stack" style="margin: 4px 0 10px;">
                        ${errorsHtml}
                        ${metaPanel}
                        ${isRx360 ? '' : renderLockPanel(user)}
                        <div class="grid-2">
                            ${renderRolesPanel('Granted roles', detailUser.granted_roles || {})}
                            ${renderRolesPanel('Effective roles', detailUser.effective_roles || {})}
                        </div>
                        ${isRx360 ? '' : renderApiKeysPanel(user.detailApiKeys)}
                    </div>
                `;
            }

            detailRow.innerHTML = `
                <td colspan="7">${detailContent}</td>
            `;

            tbody.appendChild(detailRow);
        }
    });

    document.getElementById('usersTableContainer').style.display = 'block';
    document.getElementById('usersPaginationContainer').style.display = 'flex';
    updateUsersPagination();
}

async function ensureUserDetailsLoaded(user) {
    if (!user || user._loadingDetails) {
        return;
    }

    const isRx360 = isRx360Deployment();

    if (
        user.detailUser &&
        (isRx360 || (user._lockStatusLoaded && user._apiKeysLoaded))
    ) {
        return;
    }

    user._loadingDetails = true;
    user.detailError = null;
    renderUsers();

    const requestPromises = [window.apiClient.getUser(user.username)];

    if (!isRx360) {
        requestPromises.push(window.apiClient.getUserLockStatus(user.username));
        requestPromises.push(window.apiClient.getUserApiKeys(user.username));
    }

    const results = await Promise.allSettled(requestPromises);

    user._loadingDetails = false;
    user.detailErrors = [];

    const [userResult, lockResult, apiKeysResult] = results;

    if (userResult.status === 'fulfilled') {
        user.detailUser = userResult.value;
        Object.assign(user, userResult.value);
    } else {
        user.detailError = `Unable to load details for ${user.username}: ${userResult.reason.message}`;
    }

    if (isRx360) {
        user._lockStatusLoaded = true;
        user._apiKeysLoaded = true;
        user.detailLockStatus = null;
        user.detailApiKeys = [];
    } else {
        if (lockResult.status === 'fulfilled') {
            user.detailLockStatus = lockResult.value;
        } else {
            user.detailErrors.push(`Lock status unavailable: ${lockResult.reason.message}`);
            user.detailLockStatus = null;
        }

        if (apiKeysResult.status === 'fulfilled') {
            user.detailApiKeys = apiKeysResult.value;
        } else {
            user.detailErrors.push(`API keys unavailable: ${apiKeysResult.reason.message}`);
            user.detailApiKeys = [];
        }

        user._lockStatusLoaded = true;
        user._apiKeysLoaded = true;
    }

    renderUsers();
}

async function loadUsers(options = {}) {
    if (!state.connected) {
        alert('Please connect to your ExtraHop instance first');
        return;
    }
    if (!deploymentSupportsApiFamily(state.apiConfig?.type, 'users')) {
        showStatus('User Manager is available only for self-managed RevealX Enterprise deployments.', true);
        return;
    }

    const loadBtn = document.getElementById('loadUsersBtn');
    const loadingDiv = document.getElementById('usersLoading');
    const tableContainer = document.getElementById('usersTableContainer');
    const paginationContainer = document.getElementById('usersPaginationContainer');

    try {
        loadBtn.disabled = true;
        loadBtn.textContent = 'Loading...';
        loadingDiv.style.display = 'block';
        tableContainer.style.display = 'none';
        paginationContainer.style.display = 'none';

        const users = await window.apiClient.listUsers();
        users.sort((left, right) => left.username.localeCompare(right.username));

        state.users = users;
        state.allUsers = users.map(user => ({ username: user.username }));
        userManagerState.isLoaded = true;

        applyUserFilters();
        renderUsers();

        loadingDiv.style.display = 'none';
        tableContainer.style.display = 'block';
        paginationContainer.style.display = 'flex';

        if (options.expandUsername) {
            const targetUser = state.users.find(user => user.username === options.expandUsername);
            if (targetUser) {
                targetUser._expanded = true;
                renderUsers();
                ensureUserDetailsLoaded(targetUser);
            }
        }
    } catch (error) {
        loadingDiv.style.display = 'none';
        alert('Error loading users: ' + error.message);
    } finally {
        loadBtn.disabled = false;
        loadBtn.textContent = 'Refresh';
    }
}

async function handleUserRowToggle(username) {
    const user = state.users.find(entry => entry.username === username);
    if (!user) {
        return;
    }

    if (user._expanded) {
        user._expanded = false;
        renderUsers();
        return;
    }

    state.users.forEach(entry => {
        if (entry.username !== username) {
            entry._expanded = false;
        }
    });

    user._expanded = true;
    renderUsers();
    await ensureUserDetailsLoaded(user);
}

function openCreateUserModal() {
    document.getElementById('createUserUsername').value = '';
    document.getElementById('createUserName').value = '';
    document.getElementById('createUserPassword').value = '';
    document.getElementById('createUserType').value = 'local';
    window.refreshCustomSelect?.(document.getElementById('createUserType'));
    document.getElementById('createUserEnabled').checked = true;
    document.getElementById('createUserCreateApiKey').checked = false;
    document.getElementById('createUserEhAccountTeam').checked = false;

    const context = {
        selections: getDefaultRoleSelections(),
        warnings: [],
        preserveAvailability: {
            baseAccess: false,
            ndr: false,
            npm: false,
            packets: false
        },
        originalRoles: {}
    };

    setRoleFormContext('create', context);
    renderRoleFormControls('create', context);
    showModal('createUserModal');
}

async function openEditUserModal(username) {
    const saveBtn = document.getElementById('confirmEditUser');

    try {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Loading...';

        const user = await window.apiClient.getUser(username);
        const parsedRoles = parseRoleSelections(user.granted_roles || {});

        document.getElementById('editUserUsernameDisplay').textContent = user.username || '';
        document.getElementById('editUserTypeDisplay').textContent = (user.type || '').toUpperCase();
        document.getElementById('editUserDateJoinedDisplay').textContent = formatTimestamp(user.date_joined);
        document.getElementById('editUserLastLoginDisplay').textContent = formatTimestamp(user.last_ui_login_time);
        document.getElementById('editUserEhAccountTeamDisplay').textContent = user.eh_account_team ? 'Yes' : 'No';
        document.getElementById('editUserName').value = user.name || '';
        document.getElementById('editUserEnabled').checked = !!user.enabled;
        document.getElementById('editUserPassword').value = '';

        const passwordInput = document.getElementById('editUserPassword');
        const passwordHelp = document.getElementById('editUserPasswordHelp');
        if (user.type === 'remote') {
            passwordInput.disabled = true;
            passwordHelp.textContent = 'Password changes are only supported for local users.';
        } else {
            passwordInput.disabled = false;
            passwordHelp.textContent = 'Leave blank to keep the current password.';
        }

        setRoleFormContext('edit', {
            selections: parsedRoles.selections,
            initialSelections: { ...parsedRoles.selections },
            warnings: parsedRoles.warnings,
            preserveAvailability: parsedRoles.preserveAvailability,
            originalRoles: parsedRoles.originalRoles,
            originalUser: user
        });

        renderRoleFormControls('edit', getRoleFormContext('edit'));
        showModal('editUserModal');
    } catch (error) {
        alert('Error loading user details: ' + error.message);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
    }
}

function openDeleteUserModal(username) {
    userManagerState.activeDeleteUsername = username;
    document.getElementById('deleteUserTarget').textContent = username;
    document.getElementById('deleteUserConfirmInput').value = '';

    const select = document.getElementById('deleteUserTransferSelect');
    select.innerHTML = '<option value="">Do not transfer owned objects</option>';

    state.users
        .filter(user => user.username !== username)
        .forEach(user => {
            const option = document.createElement('option');
            option.value = user.username;
            option.textContent = user.username;
            select.appendChild(option);
        });

    showModal('deleteUserModal');
}

async function handleUnlockUser(username) {
    if (!confirm(`Unlock account for ${username}?`)) {
        return;
    }

    try {
        await window.apiClient.unlockUser(username);

        const user = state.users.find(entry => entry.username === username);
        if (user) {
            user.detailLockStatus = {
                is_locked: false,
                lockout_expiration: 0
            };
            renderUsers();
        }

        alert(`Unlocked ${username} successfully.`);
    } catch (error) {
        alert('Error unlocking user: ' + error.message);
    }
}

async function confirmCreateUser() {
    const createBtn = document.getElementById('confirmCreateUser');
    const username = document.getElementById('createUserUsername').value.trim();
    const name = document.getElementById('createUserName').value.trim();
    const password = document.getElementById('createUserPassword').value;

    if (!username || !name || !password) {
        alert('Username, friendly name, and password are required.');
        return;
    }

    const selections = getCurrentRoleSelections('create');
    const payload = {
        username,
        name,
        password,
        type: document.getElementById('createUserType').value,
        enabled: document.getElementById('createUserEnabled').checked,
        create_apikey: document.getElementById('createUserCreateApiKey').checked,
        eh_account_team: document.getElementById('createUserEhAccountTeam').checked,
        granted_roles: buildGrantedRolesFromSelections(selections, {})
    };

    try {
        createBtn.disabled = true;
        createBtn.textContent = 'Creating...';

        const response = await window.apiClient.createUser(payload);
        hideModal('createUserModal');
        await loadUsers();

        if (response && response.apikey) {
            document.getElementById('createdUserApiKeyValue').textContent = response.apikey;
            showModal('createdUserApiKeyModal');
        } else {
            alert(`Created user ${username} successfully.`);
        }
    } catch (error) {
        alert('Error creating user: ' + error.message);
    } finally {
        createBtn.disabled = false;
        createBtn.textContent = 'Create User';
    }
}

async function confirmEditUser() {
    const editBtn = document.getElementById('confirmEditUser');
    const context = getRoleFormContext('edit');
    if (!context || !context.originalUser) {
        return;
    }

    const updatedName = document.getElementById('editUserName').value.trim();
    const updatedEnabled = document.getElementById('editUserEnabled').checked;
    const updatedPassword = document.getElementById('editUserPassword').value;
    const currentSelections = getCurrentRoleSelections('edit');
    const payload = {};

    if (updatedName !== (context.originalUser.name || '')) {
        payload.name = updatedName;
    }

    if (updatedEnabled !== !!context.originalUser.enabled) {
        payload.enabled = updatedEnabled;
    }

    if (updatedPassword && context.originalUser.type === 'local') {
        payload.password = updatedPassword;
    }

    if (!selectionsEqual(currentSelections, context.initialSelections)) {
        payload.granted_roles = buildGrantedRolesFromSelections(currentSelections, context.originalRoles);
    }

    if (Object.keys(payload).length === 0) {
        alert('No changes to save.');
        return;
    }

    try {
        editBtn.disabled = true;
        editBtn.textContent = 'Saving...';
        await window.apiClient.updateUser(context.originalUser.username, payload);
        hideModal('editUserModal');
        await loadUsers({ expandUsername: context.originalUser.username });
        alert(`Updated ${context.originalUser.username} successfully.`);
    } catch (error) {
        alert('Error updating user: ' + error.message);
    } finally {
        editBtn.disabled = false;
        editBtn.textContent = 'Save Changes';
    }
}

async function confirmDeleteUser() {
    const deleteBtn = document.getElementById('confirmDeleteUser');
    const username = userManagerState.activeDeleteUsername;
    const confirmation = document.getElementById('deleteUserConfirmInput').value.trim();
    const transferUser = document.getElementById('deleteUserTransferSelect').value;

    if (!username) {
        return;
    }

    if (confirmation !== username) {
        alert('Please type the username exactly to confirm deletion.');
        return;
    }

    try {
        deleteBtn.disabled = true;
        deleteBtn.textContent = 'Deleting...';
        await window.apiClient.deleteUser(username, transferUser || undefined);
        hideModal('deleteUserModal');
        await loadUsers();
        alert(`Deleted ${username} successfully.`);
    } catch (error) {
        alert('Error deleting user: ' + error.message);
    } finally {
        deleteBtn.disabled = false;
        deleteBtn.textContent = 'Delete User';
    }
}

async function copyCreatedApiKey() {
    const apiKey = document.getElementById('createdUserApiKeyValue').textContent;
    if (!apiKey) {
        return;
    }

    try {
        await navigator.clipboard.writeText(apiKey);
        alert('API key copied to clipboard.');
    } catch {
        alert('Unable to copy API key automatically. Please copy it manually.');
    }
}

async function activateUsersModule() {
    if (!state.connected) {
        return;
    }
    if (!deploymentSupportsApiFamily(state.apiConfig?.type, 'users')) {
        return;
    }

    if (userManagerState.isLoaded && state.users.length > 0) {
        applyUserFilters();
        renderUsers();
        return;
    }

    await loadUsers();
}

function initUsersModule() {
    if (!deploymentSupportsApiFamily(state.apiConfig?.type, 'users')) {
        return;
    }
    if (document.getElementById('loadUsersBtn').hasAttribute('data-listener-added')) {
        return;
    }

    document.getElementById('loadUsersBtn').addEventListener('click', () => loadUsers());
    document.getElementById('createUserBtn').addEventListener('click', openCreateUserModal);

    document.getElementById('searchUsers').addEventListener('input', () => {
        applyUserFilters();
        renderUsers();
    });

    document.getElementById('filterUserType').addEventListener('change', () => {
        applyUserFilters();
        renderUsers();
    });

    document.getElementById('filterUserState').addEventListener('change', () => {
        applyUserFilters();
        renderUsers();
    });

    document.getElementById('usersPrevPageBtn').addEventListener('click', () => {
        if (userManagerState.currentPage > 1) {
            userManagerState.currentPage--;
            renderUsers();
        }
    });

    document.getElementById('usersNextPageBtn').addEventListener('click', () => {
        const totalPages = Math.max(1, Math.ceil(state.filteredUsers.length / userManagerState.itemsPerPage));
        if (userManagerState.currentPage < totalPages) {
            userManagerState.currentPage++;
            renderUsers();
        }
    });

    document.getElementById('usersTableBody').addEventListener('click', async event => {
        const editButton = event.target.closest('.edit-user-btn');
        const deleteButton = event.target.closest('.delete-user-btn');
        const unlockButton = event.target.closest('.unlock-user-btn');

        if (editButton) {
            await openEditUserModal(editButton.dataset.username);
            return;
        }

        if (deleteButton) {
            openDeleteUserModal(deleteButton.dataset.username);
            return;
        }

        if (unlockButton) {
            await handleUnlockUser(unlockButton.dataset.username);
            return;
        }

        const row = event.target.closest('tr');
        if (!row || !row.dataset.username) {
            return;
        }

        await handleUserRowToggle(row.dataset.username);
    });

    ['BaseAccess', 'NdrAccess', 'NpmAccess', 'PacketsAccess'].forEach(field => {
        document.getElementById(`createUser${field}`).addEventListener('change', () => updateRolePreview('create'));
        document.getElementById(`editUser${field}`).addEventListener('change', () => updateRolePreview('edit'));
    });

    document.getElementById('confirmCreateUser').addEventListener('click', confirmCreateUser);
    document.getElementById('cancelCreateUser').addEventListener('click', () => hideModal('createUserModal'));

    document.getElementById('confirmEditUser').addEventListener('click', confirmEditUser);
    document.getElementById('cancelEditUser').addEventListener('click', () => hideModal('editUserModal'));

    document.getElementById('confirmDeleteUser').addEventListener('click', confirmDeleteUser);
    document.getElementById('cancelDeleteUser').addEventListener('click', () => hideModal('deleteUserModal'));

    document.getElementById('copyCreatedUserApiKey').addEventListener('click', copyCreatedApiKey);
    document.getElementById('closeCreatedUserApiKey').addEventListener('click', () => {
        hideModal('createdUserApiKeyModal');
        document.getElementById('createdUserApiKeyValue').textContent = '';
    });

    document.getElementById('loadUsersBtn').setAttribute('data-listener-added', 'true');
}

if (typeof featureRegistry !== 'undefined') {
    featureRegistry.register('users', {
        initialize: initUsersModule,
        activate: activateUsersModule
    });
}
