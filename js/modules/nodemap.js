// Nodemap Module - Appliance Network Topology Visualization

// Nodemap state
const nodemapState = {
    appliances: [],
    catalogData: [],
    searchTerm: '',
    filters: {
        command: true,
        discover: true,
        trace: true,
        physical: true,
        virtual: true,
        offline: true,
        online: true
    }
};

// Platform colors
const platformColors = {
    'command': '#00aaef',           // Cyan
    'packet_sensor': '#dae343',     // Lime
    'discover': '#dae343',          // Lime
    'packetstore': '#f05918',       // Tangerine
    'trace': '#f05918',             // Tangerine
    'multifunction_sensor': '#dae343', // Lime
    'all_in_one': '#dae343'         // Lime
};

// Helper function to get catalog info
function getCatalogInfo(licensePlatform) {
    if (!licensePlatform) return null;
    
    let modelName = licensePlatform.replace(/_TRACE$/, '');
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
        if (licensePlatform.match(/V(_|$)/)) {
            isVirtual = true;
        }
    }
    
    // Check if appliance is offline
    const statusMessage = (appliance.status_message || '').toString().toLowerCase();
    const isOffline = statusMessage && statusMessage !== 'online';
    
    return {
        platform,
        isVirtual,
        hasIntegratedTrace,
        isOffline
    };
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

    let circleColor = '#9ca3af';
    let badgeClass = 'bg-gray-100 text-gray-800';

    if (level === 'online') {
        circleColor = '#10b981'; // green-500
        badgeClass = 'bg-green-100 text-green-800';
    } else if (level === 'error') {
        circleColor = '#ef4444'; // red-500
        badgeClass = 'bg-red-100 text-red-800';
    } else if (level === 'warning') {
        circleColor = '#f59e0b'; // amber-500
        badgeClass = 'bg-yellow-100 text-yellow-800';
    }

    const statusText = rawStatus || 'Unknown';

    return {
        statusText,
        level,
        circleColor,
        badgeClass
    };
}

// Helper function to check if appliance matches search
function matchesSearch(appliance) {
    if (!nodemapState.searchTerm) return true;
    
    const term = nodemapState.searchTerm.toLowerCase();
    const values = [];

    Object.values(appliance).forEach(value => {
        if (value == null) return;

        const valueType = typeof value;
        if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
            values.push(value.toString().toLowerCase());
        } else if (Array.isArray(value)) {
            value.forEach(item => {
                if (item == null) return;
                const itemType = typeof item;
                if (itemType === 'string' || itemType === 'number' || itemType === 'boolean') {
                    values.push(item.toString().toLowerCase());
                }
            });
        }
    });

    return values.some(v => v.includes(term));
}

// Load appliances and render the graph
async function loadAppliances() {
    if (!state.connected) {
        showNodemapWelcome();
        return;
    }
    
    try {
        document.getElementById('nodemapWelcome').style.display = 'none';
        
        // Load appliances
        nodemapState.appliances = await window.apiClient.getAppliances();
        
        // Try to load catalog data for better platform detection
        try {
            const response = await fetch('extrahop_catalog_json_v2.json');
            if (response.ok) {
                nodemapState.catalogData = await response.json();
            }
        } catch (e) {
            console.warn('Could not load catalog data, using basic platform detection');
            nodemapState.catalogData = [];
        }
        
        document.getElementById('graphContainer').style.display = 'block';
        showNodemapControls();
        renderGraph();
    } catch (error) {
        console.error('Error loading appliances:', error);
        showNodemapWelcome();
    }
}

// Show welcome screen
function showNodemapWelcome() {
    document.getElementById('nodemapWelcome').style.display = 'flex';
    document.getElementById('graphContainer').style.display = 'none';
    hideNodemapControls();
}

