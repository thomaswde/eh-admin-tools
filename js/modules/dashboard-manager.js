// Dashboard Manager Module

const DASHBOARD_USAGE_LOOKBACK_DAYS = 365;
const DASHBOARD_USAGE_DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_USAGE_FILTER_PRESETS = [7, 14, 30, 60, 90, 180, 365];
const MAX_DASHBOARD_FILTERS = 20;
const MAX_DASHBOARD_OWNER_FILTER_VALUES = 20;
const DASHBOARD_PAGE_SIZE = 100;
const DASHBOARD_HIGH_IMPACT_THRESHOLD = 100;

const DASHBOARD_FILTER_DEFINITIONS = {
    name: {
        label: 'Name',
        operators: [
            { value: 'contains', label: 'contains (≈)', chipLabel: 'contains' },
            { value: 'not_contains', label: 'does not contain (≉)', chipLabel: 'does not contain' },
            { value: 'is', label: 'is (=)', chipLabel: 'is' },
            { value: 'is_not', label: 'is not (≠)', chipLabel: 'is not' }
        ]
    },
    owner: {
        label: 'Owner',
        operators: [
            { value: 'is', label: 'is (=)', chipLabel: 'is' },
            { value: 'is_not', label: 'is not (≠)', chipLabel: 'is not' }
        ]
    },
    viewed: {
        label: 'Last recorded activity',
        operators: [
            { value: 'within', label: 'recorded within', chipLabel: 'recorded within' },
            { value: 'not_within', label: 'not recorded within', chipLabel: 'not recorded within' }
        ]
    }
};

const dashboardUsageState = {
    status: 'not_loaded',
    supported: true,
    capabilityReason: '',
    requestedFromMs: null,
    coverageFromMs: null,
    untilMs: null,
    lookbackDays: DASHBOARD_USAGE_LOOKBACK_DAYS,
    cycle: 'auto',
    notice: '',
    error: ''
};

const dashboardFilterState = {
    filters: [],
    nextId: 1
};

const dashboardMutationState = {
    promise: null,
    operation: null
};

const dashboardConfigurationBackupState = {
    promise: null,
    action: null
};

const dashboardHighImpactState = {
    pending: null
};

