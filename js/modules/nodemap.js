// Connected Appliances — fleet list and appliance topology
//
// Two views over the same appliance list. The list is the default because the
// topology is a star: every sensor hangs off one console, so the edges carry
// one fact repeated once per node. The list sorts, groups, and surfaces the
// facts that matter across a large fleet — status spread and firmware drift.

const nodemapState = {
    appliances: [],
    catalogData: [],
    searchTerm: '',
    view: 'list',
    groupBy: 'status',
    sortKey: 'name',
    sortDir: 'asc',
    selectedId: null,
    firmwareAvailability: {},
    cloudServices: { status: 'not-applicable', data: null, error: null },
    productKeys: { applianceId: null, status: 'idle', values: [], revealed: false, error: null },
    upgradeJobs: {},
    upgradeTarget: null,
    loadController: null,
    jobController: null,
    filters: {
        discover: true,
        trace: true,
        efc: true,
        other: true,
        physical: true,
        virtual: true,
        offline: true,
        online: true
    }
};

// Platform colors use the shared categorical chart palette.
const platformColors = {
    'command': genericChartPrimaryColor(),
    'packet_sensor': genericChartPaletteColor(0),
    'discover': genericChartPaletteColor(0),
    'packetstore': genericChartPaletteColor(1),
    'trace': genericChartPaletteColor(1),
    'multifunction_sensor': genericChartPaletteColor(0),
    'all_in_one': genericChartPaletteColor(0),
    'efc': genericChartPaletteColor(2)
};

const roleLabels = {
    command: 'Console',
    discover: 'Packet sensor',
    trace: 'Packetstore',
    efc: 'Flow collector',
    other: 'Other'
};

// Problems sort and group ahead of healthy appliances.
const statusRank = { error: 0, warning: 1, unknown: 2, online: 3 };

const listColumns = [
    { key: 'name', label: 'Name' },
    { key: 'role', label: 'Role' },
    { key: 'model', label: 'Model' },
    { key: 'type', label: 'Type' },
    { key: 'firmware', label: 'Firmware' },
    { key: 'availableFirmware', label: 'Available firmware' },
    { key: 'modules', label: 'Modules', sortable: false }
];

/* ------------------------------- Appliance facts ------------------------------- */

function getCatalogInfo(licensePlatform) {
    if (!licensePlatform) return null;

    const modelName = licensePlatform.replace(/_TRACE$/, '');
    return nodemapState.catalogData.find(item => item.name === modelName || item.name === licensePlatform);
}

// Determine platform type and characteristics
function getNodeInfo(appliance) {
    const catalogInfo = getCatalogInfo(appliance.license_platform);

    let platform = appliance.platform;
    let isVirtual = false;
    let hasIntegratedTrace = false;

    if (catalogInfo) {
        platform = catalogInfo.platform;
        isVirtual = !catalogInfo.is_physical;

        if (appliance.license_platform && appliance.license_platform.includes('_TRACE')) {
            hasIntegratedTrace = true;
        }
    } else {
        // Fallback: check if model name has V before underscore or at end
        const licensePlatform = appliance.license_platform || '';
        if (licensePlatform.match(/V(_|$)/) || licensePlatform.includes('ECA')) {
            isVirtual = true;
        }
    }

    const statusMessage = (appliance.status_message || '').toString().toLowerCase();
    const isOffline = statusMessage && statusMessage !== 'online';

    return { platform, isVirtual, hasIntegratedTrace, isOffline };
}

function getStatusInfo(appliance) {
    const rawStatus = (appliance.status_message || '').toString();
    const normalized = rawStatus.toLowerCase();

    let level = 'unknown';
    if (normalized === 'online') {
        level = 'online';
    } else if (normalized.includes('unable to connect')) {
        level = 'error';
    } else if (normalized.includes('requires additional configuration')) {
        level = 'warning';
    }

    let circleColor = stateIndicatorColor('unknown');
    let badgeClass = 'badge';

    if (level === 'online') {
        circleColor = stateIndicatorColor('online');
        badgeClass = 'badge badge-success';
    } else if (level === 'error') {
        circleColor = stateIndicatorColor('error');
        badgeClass = 'badge badge-danger';
    } else if (level === 'warning') {
        circleColor = stateIndicatorColor('warning');
        badgeClass = 'badge badge-warning';
    }

    return {
        statusText: rawStatus || 'Unknown',
        level,
        circleColor,
        badgeClass
    };
}

// Logical role, derived once so the filter, the list, and the graph agree.
function getRole(appliance, info) {
    const model = (appliance.license_platform || '').toString().toUpperCase();

    if (info.platform === 'command') return 'command';
    if (model.startsWith('EFC')) return 'efc';
    if (model.startsWith('EDA')) return 'discover';
    if ((info.platform === 'packetstore' || info.platform === 'trace') && !info.hasIntegratedTrace) return 'trace';
    return 'other';
}

function getDisplayName(appliance) {
    return appliance.display_name || appliance.hostname || `Appliance ${appliance.id}`;
}

function toArray(value) {
    if (Array.isArray(value)) return value;
    return value ? [value] : [];
}

// One normalized record per appliance, so views never re-derive these facts.
function describeAppliance(appliance) {
    const info = getNodeInfo(appliance);
    const status = getStatusInfo(appliance);
    const role = getRole(appliance, info);

    return {
        appliance,
        info,
        status,
        role,
        name: getDisplayName(appliance),
        model: appliance.license_platform || appliance.platform || 'Unknown',
        firmware: appliance.firmware_version || 'Unknown',
        firmwareAvailability: nodemapState.firmwareAvailability[String(appliance.id)]
            || { status: 'loading', versions: [] },
        typeLabel: info.isVirtual ? 'Virtual' : 'Physical',
        modules: toArray(appliance.product_modules).map(m => (m == null ? '' : m.toString().toUpperCase()))
    };
}

/* ------------------------------- Filter and search ------------------------------- */

function matchesSearch(appliance) {
    if (!nodemapState.searchTerm) return true;

    const term = nodemapState.searchTerm.toLowerCase();
    const searchableFields = [
        appliance.display_name,
        appliance.hostname,
        appliance.nickname,
        appliance.license_platform,
        appliance.platform,
        appliance.firmware_version,
        appliance.status_message,
        appliance.uuid,
        appliance.id?.toString(),
        ...toArray(appliance.product_modules),
        ...toArray(appliance.licensed_modules)
    ];

    return searchableFields.some(field =>
        field && field.toString().toLowerCase().includes(term)
    );
}