// Render the graph
function renderGraph() {
    const svg = d3.select('#nodeGraph');
    const container = document.getElementById('graphContainer');
    
    // Calculate dimensions
    const width = container.clientWidth - 48;
    const height = Math.max(400, window.innerHeight - 200);
    
    // Update container and SVG sizes
    container.style.height = height + 'px';
    container.style.minHeight = height + 'px';
    svg.attr('width', width).attr('height', height);
    svg.selectAll('*').remove();

    if (nodemapState.appliances.length === 0) {
        svg.append('text')
            .attr('x', width / 2)
            .attr('y', height / 2)
            .attr('text-anchor', 'middle')
            .attr('fill', '#9ca3af')
            .text('No appliances to display');
        return;
    }

    // Create zoom behavior - right-click + scroll to zoom
    const g = svg.append('g');
    const zoom = d3.zoom()
        .scaleExtent([0.3, 3])
        .filter(event => {
            // Only zoom on right-button + wheel, or ctrl+wheel
            return (event.button === 2 || event.ctrlKey) || event.type !== 'wheel';
        })
        .on('zoom', (event) => {
            g.attr('transform', event.transform);
        });
    
    svg.call(zoom);
    
    // Prevent context menu on right-click
    svg.on('contextmenu', (event) => {
        event.preventDefault();
    });

    // Add instructions
    svg.append('text')
        .attr('x', 10)
        .attr('y', 20)
        .attr('fill', '#9ca3af')
        .attr('font-size', '12')
        .text('Right-click + scroll to zoom, drag to pan');

    // Filter appliances based on active filters
    const filteredAppliances = nodemapState.appliances.filter(a => {
        const info = getNodeInfo(a);
        
        // First apply checkbox filters
        if (info.platform === 'command' && !nodemapState.filters.command) return false;
        
        if ((info.platform === 'packet_sensor' || info.platform === 'discover' || 
             info.platform === 'multifunction_sensor' || info.platform === 'all_in_one') && !nodemapState.filters.discover) {
            return false;
        }
        
        if ((info.platform === 'packetstore' || info.platform === 'trace') && 
            !info.hasIntegratedTrace && !nodemapState.filters.trace) {
            return false;
        }
        
        if (info.isVirtual && !nodemapState.filters.virtual) return false;
        if (!info.isVirtual && !nodemapState.filters.physical) return false;
        
        if (info.isOffline && !nodemapState.filters.offline) return false;
        if (!info.isOffline && !nodemapState.filters.online) return false;
        
        if (!matchesSearch(a)) return false;
        
        return true;
    });

    // Group appliances by type
    const commandAppliances = filteredAppliances.filter(a => {
        const info = getNodeInfo(a);
        return info.platform === 'command';
    });
    
    const discoverAppliances = filteredAppliances.filter(a => {
        const info = getNodeInfo(a);
        return info.platform === 'packet_sensor' || info.platform === 'discover' || 
               info.platform === 'multifunction_sensor' || info.platform === 'all_in_one';
    });
    
    const traceAppliances = filteredAppliances.filter(a => {
        const info = getNodeInfo(a);
        return (info.platform === 'packetstore' || info.platform === 'trace') && 
               !info.hasIntegratedTrace;
    });

    // Layout parameters
    const nodeWidth = 180;
    const nodeHeight = 60;
    const horizontalGap = 20;
    const verticalGap = 100;
    const rowGap = 80;
    
    // Calculate optimal nodes per row based on available width
    const maxNodesPerRow = Math.floor((width - 100) / (nodeWidth + horizontalGap));
    const nodesPerRow = Math.max(3, Math.min(maxNodesPerRow, 10));

    // Calculate positions for each group with flexible rows
    function calculatePositions(appliances, startY) {
        const positions = [];
        let currentRow = 0;
        let currentX = 0;
        
        appliances.forEach((app, i) => {
            if (i > 0 && i % nodesPerRow === 0) {
                currentRow++;
                currentX = 0;
            }
            
            const nodesInThisRow = Math.min(nodesPerRow, appliances.length - currentRow * nodesPerRow);
            const rowWidth = nodesInThisRow * (nodeWidth + horizontalGap) - horizontalGap;
            const rowStartX = (width - rowWidth) / 2;
            
            positions.push({
                appliance: app,
                x: rowStartX + currentX * (nodeWidth + horizontalGap),
                y: startY + currentRow * rowGap
            });
            
            currentX++;
        });
        
        return positions;
    }

    // Calculate Y positions for each tier
    const commandY = 60;
    const commandPositions = calculatePositions(commandAppliances, commandY);
    const commandMaxY = commandPositions.length > 0 ? 
        Math.max(...commandPositions.map(p => p.y)) + nodeHeight : commandY;
    
    const discoverY = commandMaxY + verticalGap;
    const discoverPositions = calculatePositions(discoverAppliances, discoverY);
    const discoverMaxY = discoverPositions.length > 0 ? 
        Math.max(...discoverPositions.map(p => p.y)) + nodeHeight : discoverY;
    
    const traceY = discoverMaxY + verticalGap;
    const tracePositions = calculatePositions(traceAppliances, traceY);

    // Add CSS for links and nodes
    const defs = svg.append('defs');
    const style = defs.append('style')
        .text(`
            .link {
                fill: none;
                stroke: #d1d5db;
                stroke-width: 2;
                stroke-opacity: 0.6;
            }
            .node-rect {
                stroke-width: 2;
                cursor: pointer;
                transition: all 0.2s;
            }
            .node-rect:hover {
                stroke-width: 3;
                fill-opacity: 0.3;
            }
            .node-rect.virtual {
                stroke-dasharray: 5,5;
            }
            .node-text {
                cursor: pointer;
                user-select: none;
            }
            .status-indicator {
                stroke: white;
                stroke-width: 2;
            }
        `);

    // Draw curved links from command to all other appliances
    commandPositions.forEach(cmd => {
        const cmdX = cmd.x + nodeWidth / 2;
        const cmdY = cmd.y + nodeHeight;
        
        discoverPositions.forEach(dis => {
            const disX = dis.x + nodeWidth / 2;
            const disY = dis.y;
            
            const midY = (cmdY + disY) / 2;
            
            g.append('path')
                .attr('class', 'link')
                .attr('d', `M ${cmdX} ${cmdY} Q ${cmdX} ${midY}, ${disX} ${disY}`);
        });
        
        tracePositions.forEach(trc => {
            const trcX = trc.x + nodeWidth / 2;
            const trcY = trc.y;
            
            const midY = (cmdY + trcY) / 2;
            
            g.append('path')
                .attr('class', 'link')
                .attr('d', `M ${cmdX} ${cmdY} Q ${cmdX} ${midY}, ${trcX} ${trcY}`);
        });
    });

    // Draw nodes
    function drawNodes(positions) {
        positions.forEach(pos => {
            const appliance = pos.appliance;
            const x = pos.x;
            const y = pos.y;
            const info = getNodeInfo(appliance);
            const color = platformColors[info.platform] || '#6b7280';
            const statusInfo = getStatusInfo(appliance);

            const nodeGroup = g.append('g')
                .attr('class', 'node-group')
                .attr('data-id', appliance.id);

            nodeGroup.append('rect')
                .attr('class', `node-rect ${info.isVirtual ? 'virtual' : ''}`)
                .attr('x', x)
                .attr('y', y)
                .attr('width', nodeWidth)
                .attr('height', nodeHeight)
                .attr('rx', 8)
                .attr('fill', color)
                .attr('stroke', color)
                .attr('fill-opacity', 0.2);

            // Display name with truncation
            const displayName = appliance.display_name || appliance.hostname || `Appliance ${appliance.id}`;
            const displayText = nodeGroup.append('text')
                .attr('class', 'node-text')
                .attr('x', x + nodeWidth / 2)
                .attr('y', y + 22)
                .attr('text-anchor', 'middle')
                .attr('fill', 'currentColor')
                .attr('font-weight', '600')
                .attr('font-size', '14')
                .text(displayName);
            
            // Truncate if too long
            let textLength = displayText.node().getComputedTextLength();
            let text = displayName;
            while (textLength > (nodeWidth - 10) && text.length > 0) {
                text = text.substring(0, text.length - 1);
                displayText.text(text + '...');
                textLength = displayText.node().getComputedTextLength();
            }

            // Model name with truncation
            const modelName = appliance.license_platform || appliance.platform;
            const modelText = nodeGroup.append('text')
                .attr('class', 'node-text')
                .attr('x', x + nodeWidth / 2)
                .attr('y', y + 40)
                .attr('text-anchor', 'middle')
                .attr('fill', 'currentColor')
                .attr('font-size', '11')
                .attr('opacity', 0.7)
                .text(modelName);
            
            // Truncate model name if needed
            textLength = modelText.node().getComputedTextLength();
            text = modelName;
            while (textLength > (nodeWidth - 10) && text.length > 0) {
                text = text.substring(0, text.length - 1);
                modelText.text(text + '...');
                textLength = modelText.node().getComputedTextLength();
            }

            nodeGroup.append('circle')
                .attr('class', 'status-indicator')
                .attr('cx', x + nodeWidth - 10)
                .attr('cy', y + 10)
                .attr('r', 6)
                .attr('fill', statusInfo.circleColor);

            if (info.hasIntegratedTrace) {
                nodeGroup.append('rect')
                    .attr('x', x + 5)
                    .attr('y', y + 5)
                    .attr('width', 30)
                    .attr('height', 16)
                    .attr('rx', 4)
                    .attr('fill', platformColors.trace)
                    .attr('opacity', 0.8);
                
                nodeGroup.append('text')
                    .attr('class', 'node-text')
                    .attr('x', x + 20)
                    .attr('y', y + 16)
                    .attr('text-anchor', 'middle')
                    .attr('fill', 'white')
                    .attr('font-size', '9')
                    .attr('font-weight', '600')
                    .text('PCAP');
            }

            nodeGroup.on('click', () => showNodeDetails(appliance));
        });
    }

    drawNodes(commandPositions);
    drawNodes(discoverPositions);
    drawNodes(tracePositions);
}

