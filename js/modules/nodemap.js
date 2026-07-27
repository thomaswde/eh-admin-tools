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

    try {
        document.getElementById('nodemapWelcome').style.display = 'none';

        nodemapState.appliances = await window.apiClient.getAppliances();

        // Catalog data sharpens platform and physical/virtual detection
        try {
            const response = await fetch('/backend/system-health/catalog');
            if (response.ok) {
                const catalog = await response.json();
                nodemapState.catalogData = Array.isArray(catalog.models) ? catalog.models : [];
            }
        } catch {
            console.warn('Could not load catalog data, using basic platform detection');
            nodemapState.catalogData = [];
        }

        document.getElementById('graphContainer').style.display = 'flex';
        showNodemapControls();
        renderNodemap();
    } catch (error) {
        console.error('Error loading appliances:', error);
        showNodemapWelcome();
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

    // Status counts beyond these two are visible as their own list groups.
    const cards = [
        { label: 'Appliances', value: records.length },
        { label: 'Online', value: online },
        { label: 'Unreachable', value: unreachable, tone: unreachable > 0 ? 'danger' : '' },
        { label: 'Firmware versions', value: firmwareCount, tone: firmwareCount > 1 ? 'warn' : '' }
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

    if (nodemapState.view === 'topology') {
        setTimeout(() => renderGraph(getVisibleRecords()), 350);
    } else {
        document.querySelectorAll('.appliance-row.is-selected')
            .forEach(row => row.classList.remove('is-selected'));
    }

    setTimeout(() => { panel.style.display = 'none'; }, 300);
}

function selectAppliance(record) {
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
        </div>
    `;

    showNodeDetailsPanel();
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
    } else {
        showNodemapWelcome();
    }
}

function initNodemapModule() {
    console.log('Initializing Nodemap module');

    setupNodemapFilterEventListeners();
}

if (typeof featureRegistry !== 'undefined') {
    featureRegistry.register('nodemap', {
        initialize: initNodemapModule,
        activate: activateNodemapModule
    });
}