function passesFilters(record) {
    const { filters } = nodemapState;

    // Console nodes are always shown
    if (record.role !== 'command') {
        if (record.role === 'discover' && !filters.discover) return false;
        if (record.role === 'trace' && !filters.trace) return false;
        if (record.role === 'efc' && !filters.efc) return false;
        if (record.role === 'other' && !filters.other) return false;
    }

    if (record.info.isVirtual && !filters.virtual) return false;
    if (!record.info.isVirtual && !filters.physical) return false;

    // Connection status filters apply only to true online/error states
    if (record.status.level === 'online' && !filters.online) return false;
    if (record.status.level === 'error' && !filters.offline) return false;

    return matchesSearch(record.appliance);
}

function getVisibleRecords() {
    return nodemapState.appliances
        .map(describeAppliance)
        .filter(passesFilters);
}

/* ------------------------------- Loading ------------------------------- */

async function loadAppliances() {
    if (!state.connected) {
        showNodemapWelcome();
        return;
    }

    nodemapState.loadController?.abort();
    const controller = new AbortController();
    nodemapState.loadController = controller;

    try {
        document.getElementById('nodemapWelcome').style.display = 'none';

        nodemapState.appliances = await window.apiClient.getAppliances({ signal: controller.signal });
        nodemapState.firmwareAvailability = Object.fromEntries(
            nodemapState.appliances.map(appliance => [
                String(appliance.id),
                {
                    status: String(appliance.id) === '0' && !deploymentSupportsApiFamily(
                        state.apiConfig?.type,
                        'localApplianceFirmware'
                    ) ? 'not-applicable' : 'loading',
                    versions: []
                }
            ])
        );

        const firmwarePromise = window.apiClient.getApplianceFirmwareVersions([], {
            signal: controller.signal
        });
        const localFirmwareSupported = deploymentSupportsApiFamily(
            state.apiConfig?.type,
            'localApplianceFirmware'
        );
        const localFirmwarePromise = localFirmwareSupported
            ? window.apiClient.getLocalApplianceFirmwareVersions({ signal: controller.signal })
            : Promise.resolve(null);
        const cloudSupported = deploymentSupportsApiFamily(
            state.apiConfig?.type,
            'applianceCloudServices'
        );
        const cloudPromise = cloudSupported
            ? window.apiClient.getApplianceCloudServices({ signal: controller.signal })
            : Promise.resolve(null);

        // Catalog data sharpens platform and physical/virtual detection
        const catalogPromise = (async () => {
            try {
                const response = await fetch('/backend/system-health/catalog', { signal: controller.signal });
                if (response.ok) {
                    const catalog = await response.json();
                    return Array.isArray(catalog.models) ? catalog.models : [];
                }
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                console.warn('Could not load catalog data, using basic platform detection');
            }
            return [];
        })();

        const [firmwareResult, localFirmwareResult, cloudResult, catalogResult] = await Promise.allSettled([
            firmwarePromise,
            localFirmwarePromise,
            cloudPromise,
            catalogPromise
        ]);
        if (controller.signal.aborted) return;

        if (firmwareResult.status === 'fulfilled') {
            nodemapState.firmwareAvailability = ApplianceManagement.buildFirmwareAvailability(
                nodemapState.appliances,
                firmwareResult.value
            );
        } else {
            nodemapState.firmwareAvailability = ApplianceManagement.buildFirmwareAvailability(
                nodemapState.appliances,
                [],
                firmwareResult.reason
            );
        }

        if (localFirmwareSupported) {
            nodemapState.firmwareAvailability = ApplianceManagement.mergeLocalFirmwareAvailability(
                nodemapState.firmwareAvailability,
                localFirmwareResult.status === 'fulfilled' ? localFirmwareResult.value : [],
                localFirmwareResult.status === 'rejected' ? localFirmwareResult.reason : null
            );
        }

        if (!cloudSupported) {
            nodemapState.cloudServices = { status: 'not-applicable', data: null, error: null };
        } else if (cloudResult.status === 'fulfilled') {
            nodemapState.cloudServices = { status: 'available', data: cloudResult.value, error: null };
        } else {
            nodemapState.cloudServices = { status: 'failed', data: null, error: cloudResult.reason };
        }

        if (catalogResult.status === 'fulfilled') {
            nodemapState.catalogData = catalogResult.value;
        } else {
            nodemapState.catalogData = [];
        }

        document.getElementById('graphContainer').style.display = 'flex';
        showNodemapControls();
        renderNodemap();
    } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error('Error loading appliances:', error);
        showNodemapWelcome();
    } finally {
        if (nodemapState.loadController === controller) nodemapState.loadController = null;
    }
}

function showNodemapWelcome() {
    document.getElementById('nodemapWelcome').style.display = 'flex';
    document.getElementById('graphContainer').style.display = 'none';
    document.getElementById('nodemapSummary').style.display = 'none';
    hideNodemapControls();
}

/* ------------------------------- View dispatch ------------------------------- */