// Show/hide node details panel
function showNodeDetailsPanel() {
    const panel = document.getElementById('nodeDetailsPanel');
    const graphArea = document.getElementById('graphMainArea');
    
    panel.style.display = 'block';
    // Trigger reflow before adding transform
    panel.offsetHeight;
    panel.style.transform = 'translateX(0)';
    
    // Adjust graph area width
    graphArea.style.width = 'calc(100% - 384px)'; // 384px = w-96
    
    // Re-render graph to fit new container size
    setTimeout(() => {
        renderGraph();
    }, 350); // Wait for animation to complete
}

function hideNodeDetailsPanel() {
    const panel = document.getElementById('nodeDetailsPanel');
    const graphArea = document.getElementById('graphMainArea');
    
    panel.style.transform = 'translateX(100%)';
    graphArea.style.width = '100%';
    
    // Re-render graph to fit new container size
    setTimeout(() => {
        renderGraph();
    }, 350); // Wait for animation to complete
    
    // Hide panel after animation
    setTimeout(() => {
        panel.style.display = 'none';
    }, 300);
}

// Show node details in right panel
function showNodeDetails(appliance) {
    const content = document.getElementById('nodeDetailsPanelContent');
    const info = getNodeInfo(appliance);
    const statusInfo = getStatusInfo(appliance);
    
    content.innerHTML = `
        <div class="space-y-6">
            <!-- Basic Information Section -->
            <div class="space-y-4">
                <h4 class="font-semibold text-base border-b pb-2" style="color: var(--text-primary); border-color: var(--border-color);">Basic Information</h4>
                <div class="space-y-4">
                    <div>
                        <span class="block font-medium text-sm mb-1" style="color: var(--text-secondary);">Name</span>
                        <span class="block text-sm break-words p-2 rounded" style="color: var(--text-primary); background-color: var(--bg-subtle);">${appliance.display_name || appliance.hostname || `Appliance ${appliance.id}`}</span>
                    </div>
                    <div>
                        <span class="block font-medium text-sm mb-1" style="color: var(--text-secondary);">Model</span>
                        <span class="block text-sm break-words p-2 rounded" style="color: var(--text-primary); background-color: var(--bg-subtle);">${appliance.license_platform || 'Unknown'}</span>
                    </div>
                    <div>
                        <span class="block font-medium text-sm mb-1" style="color: var(--text-secondary);">Platform</span>
                        <span class="block text-sm p-2 rounded" style="color: var(--text-primary); background-color: var(--bg-subtle);">${appliance.platform || 'Unknown'}</span>
                    </div>
                    <div>
                        <span class="block font-medium text-sm mb-1" style="color: var(--text-secondary);">Firmware</span>
                        <span class="block text-sm break-words p-2 rounded" style="color: var(--text-primary); background-color: var(--bg-subtle);">${appliance.firmware_version || 'Unknown'}</span>
                    </div>
                    <div>
                        <span class="block font-medium text-sm mb-1" style="color: var(--text-secondary);">Status</span>
                        <span class="inline-block text-sm px-3 py-1 rounded-full ${statusInfo.badgeClass}">${statusInfo.statusText}</span>
                    </div>
                    <div>
                        <span class="block font-medium text-sm mb-1" style="color: var(--text-secondary);">Type</span>
                        <span class="inline-block text-sm px-3 py-1 rounded-full ${info.isVirtual ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'}">${info.isVirtual ? 'Virtual' : 'Physical'}</span>
                    </div>
                    ${info.hasIntegratedTrace ? `
                    <div>
                        <span class="block font-medium text-sm mb-1" style="color: var(--text-secondary);">Features</span>
                        <span class="inline-block text-sm px-3 py-1 rounded-full bg-orange-100 text-orange-800">Integrated PCAP</span>
                    </div>
                    ` : ''}
                </div>
            </div>
            
            <!-- Technical Details Section -->
            <div class="space-y-4">
                <h4 class="font-semibold text-base border-b pb-2" style="color: var(--text-primary); border-color: var(--border-color);">Technical Details</h4>
                <div class="space-y-4">
                    <div>
                        <span class="block font-medium text-sm mb-1" style="color: var(--text-secondary);">UUID</span>
                        <span class="block text-xs font-mono break-all p-2 rounded" style="color: var(--text-primary); background-color: var(--bg-subtle);">${appliance.uuid || 'N/A'}</span>
                    </div>
                    <div>
                        <span class="block font-medium text-sm mb-1" style="color: var(--text-secondary);">ID</span>
                        <span class="block text-sm p-2 rounded" style="color: var(--text-primary); background-color: var(--bg-subtle);">${appliance.id}</span>
                    </div>
                    <div>
                        <span class="block font-medium text-sm mb-1" style="color: var(--text-secondary);">Hostname</span>
                        <span class="block text-sm break-words p-2 rounded" style="color: var(--text-primary); background-color: var(--bg-subtle);">${appliance.hostname || 'N/A'}</span>
                    </div>
                    ${appliance.nickname ? `
                    <div>
                        <span class="block font-medium text-sm mb-1" style="color: var(--text-secondary);">Nickname</span>
                        <span class="block text-sm break-words p-2 rounded" style="color: var(--text-primary); background-color: var(--bg-subtle);">${appliance.nickname}</span>
                    </div>
                    ` : ''}
                </div>
            </div>
            
            ${appliance.product_modules && appliance.product_modules.length > 0 ? `
            <div class="space-y-4">
                <h4 class="font-semibold text-base border-b pb-2" style="color: var(--text-primary); border-color: var(--border-color);">Product Modules</h4>
                <div class="flex flex-wrap gap-2">
                    ${appliance.product_modules.map(module => `
                        <span class="px-3 py-1 text-sm rounded-full" style="background-color: var(--cyan); color: white;">${module}</span>
                    `).join('')}
                </div>
            </div>
            ` : ''}
        </div>
    `;
    
    showNodeDetailsPanel();
}