const dashboardBackupUi = {
    owner: {
        buttonId: 'backupBeforeOwnerChange',
        statusId: 'ownerBackupStatus',
        confirmButtonId: 'confirmChangeOwner'
    },
    delete: {
        buttonId: 'backupBeforeDelete',
        statusId: 'deleteBackupStatus',
        confirmButtonId: 'confirmDelete'
    }
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

function dashboardUsageCoversDays(days, nowMs = dashboardUsageState.untilMs || Date.now()) {
    const normalizedDays = Number(days);
    if (!Number.isInteger(normalizedDays) || normalizedDays < 1) return false;
    if (dashboardUsageState.status !== 'complete') return false;

    const coverageFrom = dashboardFiniteTimestamp(dashboardUsageState.coverageFromMs);
    if (coverageFrom === null) return false;
    const cutoff = nowMs - normalizedDays * DASHBOARD_USAGE_DAY_MS;
    return coverageFrom <= cutoff;
}

function dashboardMatchesUsageFilter(
    dashboard,
    operator,
    days,
    nowMs = dashboardUsageState.untilMs || Date.now()
) {
    if (!['within', 'not_within'].includes(String(operator || ''))) return false;
    if (!dashboardUsageCoversDays(days, nowMs)) return false;

    const cutoff = nowMs - Number(days) * DASHBOARD_USAGE_DAY_MS;
    const lastBucketEnd = dashboardFiniteTimestamp(dashboard?._usage?.lastViewedBucketEndMs);
    if (operator === 'within') {
        return lastBucketEnd !== null && lastBucketEnd > cutoff;
    }
    return lastBucketEnd === null || lastBucketEnd <= cutoff;
}

function dashboardUsageRetainedDays() {
    const coverageFrom = dashboardFiniteTimestamp(dashboardUsageState.coverageFromMs);
    const until = dashboardFiniteTimestamp(dashboardUsageState.untilMs);
    if (coverageFrom === null || until === null || coverageFrom > until) return null;
    return Math.floor((until - coverageFrom) / DASHBOARD_USAGE_DAY_MS);
}

function dashboardUsageCoverageLabel() {
    const retainedDays = dashboardUsageRetainedDays();
    return retainedDays === null ? 'available usage history' : `${retainedDays}d of usage history`;
}

function dashboardUsageLookbackOptions() {
    const retainedDays = dashboardUsageRetainedDays();
    if (retainedDays === null || retainedDays < 1) return [];
    const choices = DASHBOARD_USAGE_FILTER_PRESETS.filter(days => days <= retainedDays);
    choices.push(retainedDays);
    return Array.from(new Set(choices)).sort((left, right) => left - right);
}

function dashboardUsageHistoryPlaceholder() {
    if (dashboardUsageState.status === 'loading') return 'Loading usage metric history…';
    if (dashboardUsageState.status !== 'complete') return 'Usage metric history unavailable';
    const retainedDays = dashboardUsageRetainedDays();
    if (retainedDays === null) return 'Usage metric history unavailable';
    if (retainedDays < 1) return 'Less than one complete day of usage metrics exists';
    return `Usage metrics exist for the last ${retainedDays} complete day${retainedDays === 1 ? '' : 's'}`;
}

function formatDashboardLastViewed(dashboard) {
    if (dashboardUsageState.status !== 'complete') return 'Unavailable';
    const bucketStart = dashboardFiniteTimestamp(dashboard?._usage?.lastViewedBucketStartMs);
    if (bucketStart === null && dashboardUsageRetainedDays() === null) return 'Usage history unavailable';
    if (bucketStart === null) return `No recorded activity (${dashboardUsageCoverageLabel()})`;
    return new Date(bucketStart).toLocaleString();
}

function dashboardOwnerValue(dashboard) {
    return String(dashboard?.owner || 'System');
}

function normalizeDashboardFilter(filter) {
    const field = String(filter?.field || '');
    const definition = DASHBOARD_FILTER_DEFINITIONS[field];
    if (!definition) return null;
    const operator = String(filter?.operator || '');
    if (!definition.operators.some(candidate => candidate.value === operator)) return null;
    const rawOperand = filter?.operand;
    if (field === 'owner' && operator === 'is') {
        const source = Array.isArray(rawOperand) ? rawOperand : [rawOperand];
        const seen = new Set();
        const operand = source
            .map(value => String(value ?? '').trim())
            .filter(value => {
                const folded = value.toLocaleLowerCase();
                if (!value || seen.has(folded)) return false;
                seen.add(folded);
                return true;
            });
        if (!operand.length || operand.length > MAX_DASHBOARD_OWNER_FILTER_VALUES) return null;
        return { field, operator, operand };
    }
    const operand = String(rawOperand ?? '').trim();
    if (!operand) return null;
    if (field === 'viewed') {
        const days = Number(operand);
        if (!Number.isInteger(days) || days < 1 || days > DASHBOARD_USAGE_LOOKBACK_DAYS) return null;
        return { field, operator, operand: String(days) };
    }
    return { field, operator, operand };
}

function dashboardFilterMatches(dashboard, filter) {
    const normalized = normalizeDashboardFilter(filter);
    if (!normalized) return true;
    if (normalized.field === 'viewed') {
        return dashboardMatchesUsageFilter(
            dashboard,
            normalized.operator,
            normalized.operand
        );
    }

    const actual = normalized.field === 'owner'
        ? dashboardOwnerValue(dashboard)
        : String(dashboard?.name || '');
    const actualFolded = actual.toLocaleLowerCase();
    if (normalized.field === 'owner' && normalized.operator === 'is') {
        return normalized.operand.some(owner => actualFolded === owner.toLocaleLowerCase());
    }
    const operandFolded = normalized.operand.toLocaleLowerCase();
    if (normalized.operator === 'contains') return actualFolded.includes(operandFolded);
    if (normalized.operator === 'not_contains') return !actualFolded.includes(operandFolded);
    if (normalized.operator === 'is') return actualFolded === operandFolded;
    if (normalized.operator === 'is_not') return actualFolded !== operandFolded;
    return false;
}

function describeDashboardFilter(filter) {
    const normalized = normalizeDashboardFilter(filter);
    if (!normalized) return '';
    const definition = DASHBOARD_FILTER_DEFINITIONS[normalized.field];
    const operator = definition.operators.find(candidate => candidate.value === normalized.operator);
    if (normalized.field === 'viewed') {
        const suffix = dashboardUsageCoversDays(normalized.operand) ? '' : ' — history unavailable';
        return `${definition.label} ${operator.chipLabel} ${normalized.operand}d${suffix}`;
    }
    if (normalized.field === 'owner' && normalized.operator === 'is') {
        const owners = normalized.operand.map(owner => `“${owner}”`).join(' or ');
        return `${definition.label} ${operator.chipLabel} ${owners}`;
    }
    return `${definition.label} ${operator.chipLabel} “${normalized.operand}”`;
}

function dashboardFilterValidation(filter) {
    const normalized = normalizeDashboardFilter(filter);
    if (!normalized) return { valid: false, reason: 'Choose a field, operator, and value.' };
    if (normalized.field === 'viewed' && !dashboardUsageCoversDays(normalized.operand)) {
        return { valid: false, reason: 'That lookback is outside the returned usage metric history.' };
    }
    const mergeTarget = normalized.field === 'owner' && normalized.operator === 'is'
        ? dashboardFilterState.filters.find(existing => {
            const current = normalizeDashboardFilter(existing);
            return current?.field === 'owner' && current.operator === 'is';
        })
        : null;
    if (!mergeTarget && dashboardFilterState.filters.length >= MAX_DASHBOARD_FILTERS) {
        return { valid: false, reason: `Up to ${MAX_DASHBOARD_FILTERS} filters can be applied.` };
    }
    const duplicate = dashboardFilterState.filters.some(existing => {
        const current = normalizeDashboardFilter(existing);
        if (current?.field === 'owner' && current.operator === 'is'
            && normalized.field === 'owner' && normalized.operator === 'is') {
            const currentOwners = new Set(current.operand.map(owner => owner.toLocaleLowerCase()));
            return normalized.operand.every(owner => currentOwners.has(owner.toLocaleLowerCase()));
        }
        return current
            && current.field === normalized.field
            && current.operator === normalized.operator
            && current.operand.toLocaleLowerCase() === normalized.operand.toLocaleLowerCase();
    });
    if (duplicate) return { valid: false, reason: 'That filter is already applied.' };
    if (mergeTarget) {
        const current = normalizeDashboardFilter(mergeTarget);
        const owners = new Set(current.operand.map(owner => owner.toLocaleLowerCase()));
        const additions = normalized.operand.filter(owner => !owners.has(owner.toLocaleLowerCase()));
        if (current.operand.length + additions.length > MAX_DASHBOARD_OWNER_FILTER_VALUES) {
            return {
                valid: false,
                reason: `Up to ${MAX_DASHBOARD_OWNER_FILTER_VALUES} owners can be included in one filter.`
            };
        }
    }
    return { valid: true, filter: normalized, reason: '' };
}

function addDashboardFilter(filter) {
    const validation = dashboardFilterValidation(filter);
    if (!validation.valid) return false;
    if (validation.filter.field === 'owner' && validation.filter.operator === 'is') {
        const existing = dashboardFilterState.filters.find(candidate => {
            const current = normalizeDashboardFilter(candidate);
            return current?.field === 'owner' && current.operator === 'is';
        });
        if (existing) {
            const current = normalizeDashboardFilter(existing);
            const owners = new Set(current.operand.map(owner => owner.toLocaleLowerCase()));
            existing.operand = [
                ...current.operand,
                ...validation.filter.operand.filter(owner => !owners.has(owner.toLocaleLowerCase()))
            ];
            return true;
        }
    }
    dashboardFilterState.filters.push({
        id: dashboardFilterState.nextId++,
        ...validation.filter
    });
    return true;
}

function removeDashboardFilter(filterId) {
    const index = dashboardFilterState.filters.findIndex(filter => String(filter.id) === String(filterId));
    if (index < 0) return false;
    dashboardFilterState.filters.splice(index, 1);
    return true;
}

function dashboardFilterCountMarkup(matchedCount, totalCount, appliedFilterCount) {
    const totalLabel = Number(totalCount || 0).toLocaleString();
    if (appliedFilterCount === 0) {
        return `Showing all <strong>${totalLabel}</strong> dashboard${totalCount === 1 ? '' : 's'}`;
    }
    const matchedLabel = Number(matchedCount || 0).toLocaleString();
    return `<strong>${matchedLabel}</strong> of <strong>${totalLabel}</strong> dashboard${totalCount === 1 ? '' : 's'} match <strong>${appliedFilterCount}</strong> applied filter${appliedFilterCount === 1 ? '' : 's'}`;
}

function renderDashboardAppliedFilters(filters = dashboardFilterState.filters) {
    const summary = document.getElementById('dashboardAppliedFilters');
    const chips = document.getElementById('dashboardAppliedFilterChips');
    if (!summary || !chips) return;
    chips.replaceChildren();
    filters.forEach(filter => {
        const label = describeDashboardFilter(filter);
        if (!label) return;
        const chip = document.createElement('span');
        chip.className = 'badge filter-chip';
        const text = document.createElement('span');
        text.textContent = label;
        chip.appendChild(text);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'filter-chip-remove';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove filter: ${label}`);
        remove.addEventListener('click', () => {
            if (!removeDashboardFilter(filter.id)) return;
            applyDashboardFilters();
            renderDashboards();
            syncDashboardFilterApplyButton();
        });
        chip.appendChild(remove);
        chips.appendChild(chip);
    });
    summary.hidden = filters.length === 0;
}

function dashboardUsageStatusText() {
    if (!dashboardUsageState.supported) {
        return dashboardUsageState.capabilityReason;
    }
    if (dashboardUsageState.status === 'complete') {
        return '';
    }
    if (dashboardUsageState.status === 'loading') {
        return 'Loading dashboard usage metrics…';
    }
    if (dashboardUsageState.status === 'unavailable') {
        return `Dashboard usage is unavailable: ${dashboardUsageState.error}`;
    }
    return '';
}

function renderDashboardUsageStatus() {
    const status = document.getElementById('dashboardUsageStatus');
    if (status) {
        status.textContent = dashboardUsageStatusText();
        status.hidden = !status.textContent;
    }
    updateDashboardFilterBuilder({ preserveOperator: true, preserveOperand: true });
}

function setDashboardSelectOptions(select, options, desiredValue = '') {
    if (!select) return;
    select.replaceChildren();
    options.forEach(item => {
        const option = document.createElement('option');
        option.value = String(item.value ?? '');
        option.textContent = String(item.label || '');
        option.disabled = Boolean(item.disabled);
        select.appendChild(option);
    });
    const desired = String(desiredValue || '');
    const desiredOption = Array.from(select.options).find(option => option.value === desired && !option.disabled);
    select.value = desiredOption ? desired : '';
    window.refreshCustomSelect?.(select);
}

function dashboardOwnerFilterOptions() {
    const owners = new Set((state.dashboards || []).map(dashboardOwnerValue));
    return Array.from(owners).sort((left, right) => left.localeCompare(right, undefined, {
        sensitivity: 'base'
    }));
}

function updateDashboardFilterBuilder({ preserveOperator = true, preserveOperand = true } = {}) {
    const fieldSelect = document.getElementById('dashboardFilterField');
    const operatorSelect = document.getElementById('dashboardFilterOperator');
    if (!fieldSelect || !operatorSelect) return;

    const viewedOption = Array.from(fieldSelect.options || [])
        .find(option => option.value === 'viewed');
    if (viewedOption) {
        viewedOption.disabled = !dashboardUsageState.supported;
        viewedOption.title = dashboardUsageState.supported ? '' : dashboardUsageState.capabilityReason;
    }
    const requestedField = DASHBOARD_FILTER_DEFINITIONS[fieldSelect.value] ? fieldSelect.value : 'name';
    const field = requestedField === 'viewed' && !dashboardUsageState.supported
        ? 'name'
        : requestedField;
    fieldSelect.value = field;
    const definition = DASHBOARD_FILTER_DEFINITIONS[field];
    const desiredOperator = preserveOperator ? operatorSelect.value : '';
    setDashboardSelectOptions(
        operatorSelect,
        definition.operators.map(operator => ({ value: operator.value, label: operator.label })),
        definition.operators.some(operator => operator.value === desiredOperator)
            ? desiredOperator
            : definition.operators[0].value
    );

    const textWrap = document.getElementById('dashboardFilterTextOperandWrap');
    const ownerWrap = document.getElementById('dashboardFilterOwnerOperandWrap');
    const viewedWrap = document.getElementById('dashboardFilterViewedOperandWrap');
    if (textWrap) textWrap.hidden = field !== 'name';
    if (ownerWrap) ownerWrap.hidden = field !== 'owner';
    if (viewedWrap) viewedWrap.hidden = field !== 'viewed';

    if (field === 'owner') {
        const ownerSelect = document.getElementById('dashboardFilterOwnerOperand');
        const desiredOwner = preserveOperand ? ownerSelect?.value : '';
        const owners = dashboardOwnerFilterOptions();
        setDashboardSelectOptions(ownerSelect, [
            {
                value: '',
                label: owners.length ? 'Select an owner…' : 'Load dashboards to list owners',
                disabled: true
            },
            ...owners.map(owner => ({ value: owner, label: owner }))
        ], desiredOwner);
        if (ownerSelect) ownerSelect.disabled = owners.length === 0;
        ownerWrap?.classList.toggle('is-placeholder', !ownerSelect?.value);
        window.refreshCustomSelect?.(ownerSelect);
    } else if (field === 'viewed') {
        const viewedSelect = document.getElementById('dashboardFilterViewedOperand');
        const desiredLookback = preserveOperand ? viewedSelect?.value : '';
        const lookbacks = dashboardUsageLookbackOptions();
        setDashboardSelectOptions(viewedSelect, [
            { value: '', label: dashboardUsageHistoryPlaceholder(), disabled: true },
            ...lookbacks.map(days => ({ value: String(days), label: `${days} days` }))
        ], desiredLookback);
        if (viewedSelect) viewedSelect.disabled = lookbacks.length === 0;
        viewedWrap?.classList.toggle('is-placeholder', !viewedSelect?.value);
        window.refreshCustomSelect?.(viewedSelect);
    }

    syncDashboardFilterApplyButton();
}

function readDashboardFilterBuilder() {
    const field = document.getElementById('dashboardFilterField')?.value || '';
    const operator = document.getElementById('dashboardFilterOperator')?.value || '';
    let operand = '';
    if (field === 'name') operand = document.getElementById('dashboardFilterTextOperand')?.value || '';
    if (field === 'owner') operand = document.getElementById('dashboardFilterOwnerOperand')?.value || '';
    if (field === 'viewed') operand = document.getElementById('dashboardFilterViewedOperand')?.value || '';
    return { field, operator, operand };
}

function syncDashboardFilterApplyButton() {
    const button = document.getElementById('addDashboardFilterBtn');
    if (!button) return;
    const validation = dashboardFilterValidation(readDashboardFilterBuilder());
    button.disabled = !validation.valid;
    button.title = validation.reason;

    const ownerSelect = document.getElementById('dashboardFilterOwnerOperand');
    const viewedSelect = document.getElementById('dashboardFilterViewedOperand');
    document.getElementById('dashboardFilterOwnerOperandWrap')
        ?.classList.toggle('is-placeholder', !ownerSelect?.value);
    document.getElementById('dashboardFilterViewedOperandWrap')
        ?.classList.toggle('is-placeholder', !viewedSelect?.value);
}

function resetDashboardFilterOperand() {
    const field = document.getElementById('dashboardFilterField')?.value;
    if (field === 'name') {
        const input = document.getElementById('dashboardFilterTextOperand');
        if (input) input.value = '';
    }
    if (field === 'owner') {
        const select = document.getElementById('dashboardFilterOwnerOperand');
        if (select) select.value = '';
        window.refreshCustomSelect?.(select);
    }
    if (field === 'viewed') {
        const select = document.getElementById('dashboardFilterViewedOperand');
        if (select) select.value = '';
        window.refreshCustomSelect?.(select);
    }
    syncDashboardFilterApplyButton();
}

function addDashboardFilterFromBuilder() {
    if (!addDashboardFilter(readDashboardFilterBuilder())) {
        syncDashboardFilterApplyButton();
        return false;
    }
    resetDashboardFilterOperand();
    applyDashboardFilters();
    renderDashboards();
    return true;
}

function clearDashboardFilters() {
    dashboardFilterState.filters.length = 0;
    applyDashboardFilters();
    renderDashboards();
    syncDashboardFilterApplyButton();
}

async function loadDashboardUsage(dashboards) {
    dashboardUsageState.status = 'loading';
    dashboardUsageState.error = '';
    renderDashboardUsageStatus();
    try {
        const usage = await window.apiClient.getDashboardUsage(DASHBOARD_USAGE_LOOKBACK_DAYS);
        dashboardUsageState.status = usage?.status === 'complete' ? 'complete' : 'unavailable';
        dashboardUsageState.requestedFromMs = dashboardFiniteTimestamp(usage?.requestedFromMs);
        dashboardUsageState.coverageFromMs = dashboardFiniteTimestamp(
            usage?.coverageFromMs ?? usage?.fromMs
        );
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
        dashboardUsageState.requestedFromMs = null;
        dashboardUsageState.coverageFromMs = null;
        dashboardUsageState.untilMs = null;
        dashboardUsageState.error = error?.message || 'metric query failed';
        attachDashboardUsage(dashboards, null);
    }
    renderDashboardUsageStatus();
}

function setDashboardUsageCapability(capability) {
    dashboardUsageState.supported = Boolean(capability?.supported);
    dashboardUsageState.capabilityReason = String(capability?.reason || '');
    document.querySelectorAll?.('.dashboard-usage-column').forEach(element => {
        element.hidden = !dashboardUsageState.supported;
    });
    if (!dashboardUsageState.supported) {
        dashboardUsageState.status = 'unavailable';
        dashboardUsageState.requestedFromMs = null;
        dashboardUsageState.coverageFromMs = null;
        dashboardUsageState.untilMs = null;
        dashboardUsageState.error = dashboardUsageState.capabilityReason;
        dashboardFilterState.filters = dashboardFilterState.filters
            .filter(filter => filter.field !== 'viewed');
        attachDashboardUsage(state.dashboards, null);
    }
    renderDashboardUsageStatus();
}

async function resolveDashboardUsageCapability() {
    const runtimeContext = typeof runtimeContextForState === 'function'
        ? runtimeContextForState(state)
        : (state?.apiConfig?.type || 'offline');
    if (runtimeContext === '360') {
        return typeof dashboardUsageCapability === 'function'
            ? dashboardUsageCapability(runtimeContext, [])
            : { supported: true, reason: '' };
    }
    try {
        const appliances = await window.apiClient.getAppliances();
        if (typeof dashboardUsageCapability === 'function') {
            return dashboardUsageCapability(runtimeContext, appliances);
        }
        const localAppliance = appliances.find(appliance => String(appliance?.id) === '0');
        const supported = String(localAppliance?.platform || '').toLowerCase() === 'command';
        return {
            supported,
            reason: supported
                ? ''
                : (localAppliance
                    ? 'Usage metrics are not available on sensors.'
                    : 'Dashboard usage metrics are unavailable because the connected appliance type could not be determined.')
        };
    } catch {
        return {
            supported: false,
            reason: 'Dashboard usage metrics are unavailable because the connected appliance type could not be determined.'
        };
    }
}

function dashboardConfigurationBackupCapability() {
    const runtimeContext = typeof runtimeContextForState === 'function'
        ? runtimeContextForState(state)
        : (state?.connected && state?.apiConfig?.type === 'enterprise' ? 'enterprise' : 'offline');
    const supported = typeof deploymentSupportsApiFamily === 'function'
        ? deploymentSupportsApiFamily(runtimeContext, 'configurationBackups')
        : runtimeContext === 'enterprise';
    return {
        supported,
        reason: supported
            ? ''
            : 'Configuration backups are available only with RevealX Enterprise.'
    };
}

function dashboardConfigurationBackupName(now = Date.now()) {
    const timestamp = new Date(now).toISOString().replace(/\D/g, '').slice(0, 17);
    return `eh-admin-tools-dashboard-backup-${timestamp}`;
}

function setDashboardBackupStatus(action, message, tone = '') {
    const status = document.getElementById(dashboardBackupUi[action]?.statusId);
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
    status.classList.remove('is-success', 'is-error');
    if (tone) status.classList.add(`is-${tone}`);
}

function syncDashboardBackupButtonAvailability(action, forceBusy = false) {
    const ui = dashboardBackupUi[action];
    const button = document.getElementById(ui?.buttonId);
    if (!button) return;
    const capability = dashboardConfigurationBackupCapability();
    const container = button.closest?.('.dashboard-backup-option');
    if (container) container.hidden = !capability.supported;
    const busy = forceBusy || Boolean(dashboardConfigurationBackupState.promise) || isDashboardMutationRunning();
    button.disabled = !capability.supported || busy || button.dataset.backupCreated === 'true';
    button.title = capability.reason;
}

function prepareDashboardBackupControl(action) {
    const ui = dashboardBackupUi[action];
    const button = document.getElementById(ui?.buttonId);
    if (!button) return;
    const capability = dashboardConfigurationBackupCapability();
    const container = button.closest?.('.dashboard-backup-option');
    if (container) container.hidden = !capability.supported;
    button.textContent = 'Take a configuration backup before applying change';
    delete button.dataset.backupCreated;
    setDashboardBackupStatus(action, '');
    syncDashboardBackupButtonAvailability(action);
}

async function takeDashboardConfigurationBackup(action) {
    const ui = dashboardBackupUi[action];
    const button = document.getElementById(ui?.buttonId);
    const confirmButton = document.getElementById(ui?.confirmButtonId);
    const capability = dashboardConfigurationBackupCapability();
    if (!ui || !button || !capability.supported || dashboardConfigurationBackupState.promise) return false;

    const backupName = dashboardConfigurationBackupName();
    button.disabled = true;
    button.textContent = 'Creating configuration backup…';
    if (confirmButton) confirmButton.disabled = true;
    setDashboardBackupStatus(action, `Creating ${backupName}…`);
    dashboardConfigurationBackupState.action = action;
    dashboardConfigurationBackupState.promise = Promise.resolve().then(() => (
        window.apiClient.createConfigurationBackup(backupName)
    ));

    try {
        await dashboardConfigurationBackupState.promise;
        button.dataset.backupCreated = 'true';
        button.textContent = 'Configuration backup created';
        setDashboardBackupStatus(action, `${backupName} was created.`, 'success');
        return true;
    } catch (error) {
        button.textContent = 'Retry configuration backup';
        setDashboardBackupStatus(
            action,
            `Configuration backup failed: ${error?.message || error}`,
            'error'
        );
        return false;
    } finally {
        dashboardConfigurationBackupState.promise = null;
        dashboardConfigurationBackupState.action = null;
        syncDashboardBackupButtonAvailability(action);
        if (confirmButton && !isDashboardMutationRunning()) confirmButton.disabled = false;
    }
}

function dashboardNeedsHighImpactConfirmation(dashboardCount) {
    return Number(dashboardCount) > DASHBOARD_HIGH_IMPACT_THRESHOLD;
}

function dashboardOwnerChangeConfirmationText(dashboardIds, newOwner) {
    const owners = new Set((dashboardIds || []).map(id => dashboardOwnerValue(findDashboardById(id))));
    let currentOwners = 'their current owners';
    if (owners.size === 1) currentOwners = Array.from(owners)[0];
    if (owners.size > 1) currentOwners = `${owners.size} current owners`;
    const count = dashboardIds?.length || 0;
    return `Type "confirm" to change owner of ${count} dashboards from ${currentOwners} to ${newOwner}.`;
}

function dashboardDeleteConfirmationText(dashboardIds) {
    return `Type "confirm" to delete ${dashboardIds?.length || 0} dashboards.`;
}

function dashboardConfirmationPhraseIsValid(value) {
    return String(value || '').trim() === 'confirm';
}

function showDashboardHighImpactConfirmation(pending) {
    dashboardHighImpactState.pending = pending;
    const description = pending.action === 'owner'
        ? dashboardOwnerChangeConfirmationText(pending.dashboardIds, pending.newOwner)
        : dashboardDeleteConfirmationText(pending.dashboardIds);
    const input = document.getElementById('dashboardHighImpactInput');
    const confirmButton = document.getElementById('confirmDashboardHighImpact');
    document.getElementById('dashboardHighImpactDescription').textContent = description;
    input.value = '';
    confirmButton.disabled = true;
    hideModal(pending.sourceModalId);
    showModal('dashboardHighImpactConfirmModal');
    input.focus?.();
}

function syncDashboardHighImpactConfirmation() {
    const input = document.getElementById('dashboardHighImpactInput');
    const confirmButton = document.getElementById('confirmDashboardHighImpact');
    if (!input || !confirmButton) return;
    confirmButton.disabled = !dashboardConfirmationPhraseIsValid(input.value);
}

function cancelDashboardHighImpactConfirmation() {
    const pending = dashboardHighImpactState.pending;
    dashboardHighImpactState.pending = null;
    hideModal('dashboardHighImpactConfirmModal');
    if (pending?.sourceModalId) showModal(pending.sourceModalId);
}

async function confirmDashboardHighImpactChange() {
    const input = document.getElementById('dashboardHighImpactInput');
    const pending = dashboardHighImpactState.pending;
    if (!pending || !dashboardConfirmationPhraseIsValid(input.value)) return;

    dashboardHighImpactState.pending = null;
    hideModal('dashboardHighImpactConfirmModal');
    showModal(pending.sourceModalId);
    if (pending.action === 'owner') {
        await executeDashboardOwnerChange(pending);
    } else {
        await executeDashboardDelete(pending.dashboardIds);
    }
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

    Object.keys(dashboardBackupUi).forEach(action => {
        syncDashboardBackupButtonAvailability(action, busy);
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
        const usageCapability = await resolveDashboardUsageCapability();
        setDashboardUsageCapability(usageCapability);
        const [users] = await Promise.all([
            window.apiClient.getUsers(),
            usageCapability.supported
                ? loadDashboardUsage(state.dashboards)
                : Promise.resolve()
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
        updateDashboardFilterBuilder({ preserveOperator: true, preserveOperand: true });

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
        loadBtn.textContent = 'Refresh dashboards';
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
    state.filteredDashboards = state.dashboards.filter(dashboard => (
        dashboardFilterState.filters.every(filter => dashboardFilterMatches(dashboard, filter))
    ));

    state.currentPage = 1;
}

function getCurrentPageDashboards() {
    const start = (state.currentPage - 1) * DASHBOARD_PAGE_SIZE;
    const end = start + DASHBOARD_PAGE_SIZE;
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
            <td class="dashboard-usage-column"${dashboardUsageState.supported ? '' : ' hidden'}>${escapeHtml(formatDashboardLastViewed(dashboard))}</td>
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
                    'Recorded views',
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
    const totalPages = Math.ceil(state.filteredDashboards.length / DASHBOARD_PAGE_SIZE);
    const paginationInfo = document.getElementById('paginationInfo');
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    const filterCount = document.getElementById('dashboardFilterCount');
    renderDashboardAppliedFilters();
    filterCount.innerHTML = dashboardFilterCountMarkup(
        state.filteredDashboards.length,
        state.dashboards.length,
        dashboardFilterState.filters.length
    );

    if (state.filteredDashboards.length === 0) {
        paginationInfo.textContent = 'Showing 0 of 0';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        return;
    }

    const start = (state.currentPage - 1) * DASHBOARD_PAGE_SIZE + 1;
    const end = Math.min(start + DASHBOARD_PAGE_SIZE - 1, state.filteredDashboards.length);

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
    prepareDashboardBackupControl('owner');
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
    if (dashboardNeedsHighImpactConfirmation(dashboardIds.length)) {
        showDashboardHighImpactConfirmation({
            action: 'owner',
            sourceModalId: 'changeOwnerModal',
            dashboardIds,
            newOwner,
            grantAccess
        });
        return;
    }
    await executeDashboardOwnerChange({ dashboardIds, newOwner, grantAccess });
}

async function executeDashboardOwnerChange({ dashboardIds, newOwner, grantAccess }) {
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
    prepareDashboardBackupControl('delete');
    showModal('deleteConfirmModal');
}

async function confirmDashboardDelete() {
    const dashboardIds = Array.from(state.selectedDashboards);
    if (dashboardNeedsHighImpactConfirmation(dashboardIds.length)) {
        showDashboardHighImpactConfirmation({
            action: 'delete',
            sourceModalId: 'deleteConfirmModal',
            dashboardIds
        });
        return;
    }
    await executeDashboardDelete(dashboardIds);
}

async function executeDashboardDelete(dashboardIds) {
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

    if (results.errors.length > 0) {
        alert(`${results.errors.length} deletion operation(s) failed. Review the refreshed dashboard list before retrying.`);
    }
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
        updateDashboardFilterBuilder({ preserveOperator: true, preserveOperand: true });
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
        
        document.getElementById('dashboardFilterField').addEventListener('change', () => {
            updateDashboardFilterBuilder({ preserveOperator: false, preserveOperand: false });
        });
        document.getElementById('dashboardFilterOperator').addEventListener('change', syncDashboardFilterApplyButton);
        document.getElementById('dashboardFilterTextOperand').addEventListener('input', syncDashboardFilterApplyButton);
        document.getElementById('dashboardFilterTextOperand').addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            addDashboardFilterFromBuilder();
        });
        document.getElementById('dashboardFilterOwnerOperand').addEventListener('change', syncDashboardFilterApplyButton);
        document.getElementById('dashboardFilterViewedOperand').addEventListener('change', syncDashboardFilterApplyButton);
        document.getElementById('addDashboardFilterBtn').addEventListener('click', addDashboardFilterFromBuilder);
        document.getElementById('clearDashboardFiltersBtn').addEventListener('click', clearDashboardFilters);

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
            const totalPages = Math.ceil(state.filteredDashboards.length / DASHBOARD_PAGE_SIZE);
            if (state.currentPage < totalPages) {
                state.currentPage++;
                renderDashboards();
            }
        });

        // Modal event listeners
        document.getElementById('cancelChangeOwner').addEventListener('click', () => hideModal('changeOwnerModal'));
        document.getElementById('confirmChangeOwner').addEventListener('click', confirmDashboardChangeOwner);
        document.getElementById('backupBeforeOwnerChange').addEventListener('click', () => {
            takeDashboardConfigurationBackup('owner');
        });

        document.getElementById('cancelModifySharing').addEventListener('click', () => hideModal('modifySharingModal'));
        document.getElementById('confirmModifySharing').addEventListener('click', confirmDashboardModifySharing);

        document.getElementById('cancelDelete').addEventListener('click', () => hideModal('deleteConfirmModal'));
        document.getElementById('confirmDelete').addEventListener('click', confirmDashboardDelete);
        document.getElementById('backupBeforeDelete').addEventListener('click', () => {
            takeDashboardConfigurationBackup('delete');
        });

        document.getElementById('dashboardHighImpactInput').addEventListener('input', syncDashboardHighImpactConfirmation);
        document.getElementById('dashboardHighImpactInput').addEventListener('keydown', event => {
            if (event.key !== 'Enter' || !dashboardConfirmationPhraseIsValid(event.currentTarget.value)) return;
            event.preventDefault();
            confirmDashboardHighImpactChange();
        });
        document.getElementById('cancelDashboardHighImpact').addEventListener('click', cancelDashboardHighImpactConfirmation);
        document.getElementById('confirmDashboardHighImpact').addEventListener('click', confirmDashboardHighImpactChange);
    }
    updateDashboardFilterBuilder({ preserveOperator: true, preserveOperand: true });
}

if (typeof featureRegistry !== 'undefined') {
    featureRegistry.register('dashboards', {
        initialize: initDashboardsModule,
        activate: activateDashboardsModule
    });
}