function renderNodemap() {
    const records = getVisibleRecords();
    const isList = nodemapState.view === 'list';

    renderSummary(records);

    document.getElementById('listMainArea').style.display = isList ? 'block' : 'none';
    document.getElementById('graphMainArea').style.display = isList ? 'none' : 'block';
    document.getElementById('nodemapGroupControl').style.display = isList ? 'flex' : 'none';

    document.querySelectorAll('#nodemapViewToggle button').forEach(btn => {
        const active = btn.dataset.view === nodemapState.view;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    if (isList) {
        renderList(records);
    } else {
        renderGraph(records);
    }
}

/* ------------------------------- Summary strip ------------------------------- */

function renderSummary(records) {
    const summary = document.getElementById('nodemapSummary');
    const online = records.filter(r => r.status.level === 'online').length;
    const unreachable = records.filter(r => r.status.level === 'error').length;
    const firmwareCount = new Set(records.map(r => r.firmware)).size;
    const upgradeable = records.filter(r => r.firmwareAvailability.status === 'available').length;

    // Status counts beyond these two are visible as their own list groups.
    const cards = [
        { label: 'Appliances', value: records.length },
        { label: 'Online', value: online },
        { label: 'Unreachable', value: unreachable, tone: unreachable > 0 ? 'danger' : '' },
        { label: 'Firmware versions', value: firmwareCount, tone: firmwareCount > 1 ? 'warn' : '' },
        { label: 'Upgradeable', value: upgradeable, tone: upgradeable > 0 ? 'warn' : '' }
    ];

    summary.innerHTML = cards.map(card => `
        <div class="stat ${card.tone ? `stat-${card.tone}` : ''}">
            <div class="stat-label">${escapeHtml(card.label)}</div>
            <div class="stat-value">${card.value}</div>
        </div>
    `).join('');

    summary.style.display = 'grid';
}

/* ------------------------------- List view ------------------------------- */

function sortValue(record, key) {
    switch (key) {
        case 'role': return roleLabels[record.role] || record.role;
        case 'model': return record.model;
        case 'type': return record.typeLabel;
        case 'firmware': return record.firmware;
        case 'availableFirmware': return firmwareAvailabilityText(record.firmwareAvailability);
        default: return record.name;
    }
}

function sortRecords(records) {
    const { sortKey, sortDir } = nodemapState;
    const direction = sortDir === 'desc' ? -1 : 1;

    return [...records].sort((a, b) => {
        const compared = sortValue(a, sortKey).localeCompare(
            sortValue(b, sortKey), undefined, { numeric: true, sensitivity: 'base' }
        );
        // Name is the stable tiebreak so equal keys never shuffle between renders.
        return compared !== 0 ? compared * direction : a.name.localeCompare(b.name);
    });
}

function groupKeyFor(record) {
    switch (nodemapState.groupBy) {
        case 'status': return record.status.statusText;
        case 'role': return roleLabels[record.role] || record.role;
        case 'model': return record.model;
        case 'firmware': return record.firmware;
        default: return '';
    }
}

// Groups keep their own order: worst status first when grouping by status,
// otherwise alphabetical.
function buildGroups(records) {
    if (nodemapState.groupBy === 'none') {
        return [{ key: '', records }];
    }

    const groups = new Map();
    records.forEach(record => {
        const key = groupKeyFor(record);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
    });

    const entries = [...groups.entries()].map(([key, groupRecords]) => ({ key, records: groupRecords }));

    if (nodemapState.groupBy === 'status') {
        entries.sort((a, b) =>
            statusRank[a.records[0].status.level] - statusRank[b.records[0].status.level] ||
            a.key.localeCompare(b.key)
        );
    } else {
        entries.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    }

    return entries;
}

function firmwareAvailabilityText(availability) {
    switch (availability?.status) {
        case 'available':
            return availability.versions.map(item => item.version).join(', ');
        case 'no-upgrade':
            return 'No eligible upgrade';
        case 'failed':
            return 'Unavailable';
        case 'not-applicable':
            return 'Local appliance';
        default:
            return 'Checking…';
    }
}

function firmwareAvailabilityBadge(availability) {
    const text = firmwareAvailabilityText(availability);
    if (availability?.status === 'available') {
        const extra = availability.versions.length > 1 ? ` +${availability.versions.length - 1}` : '';
        return `<span class="badge badge-warning mono xsmall">${escapeHtml(availability.versions[0].version)}${extra}</span>`;
    }
    if (availability?.status === 'failed') {
        return `<span class="badge badge-danger">${escapeHtml(text)}</span>`;
    }
    return `<span class="muted xsmall">${escapeHtml(text)}</span>`;
}

function renderList(records) {
    const body = document.getElementById('listMainArea');

    if (records.length === 0) {
        body.innerHTML = '<div class="empty-inline"><p>No appliances match the current filters.</p></div>';
        return;
    }

    const sorted = sortRecords(records);
    const groups = buildGroups(sorted);
    const columnCount = listColumns.length;

    const head = listColumns.map(column => {
        if (column.sortable === false) {
            return `<th>${escapeHtml(column.label)}</th>`;
        }
        const isSorted = nodemapState.sortKey === column.key;
        const arrow = isSorted ? (nodemapState.sortDir === 'asc' ? '↑' : '↓') : '';
        return `<th class="th-sort ${isSorted ? 'is-sorted' : ''}" data-sort="${column.key}"
                    role="button" tabindex="0"
                    aria-sort="${isSorted ? (nodemapState.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}">
                    ${escapeHtml(column.label)}<span class="th-arrow">${arrow}</span></th>`;
    }).join('');

    const rows = groups.map(group => {
        const header = group.key
            ? `<tr class="group-row group-${group.records[0].status.level}">
                   <td colspan="${columnCount}">${escapeHtml(group.key)} · ${group.records.length}</td>
               </tr>`
            : '';

        return header + group.records.map(record => `
            <tr class="appliance-row ${record.appliance.id === nodemapState.selectedId ? 'is-selected' : ''}"
                data-id="${record.appliance.id}" tabindex="0">
                <td class="primary-cell">
                    <span class="status-dot" style="background-color:${record.status.circleColor}"
                          title="${escapeHtml(record.status.statusText)}"></span>
                    <span class="row-name">${escapeHtml(record.name)}</span>
                </td>
                <td>${escapeHtml(roleLabels[record.role] || record.role)}</td>
                <td class="mono xsmall">${escapeHtml(record.model)}</td>
                <td>${escapeHtml(record.typeLabel)}</td>
                <td class="mono xsmall">${escapeHtml(record.firmware)}</td>
                <td>${firmwareAvailabilityBadge(record.firmwareAvailability)}</td>
                <td class="row-modules">
                    ${record.modules.map(m => `<span class="badge">${escapeHtml(m)}</span>`).join('')}
                    ${record.info.hasIntegratedTrace ? '<span class="badge">PCAP</span>' : ''}
                </td>
            </tr>
        `).join('');
    }).join('');

    body.innerHTML = `
        <table class="appliance-table">
            <thead><tr>${head}</tr></thead>
            <tbody>${rows}</tbody>
        </table>
    `;

    body.querySelectorAll('.th-sort').forEach(th => {
        const activate = () => {
            const key = th.dataset.sort;
            if (nodemapState.sortKey === key) {
                nodemapState.sortDir = nodemapState.sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                nodemapState.sortKey = key;
                nodemapState.sortDir = 'asc';
            }
            renderNodemap();
        };
        th.addEventListener('click', activate);
        th.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
            }
        });
    });

    body.querySelectorAll('.appliance-row').forEach(row => {
        const open = () => {
            const record = records.find(r => r.appliance.id?.toString() === row.dataset.id);
            if (record) selectAppliance(record);
        };
        row.addEventListener('click', open);
        row.addEventListener('keydown', event => {
            if (event.key === 'Enter') open();
        });
    });
}

/* ------------------------------- Topology view ------------------------------- */

// Tiers sort by status then name so a scan down a column is meaningful, and
// rows left-align into a real grid instead of centering each row separately.
function sortTier(records) {
    return [...records].sort((a, b) =>
        statusRank[a.status.level] - statusRank[b.status.level] ||
        a.name.localeCompare(b.name)
    );
}