// Update search term and re-render
function updateNodemapSearch(searchValue) {
    nodemapState.searchTerm = searchValue.trim();
    if (nodemapState.appliances.length > 0) {
        renderGraph();
    }
}

// Show/hide controls when connected
function showNodemapControls() {
    const controls = document.getElementById('nodemapControls');
    if (controls) {
        controls.style.display = 'flex';
    }
}

function hideNodemapControls() {
    const controls = document.getElementById('nodemapControls');
    if (controls) {
        controls.style.display = 'none';
    }
}

// Update filter checkboxes to match current state
function updateFilterCheckboxes() {
    const filterMap = {
        'filter-command': 'command',
        'filter-discover': 'discover', 
        'filter-trace': 'trace',
        'filter-physical': 'physical',
        'filter-virtual': 'virtual',
        'filter-online': 'online',
        'filter-offline': 'offline'
    };

    for (const [elementId, filterKey] of Object.entries(filterMap)) {
        const checkbox = document.getElementById(elementId);
        if (checkbox) {
            checkbox.checked = nodemapState.filters[filterKey];
        }
    }
}

// Set up event listeners for filter controls
function setupNodemapFilterEventListeners() {
    // Filter button to show modal
    const showFiltersBtn = document.getElementById('showNodemapFilters');
    if (showFiltersBtn) {
        showFiltersBtn.addEventListener('click', () => {
            updateFilterCheckboxes();
            showModal('nodemapFiltersModal');
        });
    }

    // Search input
    const searchInput = document.getElementById('nodemapSearch');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            updateNodemapSearch(e.target.value);
        });
    }

    // Filter modal controls
    const closeFiltersBtn = document.getElementById('closeNodemapFilters');
    if (closeFiltersBtn) {
        closeFiltersBtn.addEventListener('click', () => {
            hideModal('nodemapFiltersModal');
        });
    }

    const applyFiltersBtn = document.getElementById('applyNodemapFilters');
    if (applyFiltersBtn) {
        applyFiltersBtn.addEventListener('click', () => {
            // Update filter state from checkboxes
            const filterMap = {
                'filter-command': 'command',
                'filter-discover': 'discover', 
                'filter-trace': 'trace',
                'filter-physical': 'physical',
                'filter-virtual': 'virtual',
                'filter-online': 'online',
                'filter-offline': 'offline'
            };

            for (const [elementId, filterKey] of Object.entries(filterMap)) {
                const checkbox = document.getElementById(elementId);
                if (checkbox) {
                    nodemapState.filters[filterKey] = checkbox.checked;
                }
            }

            // Re-render graph and close modal
            if (nodemapState.appliances.length > 0) {
                renderGraph();
            }
            hideModal('nodemapFiltersModal');
        });
    }

    const resetFiltersBtn = document.getElementById('resetNodemapFilters');
    if (resetFiltersBtn) {
        resetFiltersBtn.addEventListener('click', () => {
            // Reset all filters to true
            Object.keys(nodemapState.filters).forEach(key => {
                nodemapState.filters[key] = true;
            });
            updateFilterCheckboxes();
        });
    }

    // Close node details panel
    const closeNodeDetailsPanelBtn = document.getElementById('closeNodeDetailsPanel');
    if (closeNodeDetailsPanelBtn) {
        closeNodeDetailsPanelBtn.addEventListener('click', () => {
            hideNodeDetailsPanel();
        });
    }

    // Modal background click to close (only for filters modal now)
    const modal = document.getElementById('nodemapFiltersModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                hideModal('nodemapFiltersModal');
            }
        });
    }
}

// Nodemap module activation function (called every time module is shown)
function activateNodemapModule() {
    console.log('Activating Nodemap module');
    
    // Check if we need to load/refresh based on connection state
    if (state.connected && nodemapState.appliances.length === 0) {
        // Connected but no appliances loaded, load them
        loadAppliances();
    } else if (state.connected && nodemapState.appliances.length > 0) {
        // Connected and have appliances, make sure controls are visible
        showNodemapControls();
        document.getElementById('graphContainer').style.display = 'block';
        document.getElementById('nodemapWelcome').style.display = 'none';
    } else if (!state.connected) {
        // Not connected, show welcome
        showNodemapWelcome();
    }
}

// Nodemap module initialization function (called once when module first loads)
function initNodemapModule() {
    console.log('Initializing Nodemap module');
    
    // Set up event listeners
    setupNodemapFilterEventListeners();
    
    // Initial activation
    activateNodemapModule();
}