function renderGraph(records) {
    const svg = d3.select('#nodeGraph');
    const graphArea = document.getElementById('graphMainArea');

    // Width comes from the scroll area, not the page, so opening the details
    // panel narrows the drawing. Height follows the layout and the scroll area
    // clips it, so the page itself never grows.
    const width = Math.max(480, graphArea.clientWidth - 48);
    svg.attr('width', width);
    svg.selectAll('*').remove();

    if (records.length === 0) {
        svg.attr('height', 400);
        svg.append('text')
            .attr('x', width / 2)
            .attr('y', 200)
            .attr('text-anchor', 'middle')
            .attr('fill', 'currentColor')
            .attr('opacity', 0.6)
            .text('No appliances match the current filters');
        return;
    }

    const g = svg.append('g');
    const zoom = d3.zoom()
        .scaleExtent([0.3, 3])
        .filter(event => (event.button === 2 || event.ctrlKey) || event.type !== 'wheel')
        .on('zoom', event => g.attr('transform', event.transform));

    svg.call(zoom);
    svg.on('contextmenu', event => event.preventDefault());

    svg.append('defs').append('style').text(`
        .trunk, .branch { fill: none; stroke: var(--text-muted); stroke-width: 2; stroke-opacity: .7; }
        .tier-rule { stroke: var(--hairline); stroke-width: 1; }
        .tier-label { font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
        .node-rect { stroke-width: 2; cursor: pointer; }
        .node-rect.virtual { stroke-dasharray: 5,5; }
        .node-rect.is-selected { stroke-width: 3; }
        .node-text { cursor: pointer; user-select: none; }
        .status-indicator { stroke: var(--raised); stroke-width: 2; }
    `);

    const nodeWidth = 180;
    const nodeHeight = 60;
    const gap = 20;
    const rowGap = 78;
    const trunkX = 18;
    const nodeStartX = 52;
    const rightMargin = 24;
    const tierHeaderGap = 34;

    const perRow = Math.max(1, Math.floor((width - nodeStartX - rightMargin + gap) / (nodeWidth + gap)));

    const consoles = sortTier(records.filter(r => r.role === 'command'));
    const tiers = ['discover', 'trace', 'efc', 'other']
        .map(role => ({ role, records: sortTier(records.filter(r => r.role === role)) }))
        .filter(tier => tier.records.length > 0);

    // Left-aligned grid: every row starts at the same x, so columns line up.
    function layout(tierRecords, startY) {
        return tierRecords.map((record, i) => ({
            record,
            x: nodeStartX + (i % perRow) * (nodeWidth + gap),
            y: startY + Math.floor(i / perRow) * rowGap
        }));
    }

    function tierBottom(positions, fallback) {
        if (positions.length === 0) return fallback;
        return Math.max(...positions.map(p => p.y)) + nodeHeight;
    }

    let cursorY = 24;
    const consolePositions = layout(consoles, cursorY);
    cursorY = tierBottom(consolePositions, cursorY);

    // Section labels sit in their own gap. The topology trunk stays in the far
    // left gutter, while right-angle branches connect each appliance row.
    const drawnTiers = tiers.map(tier => {
        const headerY = cursorY + tierHeaderGap;
        const positions = layout(tier.records, headerY + 24);
        cursorY = tierBottom(positions, headerY) + 10;
        return { ...tier, headerY, positions };
    });

    const height = Math.max(400, cursorY + 32);
    svg.attr('height', height);

    const allPositions = [
        ...consolePositions,
        ...drawnTiers.flatMap(tier => tier.positions)
    ];
    const rowCenters = [...new Set(allPositions.map(position => position.y + nodeHeight / 2))]
        .sort((a, b) => a - b);
    const rowConnections = rowCenters.map(centerY => ({
        centerY,
        endX: Math.max(...allPositions
            .filter(position => position.y + nodeHeight / 2 === centerY)
            .map(position => position.x))
    }));

    if (rowCenters.length > 0) {
        const trunkStart = rowCenters.length === 1 ? rowCenters[0] - 12 : rowCenters[0];
        const trunkEnd = rowCenters.length === 1 ? rowCenters[0] + 12 : rowCenters[rowCenters.length - 1];
        g.append('path')
            .attr('class', 'trunk')
            .attr('d', `M ${trunkX} ${trunkStart} V ${trunkEnd}`);
    }

    rowConnections.forEach(row => {
        g.append('path')
            .attr('class', 'branch')
            .attr('d', `M ${trunkX} ${row.centerY} H ${row.endX}`);
    });

    drawnTiers.forEach(tier => {
        g.append('line')
            .attr('class', 'tier-rule')
            .attr('x1', nodeStartX)
            .attr('y1', tier.headerY)
            .attr('x2', width - rightMargin)
            .attr('y2', tier.headerY);

        g.append('text')
            .attr('class', 'tier-label')
            .attr('x', nodeStartX)
            .attr('y', tier.headerY - 8)
            .attr('fill', 'currentColor')
            .attr('opacity', 0.65)
            .text(`${roleLabels[tier.role] || tier.role} · ${tier.records.length}`);
    });

    function truncate(textSelection, fullText, maxWidth) {
        let text = fullText;
        while (textSelection.node().getComputedTextLength() > maxWidth && text.length > 1) {
            text = text.slice(0, -1);
            textSelection.text(text + '…');
        }
    }

    function drawNodes(positions) {
        positions.forEach(({ record, x, y }) => {
            const strokeColor = record.role === 'other'
                ? appCssColor('--gray', '#898a8d')
                : (platformColors[record.role] || platformColors[record.info.platform] || appCssColor('--gray', '#898a8d'));

            const nodeGroup = g.append('g')
                .attr('class', 'node-group')
                .attr('data-id', record.appliance.id);

            nodeGroup.append('rect')
                .attr('class', `node-rect ${record.info.isVirtual ? 'virtual' : ''} ${record.appliance.id === nodemapState.selectedId ? 'is-selected' : ''}`)
                .attr('x', x)
                .attr('y', y)
                .attr('width', nodeWidth)
                .attr('height', nodeHeight)
                .attr('rx', 8)
                .attr('fill', 'var(--bg-subtle)')
                .attr('stroke', strokeColor);

            const nameText = nodeGroup.append('text')
                .attr('class', 'node-text')
                .attr('x', x + 12)
                .attr('y', y + 24)
                .attr('fill', 'currentColor')
                .attr('font-weight', '600')
                .attr('font-size', '14')
                .text(record.name);
            truncate(nameText, record.name, nodeWidth - 40);

            const modelText = nodeGroup.append('text')
                .attr('class', 'node-text')
                .attr('x', x + 12)
                .attr('y', y + 43)
                .attr('fill', 'currentColor')
                .attr('font-size', '11')
                .attr('opacity', 0.7)
                .text(record.model);
            truncate(modelText, record.model, nodeWidth - 24);

            nodeGroup.append('circle')
                .attr('class', 'status-indicator')
                .attr('cx', x + nodeWidth - 12)
                .attr('cy', y + 12)
                .attr('r', 5)
                .attr('fill', record.status.circleColor);

            nodeGroup.on('click', () => selectAppliance(record));
        });
    }

    drawNodes(consolePositions);
    drawnTiers.forEach(tier => drawNodes(tier.positions));
}

/* ------------------------------- Details panel ------------------------------- */

function showNodeDetailsPanel() {
    const panel = document.getElementById('nodeDetailsPanel');
    const graphArea = document.getElementById('graphMainArea');
    const listArea = document.getElementById('listMainArea');

    panel.style.display = 'flex';
    panel.offsetHeight; // reflow so the slide-in transition runs
    panel.classList.add('is-open');

    graphArea.style.width = 'calc(100% - 384px)';
    listArea.style.width = 'calc(100% - 384px)';

    // Only the SVG needs re-measuring; the list reflows on its own.
    if (nodemapState.view === 'topology') {
        setTimeout(() => renderGraph(getVisibleRecords()), 350);
    }
}

function hideNodeDetailsPanel() {
    const panel = document.getElementById('nodeDetailsPanel');
    const graphArea = document.getElementById('graphMainArea');
    const listArea = document.getElementById('listMainArea');

    panel.classList.remove('is-open');
    graphArea.style.width = '100%';
    listArea.style.width = '100%';
    nodemapState.selectedId = null;
    nodemapState.productKeys = {
        applianceId: null,
        status: 'idle',
        values: [],
        revealed: false,
        error: null
    };

    if (nodemapState.view === 'topology') {
        setTimeout(() => renderGraph(getVisibleRecords()), 350);
    } else {
        document.querySelectorAll('.appliance-row.is-selected')
            .forEach(row => row.classList.remove('is-selected'));
    }

    setTimeout(() => { panel.style.display = 'none'; }, 300);
}

function selectAppliance(record) {
    if (String(nodemapState.selectedId) !== String(record.appliance.id)) {
        nodemapState.productKeys = {
            applianceId: null,
            status: 'idle',
            values: [],
            revealed: false,
            error: null
        };
    }
    nodemapState.selectedId = record.appliance.id;

    if (nodemapState.view === 'list') {
        document.querySelectorAll('.appliance-row').forEach(row => {
            row.classList.toggle('is-selected', row.dataset.id === String(record.appliance.id));
        });
    } else {
        document.querySelectorAll('.node-rect').forEach(rect => {
            const owner = rect.closest('.node-group');
            rect.classList.toggle('is-selected', owner?.dataset.id === String(record.appliance.id));
        });
    }

    showNodeDetails(record);
}

function showNodeDetails(record) {
    const { appliance, info, status } = record;
    const content = document.getElementById('nodeDetailsPanelContent');

    content.innerHTML = `
        <div class="stack">
            <div>
                <div class="filter-group-title">Basic information</div>
                <div class="detail-panel stack-sm">
                    ${detailItem('Name', record.name)}
                    ${detailItem('Role', roleLabels[record.role] || record.role)}
                    ${detailItem('Model', record.model)}
                    ${detailItem('Platform', appliance.platform || 'Unknown')}
                    ${detailItem('Firmware', record.firmware)}
                    <div>
                        <span class="detail-label">Status</span>
                        <span class="${status.badgeClass}"><span class="badge-dot"></span>${escapeHtml(status.statusText)}</span>
                    </div>
                    <div>
                        <span class="detail-label">Type</span>
                        <span class="badge">${record.typeLabel}</span>
                    </div>
                    ${info.hasIntegratedTrace ? `
                    <div>
                        <span class="detail-label">Features</span>
                        <span class="badge">Integrated PCAP</span>
                    </div>
                    ` : ''}
                </div>
            </div>

            <div>
                <div class="filter-group-title">Technical details</div>
                <div class="detail-panel stack-sm">
                    <div>
                        <span class="detail-label">UUID</span>
                        <span class="detail-value mono xsmall">${escapeHtml(appliance.uuid || 'N/A')}</span>
                    </div>
                    ${detailItem('ID', appliance.id)}
                    ${detailItem('Hostname', appliance.hostname || 'N/A')}
                    ${appliance.nickname ? detailItem('Nickname', appliance.nickname) : ''}
                </div>
            </div>

            ${record.modules.length > 0 ? `
            <div>
                <div class="filter-group-title">Product modules</div>
                <div class="row-tight">
                    ${record.modules.map(module => `<span class="badge">${escapeHtml(module)}</span>`).join('')}
                </div>
            </div>
            ` : ''}

            ${renderFirmwareManagement(record)}
            ${renderCloudServices(record)}
            ${renderProductKeys(record)}
        </div>
    `;

    bindNodeDetailActions(record);
    showNodeDetailsPanel();
}

function renderFirmwareManagement(record) {
    const availability = record.firmwareAvailability;
    const id = String(record.appliance.id);
    const job = nodemapState.upgradeJobs[id];
    let body = '';

    if (availability.status === 'not-applicable') {
        body = '<p class="muted xsmall">Local appliance firmware management is unavailable for this deployment.</p>';
    } else if (availability.status === 'available') {
        const options = availability.versions.map(candidate => `
            <option value="${escapeAttribute(candidate.version)}">${escapeHtml(candidate.version)}${candidate.release ? ` · ${escapeHtml(candidate.release)}` : ''}</option>
        `).join('');
        const disabled = record.status.level === 'error' || job?.state === 'submitting' || job?.state === 'polling';
        body = `
            <div class="field">
                <label for="applianceFirmwareVersion">Eligible target version</label>
                <select id="applianceFirmwareVersion">${options}</select>
            </div>
            <button type="button" id="openFirmwareUpgrade" class="btn-primary btn-sm" ${disabled ? 'disabled' : ''}>
                Start upgrade…
            </button>
            ${record.status.level === 'error' ? '<p class="field-hint">The appliance must be reachable before an upgrade can be started.</p>' : ''}
        `;
    } else if (availability.status === 'failed') {
        body = `
            <p class="muted xsmall">Firmware availability could not be determined.</p>
            <button type="button" id="checkApplianceFirmware" class="btn btn-sm">Check this appliance</button>
        `;
    } else if (availability.status === 'no-upgrade') {
        body = '<p class="muted xsmall">ExtraHop Cloud Services returned no eligible firmware upgrade for this appliance.</p>';
    } else {
        body = '<p class="muted xsmall">Checking eligible firmware versions…</p>';
    }

    return `
        <div>
            <div class="filter-group-title">Firmware management</div>
            <div class="detail-panel stack-sm">
                ${body}
                ${renderFirmwareJob(job)}
            </div>
        </div>
    `;
}

function renderFirmwareJob(job) {
    if (!job) return '';
    const tone = job.state === 'done'
        ? 'badge-success'
        : ['failed', 'error'].includes(job.state)
            ? 'badge-danger'
            : 'badge-warning';
    const label = job.state === 'done'
        ? 'Upgrade complete'
        : job.state === 'failed'
            ? 'Upgrade failed'
            : job.state === 'timed-out'
                ? 'Completion not verified'
                : job.state === 'paused'
                    ? 'Monitoring paused'
                    : job.status || 'Upgrade accepted';
    const step = String(job.stepDescription || '').trim();
    const details = String(job.details || '').trim();
    return `
        <div class="firmware-job" aria-live="polite">
            <span class="badge ${tone}">${escapeHtml(label)}</span>
            ${step ? `<p class="field-hint">${escapeHtml(step)}</p>` : ''}
            ${details && details !== step ? `<p class="field-hint">${escapeHtml(details)}</p>` : ''}
        </div>
    `;
}

function formatCloudTime(value) {
    if (!Number.isFinite(value)) return 'Unavailable';
    return new Date(value).toLocaleString();
}

function renderCloudServices(record) {
    if (String(record.appliance.id) !== '0') return '';
    if (!deploymentSupportsApiFamily(state.apiConfig?.type, 'applianceCloudServices')) return '';

    const cloud = nodemapState.cloudServices;
    if (cloud.status === 'failed') {
        return `
            <div>
                <div class="filter-group-title">ExtraHop Cloud Services</div>
                <div class="detail-panel"><span class="badge badge-danger">Status unavailable</span></div>
            </div>
        `;
    }
    if (cloud.status !== 'available') return '';

    const data = cloud.data || {};
    const status = String(data.connection_status || 'unknown');
    const tone = status === 'connected'
        ? 'badge-success'
        : status === 'reconnecting'
            ? 'badge-warning'
            : 'badge-danger';
    const services = toArray(data.enabled_services);
    return `
        <div>
            <div class="filter-group-title">ExtraHop Cloud Services</div>
            <div class="detail-panel stack-sm">
                <div><span class="detail-label">Connection</span><span class="badge ${tone}">${escapeHtml(status.replaceAll('_', ' '))}</span></div>
                ${detailItem('Last active', formatCloudTime(data.last_active_time))}
                ${detailItem('Last analyzed', formatCloudTime(data.last_analyzed_time))}
                <div>
                    <span class="detail-label">Enabled services</span>
                    <div class="row-tight">${services.length
                        ? services.map(service => `<span class="badge">${escapeHtml(service)}</span>`).join('')
                        : '<span class="muted xsmall">None reported</span>'}</div>
                </div>
            </div>
        </div>
    `;
}

function canReadProductKeys() {
    return deploymentSupportsApiFamily(state.apiConfig?.type, 'applianceProductKeys')
        && ApplianceManagement.isConsoleInventory(nodemapState.appliances);
}

function renderProductKeys(record) {
    if (!canReadProductKeys()) return '';
    const id = String(record.appliance.id);
    const productKeys = nodemapState.productKeys;
    const isCurrent = productKeys.applianceId === id;
    let body = '<button type="button" id="loadProductKeys" class="btn btn-sm">View product key</button>';

    if (isCurrent && productKeys.status === 'loading') {
        body = '<span class="muted xsmall">Loading product key…</span>';
    } else if (isCurrent && productKeys.status === 'failed') {
        body = `
            <span class="badge badge-danger">Product key unavailable</span>
            <button type="button" id="loadProductKeys" class="btn btn-sm">Retry</button>
        `;
    } else if (isCurrent && productKeys.status === 'available') {
        body = `
            <div class="stack-sm">
                ${productKeys.values.map(value => `
                    <span class="detail-value mono product-key-value">${escapeHtml(
                        productKeys.revealed ? value : ApplianceManagement.maskProductKey(value)
                    )}</span>
                `).join('') || '<span class="muted xsmall">No product key was returned.</span>'}
                ${productKeys.values.length ? `
                    <button type="button" id="toggleProductKeys" class="btn btn-sm">
                        ${productKeys.revealed ? 'Hide product key' : 'Reveal product key'}
                    </button>
                ` : ''}
            </div>
        `;
    }

    return `
        <div>
            <div class="filter-group-title">Product key</div>
            <div class="detail-panel stack-sm">
                ${body}
                <p class="field-hint">Product keys remain in memory only while this appliance detail is open.</p>
            </div>
        </div>
    `;
}

function bindNodeDetailActions(record) {
    document.getElementById('checkApplianceFirmware')?.addEventListener('click', () => {
        checkApplianceFirmware(record);
    });
    document.getElementById('openFirmwareUpgrade')?.addEventListener('click', () => {
        const version = document.getElementById('applianceFirmwareVersion')?.value;
        if (version) openFirmwareUpgrade(record, version);
    });
    document.getElementById('loadProductKeys')?.addEventListener('click', () => {
        loadProductKeys(record);
    });
    document.getElementById('toggleProductKeys')?.addEventListener('click', () => {
        nodemapState.productKeys.revealed = !nodemapState.productKeys.revealed;
        renderSelectedApplianceDetails();
    });
}

function renderSelectedApplianceDetails() {
    if (nodemapState.selectedId == null) return;
    const appliance = nodemapState.appliances.find(item =>
        String(item.id) === String(nodemapState.selectedId)
    );
    if (appliance) showNodeDetails(describeAppliance(appliance));
}

async function checkApplianceFirmware(record) {
    const id = String(record.appliance.id);
    nodemapState.firmwareAvailability[id] = { status: 'loading', versions: [] };
    renderSelectedApplianceDetails();
    try {
        if (id === '0') {
            const releases = await window.apiClient.getLocalApplianceFirmwareVersions();
            nodemapState.firmwareAvailability = ApplianceManagement.mergeLocalFirmwareAvailability(
                nodemapState.firmwareAvailability,
                releases
            );
        } else {
            const releases = await window.apiClient.getApplianceFirmwareVersions([id]);
            nodemapState.firmwareAvailability = ApplianceManagement.mergeSingleFirmwareAvailability(
                nodemapState.firmwareAvailability,
                id,
                releases
            );
        }
    } catch (error) {
        nodemapState.firmwareAvailability = id === '0'
            ? ApplianceManagement.mergeLocalFirmwareAvailability(
                nodemapState.firmwareAvailability,
                [],
                error
            )
            : ApplianceManagement.mergeSingleFirmwareAvailability(
                nodemapState.firmwareAvailability,
                id,
                [],
                error
            );
    }
    renderNodemap();
    renderSelectedApplianceDetails();
}

async function loadProductKeys(record) {
    const id = String(record.appliance.id);
    nodemapState.productKeys = {
        applianceId: id,
        status: 'loading',
        values: [],
        revealed: false,
        error: null
    };
    renderSelectedApplianceDetails();
    try {
        const response = await window.apiClient.getApplianceProductKeys(id);
        if (String(nodemapState.selectedId) !== id) return;
        nodemapState.productKeys = {
            applianceId: id,
            status: 'available',
            values: ApplianceManagement.normalizeProductKeys(response),
            revealed: false,
            error: null
        };
    } catch (error) {
        if (String(nodemapState.selectedId) !== id) return;
        nodemapState.productKeys = {
            applianceId: id,
            status: 'failed',
            values: [],
            revealed: false,
            error
        };
    }
    renderSelectedApplianceDetails();
}

function openFirmwareUpgrade(record, version) {
    const id = String(record.appliance.id);
    const stillEligible = record.firmwareAvailability.versions.some(candidate =>
        candidate.version === version
    );
    if (!stillEligible) return;

    const requiresIngestConfirmation = String(record.appliance.platform || '').toLowerCase() === 'explore';
    nodemapState.upgradeTarget = {
        id,
        name: record.name,
        role: roleLabels[record.role] || record.role,
        currentVersion: record.firmware,
        version,
        isLocal: id === '0',
        requiresIngestConfirmation
    };

    document.getElementById('firmwareUpgradeAppliance').textContent = record.name;
    document.getElementById('firmwareUpgradeRole').textContent = roleLabels[record.role] || record.role;
    document.getElementById('firmwareUpgradeCurrent').textContent = record.firmware;
    document.getElementById('firmwareUpgradeTarget').textContent = version;
    document.getElementById('firmwareUpgradeAcknowledge').checked = false;
    document.getElementById('firmwareUpgradeRecordstoreAcknowledge').checked = false;
    document.getElementById('firmwareUpgradeRecordstoreWarning').hidden = !requiresIngestConfirmation;
    document.getElementById('confirmFirmwareUpgrade').disabled = false;
    showModal('firmwareUpgradeModal');
}

function closeFirmwareUpgradeModal() {
    nodemapState.upgradeTarget = null;
    hideModal('firmwareUpgradeModal');
}

function firmwareJobProjection(job, fallbackState = 'polling') {
    const remoteSummary = ApplianceManagement.summarizeRemoteJobs(job);
    return {
        state: fallbackState,
        status: String(job?.status || 'Upgrade in progress'),
        stepDescription: job?.step_description || '',
        details: [job?.details, remoteSummary].filter(Boolean).join(' — '),
        location: null
    };
}

async function monitorFirmwareUpgrade(applianceId, location) {
    nodemapState.jobController?.abort();
    const controller = new AbortController();
    nodemapState.jobController = controller;
    nodemapState.upgradeJobs[applianceId] = {
        state: 'polling',
        status: 'Upgrade accepted',
        stepDescription: 'Waiting for the first job status update.',
        location
    };
    renderSelectedApplianceDetails();

    try {
        const result = await ApplianceManagement.pollFirmwareJob({
            location,
            signal: controller.signal,
            fetchJob: (jobLocation, options) => window.apiClient.getFirmwareUpgradeJob(jobLocation, options),
            onUpdate: job => {
                nodemapState.upgradeJobs[applianceId] = {
                    ...firmwareJobProjection(job),
                    location
                };
                renderSelectedApplianceDetails();
            }
        });
        nodemapState.upgradeJobs[applianceId] = {
            ...firmwareJobProjection(result.job, result.state),
            location
        };
        renderSelectedApplianceDetails();
        if (result.state === 'done') {
            showStatus(`Firmware upgrade completed for ${nodemapState.appliances.find(item => String(item.id) === applianceId)?.display_name || applianceId}.`);
            await loadAppliances();
        }
    } catch (error) {
        if (error?.name === 'AbortError') {
            const existing = nodemapState.upgradeJobs[applianceId] || {};
            nodemapState.upgradeJobs[applianceId] = { ...existing, state: 'paused', location };
        } else {
            nodemapState.upgradeJobs[applianceId] = {
                state: 'error',
                status: 'Job status unavailable',
                details: error?.message || String(error),
                location
            };
        }
        renderSelectedApplianceDetails();
    } finally {
        if (nodemapState.jobController === controller) nodemapState.jobController = null;
    }
}

async function submitFirmwareUpgrade(event) {
    event.preventDefault();
    const target = nodemapState.upgradeTarget;
    if (!target) return;
    const acknowledged = document.getElementById('firmwareUpgradeAcknowledge').checked;
    const ingestAcknowledged = document.getElementById('firmwareUpgradeRecordstoreAcknowledge').checked;
    if (!acknowledged || (target.requiresIngestConfirmation && !ingestAcknowledged)) return;

    const availability = nodemapState.firmwareAvailability[target.id];
    if (!availability?.versions.some(candidate => candidate.version === target.version)) {
        showStatus('That firmware version is no longer confirmed as eligible. Check availability again.', true);
        closeFirmwareUpgradeModal();
        return;
    }

    const confirmButton = document.getElementById('confirmFirmwareUpgrade');
    confirmButton.disabled = true;
    nodemapState.upgradeJobs[target.id] = {
        state: 'submitting',
        status: 'Starting upgrade',
        stepDescription: ''
    };
    renderSelectedApplianceDetails();

    try {
        const response = target.isLocal
            ? await window.apiClient.upgradeLocalApplianceFirmware(target.version)
            : await window.apiClient.upgradeApplianceFirmware([target.id], target.version);
        const location = response.location;
        const applianceId = target.id;
        const applianceName = target.name;
        closeFirmwareUpgradeModal();
        showStatus(`Firmware upgrade accepted for ${applianceName}.`);
        if (ApplianceManagement.isSafeJobLocation(location)) {
            void monitorFirmwareUpgrade(applianceId, location);
        } else {
            nodemapState.upgradeJobs[applianceId] = {
                state: 'timed-out',
                status: 'Upgrade accepted',
                stepDescription: 'ExtraHop did not return a usable job location; completion is not yet verified.',
                location: null
            };
            renderSelectedApplianceDetails();
        }
    } catch (error) {
        nodemapState.upgradeJobs[target.id] = {
            state: 'error',
            status: 'Upgrade was not started',
            details: error?.message || String(error),
            location: null
        };
        confirmButton.disabled = false;
        renderSelectedApplianceDetails();
        showStatus(error?.status === 409
            ? 'Another remote appliance job is already in progress. Wait for it to finish before retrying.'
            : `Could not start the firmware upgrade: ${error?.message || error}`,
        true);
    }
}

/* ------------------------------- Controls ------------------------------- */

function updateNodemapSearch(searchValue) {
    nodemapState.searchTerm = searchValue.trim();
    if (nodemapState.appliances.length > 0) {
        renderNodemap();
    }
}

function showNodemapControls() {
    const controls = document.getElementById('nodemapControls');
    if (controls) controls.style.display = 'flex';
}

function hideNodemapControls() {
    const controls = document.getElementById('nodemapControls');
    if (controls) controls.style.display = 'none';
}

const nodemapFilterMap = {
    'filter-discover': 'discover',
    'filter-trace': 'trace',
    'filter-efc': 'efc',
    'filter-other': 'other',
    'filter-physical': 'physical',
    'filter-virtual': 'virtual',
    'filter-online': 'online',
    'filter-offline': 'offline'
};

function updateFilterCheckboxes() {
    for (const [elementId, filterKey] of Object.entries(nodemapFilterMap)) {
        const checkbox = document.getElementById(elementId);
        if (checkbox) checkbox.checked = nodemapState.filters[filterKey];
    }
    updateNodemapFilterCount();
}

function updateNodemapFilterCount() {
    const inactiveCount = Object.values(nodemapState.filters).filter(value => !value).length;
    const count = document.getElementById('nodemapFilterCount');
    if (!count) return;
    count.textContent = inactiveCount.toString();
    count.hidden = inactiveCount === 0;
}

function setNodemapFilterMenuOpen(open) {
    const button = document.getElementById('showNodemapFilters');
    const menu = document.getElementById('nodemapFiltersMenu');
    if (!button || !menu) return;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
}

function setupNodemapFilterEventListeners() {
    const showFiltersBtn = document.getElementById('showNodemapFilters');
    if (showFiltersBtn) {
        showFiltersBtn.addEventListener('click', event => {
            event.stopPropagation();
            const isOpen = showFiltersBtn.getAttribute('aria-expanded') === 'true';
            if (!isOpen) updateFilterCheckboxes();
            setNodemapFilterMenuOpen(!isOpen);
        });
    }

    const filterMenu = document.getElementById('nodemapFiltersMenu');
    if (filterMenu) {
        filterMenu.addEventListener('click', event => event.stopPropagation());
        filterMenu.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                setNodemapFilterMenuOpen(false);
                showFiltersBtn?.focus();
            }
        });
    }

    document.addEventListener('click', () => setNodemapFilterMenuOpen(false));

    const searchInput = document.getElementById('nodemapSearch');
    if (searchInput) {
        searchInput.addEventListener('input', e => updateNodemapSearch(e.target.value));
    }

    document.querySelectorAll('#nodemapViewToggle button').forEach(btn => {
        btn.addEventListener('click', () => {
            if (nodemapState.view === btn.dataset.view) return;
            nodemapState.view = btn.dataset.view;
            renderNodemap();
        });
    });

    const groupSelect = document.getElementById('nodemapGroupBy');
    if (groupSelect) {
        groupSelect.addEventListener('change', e => {
            nodemapState.groupBy = e.target.value;
            renderNodemap();
        });
    }

    for (const [elementId, filterKey] of Object.entries(nodemapFilterMap)) {
        const checkbox = document.getElementById(elementId);
        if (checkbox) {
            checkbox.addEventListener('change', () => {
                nodemapState.filters[filterKey] = checkbox.checked;
                updateNodemapFilterCount();
                if (nodemapState.appliances.length > 0) renderNodemap();
            });
        }
    }

    const resetFiltersBtn = document.getElementById('resetNodemapFilters');
    if (resetFiltersBtn) {
        resetFiltersBtn.addEventListener('click', () => {
            Object.keys(nodemapState.filters).forEach(key => {
                nodemapState.filters[key] = true;
            });
            updateFilterCheckboxes();
            if (nodemapState.appliances.length > 0) renderNodemap();
        });
    }

    const closeNodeDetailsPanelBtn = document.getElementById('closeNodeDetailsPanel');
    if (closeNodeDetailsPanelBtn) {
        closeNodeDetailsPanelBtn.addEventListener('click', hideNodeDetailsPanel);
    }

    document.getElementById('firmwareUpgradeForm')?.addEventListener('submit', submitFirmwareUpgrade);
    document.getElementById('cancelFirmwareUpgrade')?.addEventListener('click', closeFirmwareUpgradeModal);

    updateNodemapFilterCount();
}

/* ------------------------------- Lifecycle ------------------------------- */

async function activateNodemapModule() {
    console.log('Activating Nodemap module');

    if (state.connected && nodemapState.appliances.length === 0) {
        await loadAppliances();
    } else if (state.connected) {
        showNodemapControls();
        document.getElementById('graphContainer').style.display = 'flex';
        document.getElementById('nodemapWelcome').style.display = 'none';
        renderNodemap();
        const pausedJob = Object.entries(nodemapState.upgradeJobs).find(([, job]) =>
            job.state === 'paused' && ApplianceManagement.isSafeJobLocation(job.location)
        );
        if (pausedJob) void monitorFirmwareUpgrade(pausedJob[0], pausedJob[1].location);
    } else {
        showNodemapWelcome();
    }
}

function initNodemapModule() {
    console.log('Initializing Nodemap module');

    setupNodemapFilterEventListeners();
}

function cancelNodemapOperations() {
    nodemapState.loadController?.abort();
    nodemapState.jobController?.abort();
}

function deactivateNodemapModule() {
    nodemapState.productKeys = {
        applianceId: null,
        status: 'idle',
        values: [],
        revealed: false,
        error: null
    };
    nodemapState.upgradeTarget = null;
    hideModal('firmwareUpgradeModal');
}

if (typeof featureRegistry !== 'undefined') {
    featureRegistry.register('nodemap', {
        initialize: initNodemapModule,
        activate: activateNodemapModule,
        cancel: cancelNodemapOperations,
        deactivate: deactivateNodemapModule
    });
}
