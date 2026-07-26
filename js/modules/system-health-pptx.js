// System Health PowerPoint Export
//
// This module deliberately knows nothing about ExtraHop API response shapes.
// The System Health report passes it a safe, normalized deck model containing
// report metadata, display rows, and resolved colors; every chart is drawn here
// from those rows as native PowerPoint shapes, so the deck stays vector and
// editable. PptxGenJS is loaded only when the user confirms an export.
//
// Deck shape is fixed, not proportional to fleet size. The body carries the
// narrative at a constant length; sensors that returned no data collapse into a
// counted roll-up and keep their per-sensor row in the appendix.

(() => {

if (window.SystemHealthPptx) return;

const PPTXGEN_URL = 'js/vendor/pptxgen.bundle.js?v=4.0.1';
const SLIDE_WIDTH = 13.333;
const SLIDE_HEIGHT = 7.5;
const MARGIN = 0.7;
const FONT = 'Source Sans 3';
const BRAND_SAPPHIRE = '#261f63';
const BRAND_PLUM = '#7f2854';
const BRAND_LIME = '#daed43';
const DEFAULT_TITLE = 'System Health Review';
const ATTENTION_ROWS_PER_SLIDE = 7;
const APPENDIX_ROWS_PER_SLIDE = 11;
// Charts show ranked sensors only. Anything past this is signal-free tail; the
// caption states how many were held back and the appendix still lists them all.
const CHART_ROWS_PER_SLIDE = 10;
const CHART_PAGES_PER_METRIC = 3;
// Packetstore rows carry up to three stacked bars, so they need a taller row
// and fewer of them per slide than the single-bar capacity charts.
const PACKETSTORE_CHART_ROWS_PER_SLIDE = 8;
// Drawn as the guide line on every capacity chart and reused as the single
// definition of "under pressure" so the deck never carries two conventions.
const PROCESSING_LOAD_GUIDE = 0.8;
const PACKETSTORE_CRITICAL_DROP_RATIO = 0.01;
let pptxGenPromise = null;

function cleanText(value, maxLength = 240) {
    return String(value == null ? '' : value).trim().slice(0, maxLength);
}

function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function safeRatio(value, capacity) {
    const numerator = finiteNumber(value);
    const denominator = finiteNumber(capacity);
    return numerator !== null && denominator && denominator > 0 ? numerator / denominator : null;
}

function targetFallback(meta) {
    return cleanText(meta && meta.target_label, 120);
}

function defaultWindowLabel(meta) {
    const lookback = finiteNumber(meta && meta.lookback_days);
    if (lookback !== null && lookback > 0) {
        return `Last ${lookback.toLocaleString()} ${lookback === 1 ? 'day' : 'days'}`;
    }
    const from = formatShortDate(meta && meta.from_ms);
    const until = formatShortDate(meta && meta.until_ms);
    if (from && until) return `${from} – ${until}`;
    return formatShortDate(meta && meta.generated_at) || 'Current report window';
}

function resolveOptions(meta, rawOptions = {}) {
    return {
        title: cleanText(rawOptions.title, 100) || DEFAULT_TITLE,
        customer: cleanText(rawOptions.customer, 120) || targetFallback(meta),
        prepared_by: cleanText(rawOptions.prepared_by, 120),
        window_label: cleanText(rawOptions.window_label, 120) || defaultWindowLabel(meta),
        context: cleanText(rawOptions.context, 320)
    };
}

function normalizedPalette(raw = {}) {
    const fallback = {
        bg: '#ffffff', text: '#16151f', subtle: '#403f47', muted: '#6a6970',
        grid: '#dadadb', track: '#e8e8e9', altRow: '#f5f4f5',
        low: '#00aaef', mid: '#f59e0b', high: '#ef4444'
    };
    const palette = {};
    Object.keys(fallback).forEach(key => {
        palette[key] = validHex(raw[key]) ? String(raw[key]).toLowerCase() : fallback[key];
    });
    palette.transparent = !!raw.transparent;
    // "Absent" marks a sensor that returned no data. It is deliberately not one
    // of the severity ramp colors: missing data is not an alarm, and painting it
    // like one is what made a mostly-offline fleet unreadable. Mixed toward the
    // muted text color so it clears the track in both light and dark themes.
    palette.absent = mixHex(palette.bg, palette.muted, 0.62);
    return palette;
}

function validHex(value) {
    return /^#[0-9a-f]{6}$/i.test(String(value || ''));
}

function parseHex(value) {
    const raw = validHex(value) ? String(value).slice(1) : 'ffffff';
    return [0, 2, 4].map(index => parseInt(raw.slice(index, index + 2), 16));
}

function mixHex(fromHex, toHex, weight) {
    const from = parseHex(fromHex);
    const to = parseHex(toHex);
    const channel = index => Math.round(from[index] + (to[index] - from[index]) * weight)
        .toString(16).padStart(2, '0');
    return `#${channel(0)}${channel(1)}${channel(2)}`;
}

function sensorStatus(row) {
    const states = Object.entries(row.collectionStatus || {})
        .filter(([key]) => key !== 'device_analysis' || supportsDeviceAnalysis(row))
        .map(([, state]) => state);
    const incomplete = states.find(state => !['complete', 'zero_valued'].includes(state));
    if (incomplete) return incomplete;
    if (states.length && states.every(state => state === 'zero_valued')) return 'zero_valued';
    return row.offline ? 'offline' : 'complete';
}

// A sensor that is offline, or online but refusing data access, has nothing
// measurable to report. Those roll up to a single counted band rather than
// repeating the same seven-clause sentence once per row.
function isAbsent(row) {
    return !!row.offline || row.data_access === false;
}

// Flow Sensors collect flow telemetry and IDS Sensors process IDS rules; neither
// role is expected to discover devices or report device-analysis tiers.
function applianceRole(row) {
    const model = cleanText(row.license_platform || (row.capacity && row.capacity.model), 80)
        .replace(/\s+/g, '').toUpperCase();
    const platform = cleanText(row.platform, 80).toLowerCase().replace(/[_-]+/g, ' ');
    if (model.startsWith('EFC') || platform.includes('flow sensor') || platform.includes('flow collector')) {
        return 'flow_sensor';
    }
    if (model.startsWith('IDS') || platform === 'ids' || platform.startsWith('ids ')) return 'ids';
    return 'packet_sensor';
}

function supportsDeviceAnalysis(row) {
    return applianceRole(row) === 'packet_sensor';
}

// Conditions are emitted in priority order. The first one becomes the row's
// headline; the rest become supporting evidence on the same line. This is what
// replaces the old semicolon-joined dump, where the one fact that mattered was
// buried among six restatements of "offline".
function findingForRow(row) {
    const conditions = [];
    const add = (severity, label, detail) => {
        if (!label || conditions.some(item => item.label === label)) return;
        conditions.push({ severity, label, detail: cleanText(detail, 160) });
    };

    if (row.data_access === false) add('CRITICAL', 'Data access unavailable', '');
    if (row.offline) add('CRITICAL', 'Offline', '');

    const packetRatio = safeRatio(row.packetPeak, row.packetCapacity);
    const throughputRatio = safeRatio(row.throughputGbps, row.throughputCapacity);
    const triggerRatio = finiteNumber(row.triggerUtilization);
    const advancedRatio = safeRatio(row.analysis && row.analysis.advanced, row.advancedCapacity);
    const standardRatio = safeRatio(row.analysis && row.analysis.standard, row.standardCapacity);
    const analysis = row.analysis || {};

    [
        ['Advanced analysis', advancedRatio, tierValue(analysis.advanced, row.advancedCapacity) + ' devices'],
        ['Standard analysis', standardRatio, tierValue(analysis.standard, row.standardCapacity) + ' devices']
    ].forEach(([label, ratio, detail]) => {
        if (ratio === null) return;
        if (ratio >= 1) add('CRITICAL', `${label} full`, detail);
        else if (ratio >= 0.8) add('WARNING', `${label} near capacity`, detail);
    });

    const drops = finiteNumber(row.triggerDropsTotal);
    if (drops !== null && drops > 0) {
        const load = triggerRatio === null
            ? ''
            : `trigger load peaked at ${formatPercent(triggerRatio)} of available cycles`;
        add('CRITICAL', 'Trigger drops', [`${formatInteger(drops)} drops`, load].filter(Boolean).join(' · '));
    }

    [
        ['Packet rate', packetRatio, formatRate(row.packetPeak), formatRate(row.packetCapacity)],
        ['Throughput', throughputRatio, formatGbps(row.throughputGbps), formatGbps(row.throughputCapacity)],
        ['Trigger load', triggerRatio, formatCompact(row.triggerCyclesPeak), formatCompact(row.triggerCyclesAvail)]
    ].forEach(([label, ratio, used, capacity]) => {
        if (ratio === null) return;
        const detail = `${used} of ${capacity} · ${formatPercent(ratio)} of capacity`;
        if (ratio >= 1) add('CRITICAL', `${label} at capacity`, detail);
        else if (ratio >= 0.8) add('WARNING', `${label} elevated`, detail);
    });

    const discovery = finiteNumber(analysis.discovery);
    if (discovery !== null && discovery > 0) {
        add('WARNING', 'Devices in Discovery', `${formatInteger(discovery)} awaiting an analysis tier`);
    }

    (row.health_conditions || []).forEach(condition => {
        if (condition && condition.type === 'offline' && row.offline) return;
        if (condition && condition.type === 'data_access' && row.data_access === false) return;
        const message = cleanText(condition && condition.message, 160);
        if (!message) return;
        add(condition.status === 'failed' ? 'CRITICAL' : 'WARNING',
            conditionLabel(condition), sentenceCase(message));
    });

    // Collection gaps are reported as a single condition naming the affected
    // statistics, not one condition per statistic.
    const collection = row.collectionStatus || {};
    const collectionLabels = {
        pkts: 'packet rate', bytes: 'throughput', trigger_utilization: 'trigger utilization',
        trigger_drops: 'trigger drops', device_analysis: 'device analysis'
    };
    const gaps = Object.entries(collectionLabels)
        .filter(([key]) => {
            if (key === 'device_analysis' && !supportsDeviceAnalysis(row)) return false;
            const status = collection[key];
            return status && !['complete', 'zero_valued'].includes(status);
        })
        .map(([, label]) => label);
    if (gaps.length) {
        add('WARNING', 'Incomplete collection', `No data returned for ${joinList(gaps)}`);
    }

    const severity = conditions.some(item => item.severity === 'CRITICAL') ? 'CRITICAL'
        : conditions.length ? 'WARNING' : 'OK';
    const ordered = conditions.slice().sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    const primary = ordered[0] || null;
    // Evidence quantifies the headline and then *names* the other conditions
    // rather than restating each one in full. Concatenating every detail is how
    // the previous export produced a seven-clause sentence per row.
    const others = ordered.slice(1);
    const evidence = primary
        ? [
            primary.detail,
            others.length
                ? `also ${others.slice(0, 2).map(item => item.label.toLowerCase()).join(', ')}`
                    + (others.length > 2 ? ` +${others.length - 2} more` : '')
                : ''
        ].filter(Boolean).join(' · ')
        : '';
    const findings = ordered.map(item => [item.label, item.detail].filter(Boolean).join(': '));
    const atCapacity = [packetRatio, throughputRatio, triggerRatio, advancedRatio, standardRatio]
        .some(ratio => ratio !== null && ratio >= 1);
    const worstRatio = Math.max(
        ...[packetRatio, throughputRatio, triggerRatio, advancedRatio, standardRatio]
            .filter(value => value !== null),
        0
    );
    return {
        id: String(row.id || ''),
        name: cleanText(row.name || row.hostname || row.id || 'Unknown sensor', 120),
        model: cleanText(row.license_platform || (row.capacity && row.capacity.model) || 'Unknown', 80),
        severity,
        condition: primary ? primary.label : '',
        evidence,
        findings,
        finding_text: findings.join('; '),
        worst_ratio: worstRatio,
        at_capacity: atCapacity,
        absent: isAbsent(row),
        row
    };
}

function conditionLabel(condition) {
    const type = cleanText(condition && condition.type, 40).replace(/_/g, ' ');
    return type ? sentenceCase(type) : 'Health condition';
}

function joinList(items) {
    if (items.length <= 1) return items.join('');
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function recommendationsFromFindings(findings, overview = {}) {
    const recommendations = [];
    const has = pattern => findings.some(item => pattern.test(item.finding_text));
    if (overview.absent) {
        const noun = overview.absent === 1 ? 'sensor' : 'sensors';
        recommendations.push(`Restore connectivity for the ${formatInteger(overview.absent)} ${noun} that returned no data, then rerun the report to close the collection gap.`);
    }
    // Capture loss outranks capacity pressure: a dropped packet cannot be
    // recovered later, whereas a loaded sensor can still be rebalanced.
    if (overview.packetstores_with_loss) {
        recommendations.push(`Investigate capture loss on ${formatInteger(overview.packetstores_with_loss)} of ${formatInteger(overview.packetstores)} packetstores; compare offered load against rated capture throughput, then review slow-write, interface, block-drop, and disk-write evidence before treating PCAP from this window as complete.`);
    }
    if (has(/trigger drops/i)) {
        recommendations.push('Investigate sensors with trigger drops first; validate trigger load and execution behavior during the reported window.');
    }
    if (has(/packet rate|throughput|trigger load/i)) {
        recommendations.push('Review sustained capacity pressure against appliance sizing and expected traffic growth.');
    }
    if (!overview.packetstores_with_loss && overview.packetstores_loaded) {
        const noun = overview.packetstores_loaded === 1 ? 'packetstore' : 'packetstores';
        recommendations.push(`Confirm headroom on ${formatInteger(overview.packetstores_loaded)} ${noun} peaking at or above ${formatPercent(PROCESSING_LOAD_GUIDE)} processing load before adding capture volume or extending retention.`);
    }
    if (has(/advanced analysis|standard analysis|Discovery/i)) {
        recommendations.push('Rebalance analysis assignments and confirm licensed capacity before moving additional devices into higher analysis tiers.');
    }
    if (!overview.absent && has(/incomplete collection|data access/i)) {
        recommendations.push('Restore appliance connectivity and data access, then rerun the report to close collection gaps.');
    }
    if (has(/license|synchronization/i)) {
        recommendations.push('Resolve license or synchronization warnings so capacity and health decisions remain auditable.');
    }
    if (!recommendations.length) {
        recommendations.push('Continue monitoring the same report window and aggregation cycle to identify meaningful trend changes.');
    }
    return recommendations.slice(0, 5);
}

/* ------------------------------------------------------------ packetstore */

function isPairedPacketstoreSource(row) {
    return String(row && row.appliance_role || 'packet_sensor') !== 'all_in_one';
}

function packetstoreRoleLabel(row) {
    return isPairedPacketstoreSource(row) ? 'Paired Packetstore' : 'All in One';
}

// Loss is a fact, not a threshold: any dropped packet, secret, frame, or block counts.
// Retention deliberately does not appear here — without a customer retention
// target, a short lookback is an observation and not a finding.
function hasCaptureLoss(row) {
    return (finiteNumber(row.packetDropsTotal) || 0) > 0
        || (finiteNumber(row.interfaceDropsTotal) || 0) > 0
        || (finiteNumber(row.secretDropsTotal) || 0) > 0
        || (finiteNumber(row.slowWriteDropsTotal) || 0) > 0
        || (finiteNumber(row.blocksDroppedTotal) || 0) > 0;
}

function packetstoreDropSeverity(ratio, droppedTotal = 0) {
    const value = finiteNumber(ratio);
    if (value !== null && value > PACKETSTORE_CRITICAL_DROP_RATIO) return 'critical';
    if ((value !== null && value > 0) || (finiteNumber(droppedTotal) || 0) > 0) return 'warning';
    return 'clean';
}

function packetstoreLossSeverity(row) {
    const packet = packetstoreDropSeverity(row && row.packetDropRatio, row && row.packetDropsTotal);
    const secret = packetstoreDropSeverity(row && row.secretDropRatio, row && row.secretDropsTotal);
    if (packet === 'critical' || secret === 'critical') return 'critical';
    return packet === 'warning' || secret === 'warning'
        || (finiteNumber(row && row.slowWriteDropsTotal) || 0) > 0
        || (finiteNumber(row && row.interfaceDropsTotal) || 0) > 0
        || (finiteNumber(row && row.blocksDroppedTotal) || 0) > 0
        ? 'warning' : 'clean';
}

function packetstoreSeverityColor(palette, severity, cleanColor = null) {
    return severity === 'critical' ? palette.high
        : severity === 'warning' ? palette.mid
            : cleanColor || palette.text;
}

// 80% reuses the guide already drawn on every capacity chart rather than
// introducing a second convention for "under pressure".
function peakProcessingLoad(row) {
    const loads = [row.inputLoadPeak, row.compressionLoadPeak, row.diskWriteLoadPeak]
        .map(finiteNumber).filter(value => value !== null);
    return loads.length ? Math.max(...loads) / 100 : null;
}

function hasProcessingPressure(row) {
    const load = peakProcessingLoad(row);
    return load !== null && load >= PROCESSING_LOAD_GUIDE;
}

function hasReportedPacketstoreLookback(row) {
    if (!row || row.offline) return false;
    const value = finiteNumber(row.lookbackLatestSec);
    if (value === null || value < 0) return false;
    const status = row.collectionStatus && row.collectionStatus.est_lookback_sec;
    return value > 0 || ['complete', 'zero_valued'].includes(status);
}

function averagePacketstoreLookback(rows) {
    const measured = (rows || []).filter(hasReportedPacketstoreLookback);
    return {
        average_seconds: measured.length
            ? measured.reduce((sum, row) => sum + finiteNumber(row.lookbackLatestSec), 0) / measured.length
            : null,
        reporting_sources: measured.length
    };
}

function buildDeckModel(input) {
    const meta = { ...(input && input.meta || {}) };
    const options = resolveOptions(meta, input && input.options || {});
    const rows = Array.isArray(input && input.rows) ? input.rows.map(row => ({ ...row })) : [];
    const packetstoreRows = Array.isArray(input && input.packetstore_rows)
        ? input.packetstore_rows.map(row => ({ ...row })) : [];
    const allFindings = rows.map(findingForRow);

    // Absent sensors leave the body narrative and become a counted band. They
    // keep their full per-sensor row in the appendix, so nothing is dropped.
    const absent = allFindings.filter(item => item.absent);
    const findings = allFindings
        .filter(item => !item.absent && item.severity !== 'OK')
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity)
            || b.worst_ratio - a.worst_ratio
            || a.name.localeCompare(b.name));

    // Packetstore metrics are emitted by sensors, so Packetstore rows are a
    // measured subset of `rows` and must not be counted as extra appliances.
    const modelCounts = {};
    const countModel = row => {
        const model = cleanText(row.license_platform || (row.capacity && row.capacity.model) || 'Unknown', 80);
        modelCounts[model] = (modelCounts[model] || 0) + 1;
    };
    rows.forEach(countModel);

    const totalDrops = rows.reduce((sum, row) => sum + Math.max(0, finiteNumber(row.triggerDropsTotal) || 0), 0);
    const offline = rows.filter(row => row.offline).length;
    const noAccess = rows.filter(row => !row.offline && row.data_access === false).length;
    const reporting = rows.length - absent.length;
    const atCapacity = findings.filter(item => item.at_capacity).length;
    const allInOne = packetstoreRows.filter(row => !isPairedPacketstoreSource(row)).length;
    const paired = packetstoreRows.length - allInOne;
    const retention = averagePacketstoreLookback(packetstoreRows);
    const packetstoreLossSeverities = packetstoreRows.map(packetstoreLossSeverity);
    const packetstoreLossLevel = packetstoreLossSeverities.includes('critical') ? 'critical'
        : packetstoreLossSeverities.includes('warning') ? 'warning' : 'clean';
    const overview = {
        sensors: rows.length,
        reporting,
        healthy: Math.max(0, reporting - findings.length),
        offline,
        no_access: noAccess,
        absent: absent.length,
        attention: findings.length,
        at_capacity: atCapacity,
        trigger_drops: totalDrops,
        packetstores: packetstoreRows.length,
        packetstores_all_in_one: allInOne,
        packetstores_paired: paired,
        packetstores_with_loss: packetstoreRows.filter(hasCaptureLoss).length,
        packetstores_with_critical_loss: packetstoreLossSeverities.filter(level => level === 'critical').length,
        packetstore_loss_severity: packetstoreLossLevel,
        packetstores_loaded: packetstoreRows.filter(hasProcessingPressure).length,
        packetstore_lookback_average_sec: retention.average_seconds,
        packetstore_lookback_reporting_sources: retention.reporting_sources,
        model_counts: Object.entries(modelCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    };
    return {
        options,
        meta,
        palette: normalizedPalette(input && input.palette),
        rows,
        packetstore_rows: packetstoreRows,
        findings,
        absent,
        overview,
        verdict: verdictFor(overview),
        recommendations: recommendationsFromFindings(findings, overview),
        filename: deckFilename(meta, options)
    };
}

// One deterministic sentence naming the dominant condition. A reader who stops
// after the second slide should still leave with the right conclusion.
function verdictFor(overview) {
    const packetstores = packetstoreVerdictClause(overview);
    if (!overview.sensors) {
        const none = 'No sensors were returned for this report window.';
        return packetstores ? `${none} ${packetstores}` : none;
    }
    return [sensorVerdict(overview), packetstores].filter(Boolean).join(' ');
}

function sensorVerdict(overview) {
    const absentShare = overview.absent / overview.sensors;
    if (absentShare >= 0.5) {
        return `${formatInteger(overview.absent)} of ${formatInteger(overview.sensors)} sensors returned no data. `
            + 'Capacity is not the constraint — reachability is.';
    }
    if (overview.at_capacity) {
        return `${formatInteger(overview.at_capacity)} `
            + `${overview.at_capacity === 1 ? 'sensor is' : 'sensors are'} at or over a capacity limit `
            + 'and should be addressed before further devices are assigned.';
    }
    if (overview.attention) {
        return `${formatInteger(overview.attention)} of ${formatInteger(overview.reporting)} reporting sensors `
            + 'crossed a report threshold; none are at a hard capacity limit.';
    }
    if (overview.absent) {
        return `All ${formatInteger(overview.reporting)} reporting sensors are within capacity. `
            + `${formatInteger(overview.absent)} returned no data.`;
    }
    return `All ${formatInteger(overview.sensors)} sensors are reporting and within capacity thresholds.`;
}

// Capture loss is evidence lost for good, so it is stated in the headline even
// when every sensor is healthy — otherwise the verdict reads as an all-clear.
function packetstoreVerdictClause(overview) {
    if (!overview.packetstores) return '';
    const stores = count => `${formatInteger(count)} ${count === 1 ? 'packetstore' : 'packetstores'}`;
    if (overview.packetstores_with_loss) {
        return `${stores(overview.packetstores_with_loss)} of ${formatInteger(overview.packetstores)} `
            + 'dropped capture data in the same window.';
    }
    if (overview.packetstores_loaded) {
        return `${stores(overview.packetstores_loaded)} peaked at or above `
            + `${formatPercent(PROCESSING_LOAD_GUIDE)} processing load without losing capture data.`;
    }
    return `All ${stores(overview.packetstores)} captured without loss.`;
}

function severityRank(value) {
    return value === 'CRITICAL' ? 2 : value === 'WARNING' ? 1 : 0;
}

function deckFilename(meta, options) {
    const target = slug(options.customer || meta.target_label || 'system-health');
    const day = cleanText(meta.generated_at, 10) || new Date().toISOString().slice(0, 10);
    return `system-health-review-${target}-${day}.pptx`;
}

function slug(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'system-health';
}

function sentenceCase(value) {
    const text = cleanText(value);
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function formatInteger(value) {
    const number = finiteNumber(value);
    return number === null ? '—' : Math.round(number).toLocaleString();
}

function offlineSummaryText(names, maxNameCharacters = 220) {
    const values = (names || []).map(name => cleanText(name, 120)).filter(Boolean);
    if (!values.length) return '';
    const shown = [];
    let length = 0;
    for (const name of values) {
        if (shown.length && length + name.length + 2 > maxNameCharacters) break;
        shown.push(name);
        length += name.length + (shown.length > 1 ? 2 : 0);
    }
    const remaining = values.length - shown.length;
    const list = `${shown.join(', ')}${remaining ? `, … and ${formatInteger(remaining)} more` : ''}`;
    return `${formatInteger(values.length)} OFFLINE\n${list}`;
}

function formatPercent(value) {
    const ratio = finiteNumber(value);
    return ratio === null ? '—' : `${Math.round(ratio * 100)}%`;
}

// Drop rates are routinely a small fraction of a percent. Rounding those to
// "0%" next to a loss warning would read as a contradiction, so any non-zero
// loss keeps enough precision to stay non-zero.
function formatLossPercent(value) {
    const ratio = finiteNumber(value);
    if (ratio === null) return '—';
    if (ratio === 0) return '0%';
    if (ratio < 0.0001) return '<0.01%';
    if (ratio < 0.01) return `${(ratio * 100).toFixed(2)}%`;
    return formatPercent(ratio);
}

function formatRate(value) {
    return formatCompact(value, ' p/s');
}

function formatGbps(value) {
    const number = finiteNumber(value);
    return number === null ? '—' : `${number.toLocaleString(undefined, { maximumFractionDigits: 2 })} Gbps`;
}

function formatCompact(value, suffix = '') {
    const number = finiteNumber(value);
    if (number === null) return '—';
    const units = ['', 'K', 'M', 'B', 'T'];
    let scaled = Math.abs(number);
    let index = 0;
    while (scaled >= 1000 && index < units.length - 1) {
        scaled /= 1000;
        index += 1;
    }
    const signed = number < 0 ? -scaled : scaled;
    const digits = Math.abs(signed) >= 10 || index === 0 ? 0 : 1;
    return `${signed.toLocaleString(undefined, { maximumFractionDigits: digits })}${units[index]}${suffix}`;
}

function formatShortDate(value) {
    if (value === null || value === undefined || value === '') return '';
    const date = new Date(typeof value === 'number' ? value : String(value));
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function pptColor(value, fallback = '261F63') {
    return validHex(value) ? String(value).slice(1).toUpperCase() : fallback;
}

function relativeLuminance(hex) {
    const raw = validHex(hex) ? hex.slice(1) : 'ffffff';
    const channels = [0, 2, 4].map(index => parseInt(raw.slice(index, index + 2), 16) / 255)
        .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function isDark(hex) {
    return relativeLuminance(hex) < 0.36;
}

function chunk(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
    return chunks.length ? chunks : [[]];
}

function addNotes(slide, model, sourceDescription) {
    if (typeof slide.addNotes !== 'function') return;
    slide.addNotes(`[Sources]\n- ${sourceDescription}\n- Report generated ${model.meta.generated_at || 'at export time'}; aggregation cycle ${model.meta.cycle_label || 'not reported'}.`);
}

function addLogo(slide, model, assets, x, y, width) {
    const useWhite = isDark(model.palette.bg);
    const data = useWhite ? assets.whiteLogo : assets.colorLogo;
    if (data) {
        slide.addImage({ data, x, y, w: width, h: width / 10.17 });
    } else {
        slide.addText('EXTRAHOP', {
            x, y, w: width, h: 0.2, fontFace: FONT, fontSize: 9,
            bold: true, color: pptColor(useWhite ? '#ffffff' : BRAND_SAPPHIRE),
            margin: 0, charSpacing: 1.2
        });
    }
}

/* ---------------------------------------------------------------- chrome */

// PptxGenJS has no gradient fill, so the brand Sapphire->Plum hero is painted
// once to a canvas and reused as the cover background.
function gradientBackground(width = 2000, height = 1125) {
    if (typeof document === 'undefined' || !document.createElement) return '';
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return '';
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, BRAND_SAPPHIRE);
    gradient.addColorStop(1, BRAND_PLUM);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    try {
        return canvas.toDataURL('image/png');
    } catch (error) {
        return '';
    }
}

function addFooter(slide, model, slideNumber) {
    const palette = model.palette;
    slide.addShape(model.pptx.ShapeType.line, {
        x: MARGIN, y: 7.02, w: SLIDE_WIDTH - MARGIN * 2, h: 0,
        line: { color: pptColor(palette.grid), width: 0.7 }
    });
    slide.addText(`ExtraHop  ·  ${model.options.title}`, {
        x: MARGIN, y: 7.11, w: 6.0, h: 0.18, fontFace: FONT, fontSize: 8,
        color: pptColor(palette.muted), margin: 0
    });
    slide.addText(String(slideNumber), {
        x: 10.2, y: 7.11, w: 1.05, h: 0.18, fontFace: FONT, fontSize: 8,
        color: pptColor(palette.muted), margin: 0, align: 'right'
    });
}

// Header carries text only; the logo sits bottom-right so the title has the
// full measure. This mirrors the official ExtraHop body-slide layout.
function addContentSlide(model, title, subtitle, assets, kicker = '', kickerColor = '') {
    const pptx = model.pptx;
    const palette = model.palette;
    const slide = pptx.addSlide();
    slide.background = { color: pptColor(palette.bg, 'FFFFFF') };
    let y = 0.52;
    if (kicker) {
        slide.addText(String(kicker).toUpperCase(), {
            x: MARGIN, y, w: 8.0, h: 0.2, fontFace: FONT, fontSize: 9,
            bold: true, color: pptColor(kickerColor || palette.muted),
            margin: 0, charSpacing: 1.6
        });
        y += 0.30;
    }
    slide.addText(title, {
        x: MARGIN, y, w: 11.4, h: 0.46, fontFace: FONT, fontSize: 26,
        bold: true, color: pptColor(palette.text), margin: 0, breakLine: false,
        fit: 'shrink'
    });
    if (subtitle) {
        slide.addText(subtitle, {
            x: MARGIN, y: y + 0.50, w: 11.4, h: 0.26, fontFace: FONT, fontSize: 11.5,
            color: pptColor(palette.muted), margin: 0, fit: 'shrink'
        });
    }
    addLogo(slide, model, assets, 11.63, 7.06, 1.0);
    model.slideNumber += 1;
    addFooter(slide, model, model.slideNumber);
    slide.contentTop = subtitle ? y + 0.92 : y + 0.72;
    return slide;
}

/* ---------------------------------------------------------------- cover */

function addCover(model, assets) {
    const pptx = model.pptx;
    const slide = pptx.addSlide();
    const gradient = model.gradient;
    if (gradient) {
        slide.addImage({ data: gradient, x: 0, y: 0, w: SLIDE_WIDTH, h: SLIDE_HEIGHT });
    } else {
        slide.background = { color: pptColor(BRAND_SAPPHIRE) };
    }
    if (assets.whiteLogo) {
        slide.addImage({ data: assets.whiteLogo, x: 0.86, y: 0.66, w: 1.95, h: 1.95 / 10.17 });
    }

    // Lozenge bleeding off the left edge — the brand's shape signature.
    slide.addShape(pptx.ShapeType.roundRect, {
        x: -1.30, y: 2.44, w: 9.15, h: 2.06, rectRadius: 1.03,
        fill: { type: 'none' }, line: { color: 'FFFFFF', width: 0.9 }
    });
    slide.addText(model.options.title, {
        x: 0.86, y: 2.78, w: 7.4, h: 0.62, fontFace: FONT, fontSize: 38,
        bold: true, color: 'FFFFFF', margin: 0, fit: 'shrink'
    });
    if (model.options.customer) {
        slide.addText(model.options.customer, {
            x: 0.88, y: 3.56, w: 7.0, h: 0.34, fontFace: FONT, fontSize: 17,
            bold: true, color: pptColor(BRAND_LIME), margin: 0, fit: 'shrink'
        });
    }
    if (model.options.context) {
        slide.addText(model.options.context, {
            x: 0.88, y: 4.80, w: 8.2, h: 0.7, fontFace: FONT, fontSize: 12.5,
            color: 'FFFFFF', transparency: 25, margin: 0, breakLine: false, fit: 'shrink'
        });
    }

    slide.addShape(pptx.ShapeType.line, {
        x: 0.88, y: 6.10, w: 4.2, h: 0, line: { color: 'FFFFFF', width: 0.75 }
    });
    const meta = [
        ['REPORT WINDOW', model.options.window_label],
        ['PREPARED BY', model.options.prepared_by],
        ['GENERATED', formatShortDate(model.meta.generated_at)]
    ].filter(([, value]) => value);
    meta.forEach(([label, value], index) => {
        const x = 0.88 + index * 2.55;
        slide.addText(label, {
            x, y: 6.28, w: 2.4, h: 0.18, fontFace: FONT, fontSize: 8,
            bold: true, color: 'FFFFFF', margin: 0, charSpacing: 1.4
        });
        slide.addText(value, {
            x, y: 6.52, w: 2.4, h: 0.22, fontFace: FONT, fontSize: 12,
            color: 'FFFFFF', margin: 0, fit: 'shrink'
        });
    });
    model.slideNumber += 1;
    addNotes(slide, model, 'ExtraHop System Health report metadata supplied by the exporting user and application.');
}

/* ---------------------------------------------------------------- overview */

function addOverview(model, assets) {
    const palette = model.palette;
    const overview = model.overview;
    const subtitle = [
        `${formatInteger(overview.sensors)} sensors`,
        overview.packetstores ? `${formatInteger(overview.packetstores)} packetstores` : '',
        model.options.window_label,
        `Peak ${model.meta.cycle_label || 'reported-cycle'} averages`
    ].filter(Boolean).join(' · ');
    const slide = addContentSlide(model, 'Fleet health at a glance', subtitle, assets);

    slide.addText(model.verdict, {
        x: MARGIN, y: 1.52, w: SLIDE_WIDTH - MARGIN * 2, h: 0.32, fontFace: FONT,
        fontSize: 15.5, bold: true, color: pptColor(palette.text), margin: 0,
        breakLine: false, fit: 'shrink'
    });

    // Stacked fleet bar. Absent sensors are neutral, not red: an absence of
    // data is a collection gap, not a capacity alarm.
    const segments = [
        ['Healthy', overview.healthy, palette.low],
        ['Needs attention', overview.attention, palette.high],
        ['No data returned', overview.absent, palette.absent]
    ].filter(([, count]) => count > 0);
    const total = segments.reduce((sum, [, count]) => sum + count, 0) || 1;
    const barWidth = SLIDE_WIDTH - MARGIN * 2;
    let x = MARGIN;
    segments.forEach(([, count, color]) => {
        const width = Math.max(barWidth * count / total, 0.22);
        slide.addShape(model.pptx.ShapeType.rect, {
            x, y: 2.12, w: Math.max(width - 0.035, 0.05), h: 0.34,
            fill: { color: pptColor(color) }, line: { type: 'none' }
        });
        x += width;
    });
    // Legend is evenly spaced rather than aligned to segment widths, so a
    // two-sensor segment still gets a readable label.
    segments.forEach(([label, count, color], index) => {
        const legendX = MARGIN + index * 2.75;
        slide.addShape(model.pptx.ShapeType.rect, {
            x: legendX, y: 2.615, w: 0.1, h: 0.1,
            fill: { color: pptColor(color) }, line: { type: 'none' }
        });
        slide.addText(`${formatInteger(count)}  ${label}`, {
            x: legendX + 0.20, y: 2.565, w: 2.4, h: 0.2, fontFace: FONT,
            fontSize: 10.5, color: pptColor(palette.subtle), margin: 0
        });
    });

    slide.addShape(model.pptx.ShapeType.line, {
        x: MARGIN, y: 3.22, w: barWidth, h: 0,
        line: { color: pptColor(palette.grid), width: 0.75 }
    });

    // The packetstore tile only appears when packetstores were collected, so a
    // sensor-only fleet keeps the original four-up layout untouched.
    const stats = [
        [formatInteger(overview.sensors), 'Sensors in fleet', 'returned by the appliance API', palette.text],
        [formatInteger(overview.reporting), 'Reporting data', `${formatPercent(overview.sensors ? overview.reporting / overview.sensors : 0)} of the fleet`, palette.text],
        [formatInteger(overview.at_capacity), 'At or over capacity', 'across all measured limits', overview.at_capacity ? palette.high : palette.text],
        [formatCompact(overview.trigger_drops), 'Trigger drops', 'total across the window', overview.trigger_drops ? palette.high : palette.text]
    ];
    if (overview.packetstores) {
        // These are metric-producing sensors, split by integrated versus paired
        // Packetstore topology rather than a count of physical storage systems.
        const composition = [
            overview.packetstores_paired ? `${formatInteger(overview.packetstores_paired)} paired` : '',
            overview.packetstores_all_in_one ? `${formatInteger(overview.packetstores_all_in_one)} all-in-one` : ''
        ].filter(Boolean).join(' · ');
        stats.push([
            formatInteger(overview.packetstores_with_loss),
            'Packetstores losing data',
            `of ${formatInteger(overview.packetstores)} sources · ${formatInteger(overview.packetstores_with_critical_loss)} above 1% · ${composition}`,
            packetstoreSeverityColor(palette, overview.packetstore_loss_severity)
        ]);
    }
    const statPitch = (SLIDE_WIDTH - MARGIN * 2) / stats.length;
    stats.forEach(([value, label, note, color], index) => {
        const statX = MARGIN + index * statPitch;
        const statWidth = statPitch - 0.26;
        slide.addText(value, {
            x: statX, y: 3.52, w: statWidth, h: 0.62, fontFace: FONT, fontSize: 38,
            bold: true, color: pptColor(color), margin: 0, fit: 'shrink'
        });
        slide.addText(label, {
            x: statX, y: 4.22, w: statWidth, h: 0.22, fontFace: FONT, fontSize: 11.5,
            bold: true, color: pptColor(palette.text), margin: 0, fit: 'shrink'
        });
        slide.addText(note, {
            x: statX, y: 4.48, w: statWidth, h: 0.32, fontFace: FONT, fontSize: 9.5,
            color: pptColor(palette.muted), margin: 0, fit: 'shrink'
        });
        slide.addShape(model.pptx.ShapeType.line, {
            x: statX, y: 4.86, w: 0.62, h: 0,
            line: { color: pptColor(color), width: 2 }
        });
    });

    slide.addShape(model.pptx.ShapeType.line, {
        x: MARGIN, y: 5.28, w: barWidth, h: 0,
        line: { color: pptColor(palette.grid), width: 0.75 }
    });
    slide.addText('FLEET COMPOSITION', {
        x: MARGIN, y: 5.52, w: 3.0, h: 0.2, fontFace: FONT, fontSize: 9,
        bold: true, color: pptColor(palette.muted), margin: 0, charSpacing: 1.5
    });
    let chipX = MARGIN;
    overview.model_counts.slice(0, 6).forEach(([name, count]) => {
        const width = 0.115 * name.length + 0.62;
        if (chipX + width > SLIDE_WIDTH - MARGIN) return;
        slide.addShape(model.pptx.ShapeType.roundRect, {
            x: chipX, y: 5.82, w: width, h: 0.34, rectRadius: 0.17,
            fill: { color: pptColor(palette.altRow) },
            line: { color: pptColor(palette.grid), width: 0.75 }
        });
        slide.addText(name, {
            x: chipX + 0.22, y: 5.90, w: width - 0.44, h: 0.2, fontFace: FONT,
            fontSize: 10, color: pptColor(palette.subtle), margin: 0
        });
        slide.addText(`×${count}`, {
            x: chipX + width - 0.55, y: 5.90, w: 0.34, h: 0.2, fontFace: FONT,
            fontSize: 10, bold: true, color: pptColor(palette.text), margin: 0,
            align: 'right'
        });
        chipX += width + 0.14;
    });

    if (overview.offline > 0) {
        slide.addText(formatInteger(overview.offline), {
            x: MARGIN, y: 6.30, w: 1.0, h: 0.44, fontFace: FONT, fontSize: 27,
            bold: true, color: pptColor(palette.high), margin: 0, fit: 'shrink'
        });
        slide.addText(`Offline ${overview.offline === 1 ? 'appliance' : 'appliances'}`, {
            x: MARGIN + 1.12, y: 6.39, w: 3.0, h: 0.25, fontFace: FONT, fontSize: 12,
            bold: true, color: pptColor(palette.high), margin: 0, fit: 'shrink'
        });
    }
    addNotes(slide, model, 'Headline counts calculated from the normalized System Health sensor rows.');
}

/* ---------------------------------------------------------------- findings */

function addAttentionSlides(model, assets) {
    const pages = chunk(model.findings, ATTENTION_ROWS_PER_SLIDE);
    const palette = model.palette;
    pages.forEach((items, pageIndex) => {
        const suffix = pages.length > 1 ? ` · ${pageIndex + 1} of ${pages.length}` : '';
        const criticals = model.findings.filter(item => item.severity === 'CRITICAL').length;
        const kicker = model.findings.length
            ? `${model.findings.length} ${model.findings.length === 1 ? 'sensor' : 'sensors'} · ${criticals} critical`
            : '';
        const slide = addContentSlide(model, `Sensors that need attention${suffix}`,
            'Ranked by severity · grouped by condition', assets,
            kicker, criticals ? palette.high : palette.mid);

        const columns = [
            ['SENSOR', MARGIN + 0.20, 2.55],
            ['MODEL', 3.62, 1.75],
            ['CONDITION', 5.48, 2.35],
            ['EVIDENCE', 7.95, 4.65]
        ];
        const headerY = 1.72;
        columns.forEach(([label, x, w]) => {
            slide.addText(label, {
                x, y: headerY, w, h: 0.2, fontFace: FONT, fontSize: 8.5,
                bold: true, color: pptColor(palette.muted), margin: 0, charSpacing: 1.4
            });
        });
        slide.addShape(model.pptx.ShapeType.line, {
            x: MARGIN, y: headerY + 0.24, w: SLIDE_WIDTH - MARGIN * 2, h: 0,
            line: { color: pptColor(palette.grid), width: 0.75 }
        });

        let y = headerY + 0.36;
        const rowHeight = 0.58;
        if (!items.length) {
            slide.addText('No reporting sensor crossed the report thresholds in this window.', {
                x: MARGIN, y: y + 0.4, w: SLIDE_WIDTH - MARGIN * 2, h: 0.4, fontFace: FONT,
                fontSize: 14, color: pptColor(palette.subtle), margin: 0
            });
            y += 1.0;
        } else {
            let band = 0;
            ['CRITICAL', 'WARNING'].forEach(severity => {
                const group = items.filter(item => item.severity === severity);
                if (!group.length) return;
                const severityColor = severity === 'CRITICAL' ? palette.high : palette.mid;
                slide.addText(severity, {
                    x: MARGIN + 0.20, y: y + 0.02, w: 2.0, h: 0.2, fontFace: FONT,
                    fontSize: 8, bold: true, color: pptColor(severityColor),
                    margin: 0, charSpacing: 1.4
                });
                y += 0.26;
                group.forEach(item => {
                    if (band % 2 === 0) {
                        slide.addShape(model.pptx.ShapeType.rect, {
                            x: MARGIN, y, w: SLIDE_WIDTH - MARGIN * 2, h: rowHeight,
                            fill: { color: pptColor(palette.altRow) }, line: { type: 'none' }
                        });
                    }
                    // Severity lives in a 4pt edge bar. As a column it was a
                    // full-width field whose value never varied.
                    slide.addShape(model.pptx.ShapeType.rect, {
                        x: MARGIN, y, w: 0.055, h: rowHeight,
                        fill: { color: pptColor(severityColor) }, line: { type: 'none' }
                    });
                    const cell = (text, x, w, options = {}) => slide.addText(text, {
                        x, y, w, h: rowHeight, fontFace: FONT, fontSize: options.fontSize || 10.5,
                        bold: !!options.bold, color: pptColor(options.color || palette.subtle),
                        margin: 0, valign: 'middle', breakLine: false, fit: 'shrink'
                    });
                    cell(clipName(item.name, 28), MARGIN + 0.20, 2.55, { bold: true, color: palette.text, fontSize: 11.5 });
                    cell(item.model, 3.62, 1.75, { color: palette.muted });
                    cell(item.condition, 5.48, 2.35, { bold: true, color: severityColor, fontSize: 11 });
                    cell(item.evidence, 7.95, 4.70);
                    y += rowHeight;
                    band += 1;
                });
                y += 0.16;
            });
        }

        // The roll-up rides the last findings slide so the reader sees the whole
        // fleet accounted for in one view.
        if (pageIndex === pages.length - 1 && model.overview.absent) {
            addAbsentRollup(model, slide, Math.min(y + 0.10, 5.94));
        }
        addNotes(slide, model, 'Findings calculated from the normalized System Health sensor rows using the report thresholds: elevated at 80%, at capacity at 100%.');
    });
}

function addAbsentRollup(model, slide, y) {
    const palette = model.palette;
    const overview = model.overview;
    const parts = [];
    if (overview.offline) parts.push(`${formatInteger(overview.offline)} unreachable`);
    if (overview.no_access) parts.push(`${formatInteger(overview.no_access)} requires additional configuration`);
    slide.addShape(model.pptx.ShapeType.roundRect, {
        x: MARGIN, y, w: SLIDE_WIDTH - MARGIN * 2, h: 0.84, rectRadius: 0.13,
        fill: { color: pptColor(palette.altRow) },
        line: { color: pptColor(palette.grid), width: 0.75 }
    });
    slide.addShape(model.pptx.ShapeType.rect, {
        x: MARGIN, y, w: 0.055, h: 0.84,
        fill: { color: pptColor(palette.absent) }, line: { type: 'none' }
    });
    slide.addText(`${formatInteger(overview.absent)} ${overview.absent === 1 ? 'sensor' : 'sensors'} returned no data`, {
        x: MARGIN + 0.34, y: y + 0.15, w: 8.6, h: 0.26, fontFace: FONT, fontSize: 13,
        bold: true, color: pptColor(palette.text), margin: 0
    });
    slide.addText(`${joinList(parts)}. No utilization conclusions are drawn for these sensors.`, {
        x: MARGIN + 0.34, y: y + 0.45, w: 8.8, h: 0.24, fontFace: FONT, fontSize: 10.5,
        color: pptColor(palette.muted), margin: 0, breakLine: false, fit: 'shrink'
    });
    slide.addText('Full list in appendix', {
        x: 10.0, y: y + 0.29, w: 2.63, h: 0.24, fontFace: FONT, fontSize: 10.5,
        color: pptColor(palette.muted), margin: 0, align: 'right'
    });
}

/* ---------------------------------------------------------------- charts */

// Chart specs are declared against the normalized rows, so the deck no longer
// depends on canvas screenshots captured by the report module.
function chartSpecs(model) {
    const cycle = model.meta.cycle_label || 'reported-cycle';
    return [
        {
            key: 'packet',
            title: 'Sensor packet rate headroom',
            subtitle: `Highest ${cycle} bucket average against rated model capacity`,
            value: row => finiteNumber(row.packetPeak),
            capacity: row => finiteNumber(row.packetCapacity),
            format: formatRate
        },
        {
            key: 'throughput',
            title: 'Sensor throughput headroom',
            subtitle: `Highest ${cycle} bucket average against rated model capacity`,
            value: row => finiteNumber(row.throughputGbps),
            capacity: row => finiteNumber(row.throughputCapacity),
            format: formatGbps
        },
        {
            key: 'triggers',
            title: 'Sensor trigger processing headroom',
            subtitle: `Maximum aligned ${cycle} utilization · cycles used and available share one bucket · drops are report-window totals`,
            value: row => finiteNumber(row.triggerCyclesPeak),
            capacity: row => finiteNumber(row.triggerCyclesAvail),
            format: value => formatCompact(value),
            note: row => Number(row.triggerDropsTotal || 0) > 0
                ? `${formatCompact(row.triggerDropsTotal)} drops` : ''
        },
        {
            key: 'advanced',
            title: 'Advanced Analysis capacity',
            subtitle: 'Devices in Advanced Analysis against licensed capacity',
            value: row => finiteNumber(row.analysis && row.analysis.advanced),
            capacity: row => finiteNumber(row.advancedCapacity),
            eligible: supportsDeviceAnalysis,
            format: value => `${formatInteger(value)} devices`,
            note: row => {
                const discovery = finiteNumber(row.analysis && row.analysis.discovery);
                return discovery ? `${formatInteger(discovery)} in Discovery` : '';
            }
        },
        {
            key: 'standard',
            title: 'Standard Analysis capacity',
            subtitle: 'Devices in Standard Analysis against licensed capacity',
            value: row => finiteNumber(row.analysis && row.analysis.standard),
            capacity: row => finiteNumber(row.standardCapacity),
            eligible: supportsDeviceAnalysis,
            format: value => `${formatInteger(value)} devices`,
            note: row => {
                const discovery = finiteNumber(row.analysis && row.analysis.discovery);
                return discovery ? `${formatInteger(discovery)} in Discovery` : '';
            }
        }
    ];
}

// Rank the whole fleet by utilization. Limiting pages after grouping by model
// allowed a populous model to consume the page budget and hide higher-risk
// sensors from smaller groups. Each ratio still uses that sensor's own model or
// licensed capacity, and the appendix preserves the model detail.
function chartPagesForSpec(model, spec) {
    const offlineNames = model.rows
        .filter(row => row.offline)
        .map(row => cleanText(row.name || row.hostname || row.id, 120) || 'Unknown sensor')
        .sort((a, b) => a.localeCompare(b));
    const measured = model.rows
        .filter(row => !isAbsent(row) && (!spec.eligible || spec.eligible(row)))
        .map(row => ({
            row,
            model: cleanText(row.license_platform || (row.capacity && row.capacity.model) || 'Unknown', 80),
            value: spec.value(row),
            capacity: spec.capacity(row),
            ratio: safeRatio(spec.value(row), spec.capacity(row))
        }))
        .filter(entry => entry.value !== null && entry.ratio !== null)
        .sort((a, b) => b.ratio - a.ratio
            || String(a.row.name || '').localeCompare(String(b.row.name || '')));
    if (!measured.length) return [];

    const shown = measured.slice(0, CHART_ROWS_PER_SLIDE * CHART_PAGES_PER_METRIC);
    return chunk(shown, CHART_ROWS_PER_SLIDE).map(entries => {
        const models = [...new Set(entries.map(entry => entry.model))];
        const capacities = [...new Set(entries.map(entry => entry.capacity).filter(value => value > 0))];
        return {
            model: models.length === 1 ? models[0] : 'Mixed models',
            capacity: capacities.length === 1 ? capacities[0] : null,
            capacity_varies: capacities.length > 1,
            entries,
            measured: measured.length,
            withheld: measured.length - shown.length,
            offline_names: offlineNames
        };
    });
}

function addChartSlides(model, assets) {
    chartSpecs(model).forEach(spec => {
        const pages = chartPagesForSpec(model, spec);
        pages.forEach((page, index) => {
            const suffix = pages.length > 1 ? ` · ${index + 1} of ${pages.length}` : '';
            const capacityLabel = page.capacity ? ` · rated ${spec.format(page.capacity)}`
                : page.capacity_varies ? ' · capacity varies by sensor' : '';
            addChartSlide(model, assets, spec, page,
                `${spec.title}${suffix}`,
                `${spec.subtitle} · ${page.model}${capacityLabel}`);
        });
    });
}

function addChartSlide(model, assets, spec, page, title, subtitle) {
    const palette = model.palette;
    const slide = addContentSlide(model, title, subtitle, assets, 'Capacity', palette.muted);
    const plotLeft = 3.35;
    const plotRight = 10.35;
    const span = plotRight - plotLeft;
    const top = 1.90;
    const rowHeight = 0.44;
    const entries = page.entries;
    const bottom = top + rowHeight * entries.length;

    // The track ends at 100% of capacity, so only the 80% guide needs drawing.
    const guideX = plotLeft + span * 0.8;
    slide.addShape(model.pptx.ShapeType.line, {
        x: guideX, y: top - 0.06, w: 0, h: bottom + 0.02 - (top - 0.06),
        line: { color: pptColor(palette.mid), width: 0.75, dashType: 'dash' }
    });
    slide.addText('80%', {
        x: guideX - 0.40, y: top - 0.28, w: 0.8, h: 0.18, fontFace: FONT, fontSize: 7.5,
        bold: true, color: pptColor(palette.mid), margin: 0, align: 'center', charSpacing: 1
    });
    slide.addText('MODEL CAPACITY', {
        x: plotRight - 1.8, y: top - 0.28, w: 1.8, h: 0.18, fontFace: FONT, fontSize: 7.5,
        bold: true, color: pptColor(palette.muted), margin: 0, align: 'right', charSpacing: 1
    });

    let y = top;
    entries.forEach(entry => {
        const ratio = entry.ratio;
        const barColor = ratio >= 1 ? palette.high : ratio >= 0.8 ? palette.mid : palette.low;
        slide.addText(clipName(entry.row.name || entry.row.hostname || entry.row.id), {
            x: MARGIN, y: y + 0.055, w: 2.45, h: 0.26, fontFace: FONT, fontSize: 10,
            color: pptColor(palette.subtle), margin: 0, align: 'right', breakLine: false
        });
        slide.addShape(model.pptx.ShapeType.rect, {
            x: plotLeft, y: y + 0.065, w: span, h: 0.24,
            fill: { color: pptColor(palette.track) }, line: { type: 'none' }
        });
        slide.addShape(model.pptx.ShapeType.rect, {
            x: plotLeft, y: y + 0.065, w: Math.max(span * Math.min(ratio, 1), 0.035), h: 0.24,
            fill: { color: pptColor(barColor) }, line: { type: 'none' }
        });
        slide.addText(ratio >= 0.01 ? formatPercent(ratio) : '<1%', {
            x: plotRight + 0.20, y: y + 0.055, w: 0.66, h: 0.26, fontFace: FONT, fontSize: 10,
            bold: true, color: pptColor(palette.text), margin: 0, align: 'right'
        });
        const note = spec.note ? spec.note(entry.row) : '';
        slide.addText(note || spec.format(entry.value), {
            x: plotRight + 0.96, y: y + 0.055, w: 1.55, h: 0.26, fontFace: FONT, fontSize: 10,
            color: pptColor(note ? palette.high : palette.muted), margin: 0, align: 'right',
            breakLine: false, fit: 'shrink'
        });
        y += rowHeight;
    });

    slide.addShape(model.pptx.ShapeType.line, {
        x: MARGIN, y: y + 0.22, w: SLIDE_WIDTH - MARGIN * 2, h: 0,
        line: { color: pptColor(palette.grid), width: 0.75 }
    });
    const caption = [
        offlineSummaryText(page.offline_names),
        page.withheld > 0 ? `${formatInteger(page.withheld)} lower-ranked sensors continue in the appendix` : ''
    ].filter(Boolean).join('\n');
    if (caption) {
        slide.addText(caption, {
            x: MARGIN, y: y + 0.36, w: 8.8, h: 0.52, fontFace: FONT, fontSize: 9,
            color: pptColor(palette.muted), margin: 0, breakLine: true, fit: 'shrink'
        });
    }
    slide.addText('Sorted by percent of model capacity', {
        x: 9.2, y: y + 0.36, w: 3.45, h: 0.22, fontFace: FONT, fontSize: 10,
        color: pptColor(palette.muted), margin: 0, align: 'right'
    });
    const roleNote = spec.eligible
        ? ' IDS and Flow Sensors are omitted because device-analysis tiers do not apply to those roles.'
        : '';
    addNotes(slide, model, `Drawn from the normalized System Health rows for ${page.model}; offline sensors are not plotted.${roleNote}`);
}

function clipName(value, limit = 30) {
    const text = cleanText(value, 120) || 'Unknown sensor';
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/* --------------------------------------------------- packetstore charts */

// The three packetstore charts share one renderer because they differ only in
// how many bars a row carries and what the bar is measured against. Retention
// is scaled to the longest lookback on the page. Fidelity and load use a fixed
// 100% scale so the visual proportions match the reported percentages.
function packetstoreFidelityLabelParts(row) {
    const packetSeverity = packetstoreDropSeverity(row.packetDropRatio, row.packetDropsTotal);
    const secretSeverity = packetstoreDropSeverity(row.secretDropRatio, row.secretDropsTotal);
    return [
        { text: `packets ${formatLossPercent(row.packetDropRatio)} ·`, severity: packetSeverity, width: 1.14 },
        { text: `secrets ${formatLossPercent(row.secretDropRatio)} (${formatCompact(row.secretDropsTotal)} / ${formatCompact(row.secretsTotal)})`, severity: secretSeverity, width: 2.01 }
    ];
}

function packetstoreChartSpecs(model) {
    const cycle = model.meta.cycle_label || 'reported-cycle';
    return [
        {
            key: 'retention',
            title: 'Packetstore retention',
            kicker: 'RETENTION',
            subtitle: 'Latest estimated PCAP lookback by reporting source · neutral marker shows the minimum observed in the window',
            axis: 'LONGEST LOOKBACK ON PAGE',
            // No customer retention target is collected, so a short lookback is
            // reported as an observation and never colored as a finding.
            series: [{ value: row => finiteNumber(row.lookbackLatestSec), color: palette => palette.low }],
            marker: row => finiteNumber(row.lookbackMinSec),
            include: (row, values) => values[0] !== null && values[0] > 0,
            scaleMax: entries => Math.max(...entries.map(entry => entry.values[0] || 0), 1),
            label: row => {
                const latest = finiteNumber(row.lookbackLatestSec);
                const minimum = finiteNumber(row.lookbackMinSec);
                if (latest === null) return 'unavailable';
                return `${formatDays(latest)} latest${minimum === null ? '' : ` · ${formatDays(minimum)} min`}`;
            },
            sort: row => finiteNumber(row.lookbackLatestSec) || 0
        },
        {
            key: 'fidelity',
            title: 'Packetstore capture and secret fidelity',
            kicker: 'DATA LOSS',
            subtitle: 'Share of offered packets and TLS secrets dropped · report-window totals',
            axis: '100% OF OFFERED TOTAL',
            series: [
                {
                    value: row => finiteNumber(row.packetDropRatio),
                    color: (palette, value) => packetstoreSeverityColor(palette, packetstoreDropSeverity(value), palette.low)
                },
                {
                    value: row => finiteNumber(row.secretDropRatio),
                    color: (palette, value) => packetstoreSeverityColor(palette, packetstoreDropSeverity(value), palette.low)
                }
            ],
            // A counter can prove loss even when the offered-total denominator
            // is unavailable. Keep that row in the chart and show its counters
            // instead of dropping the appliance along with its missing rate.
            include: (row, values) => hasCaptureLoss(row) || values.some(value => value !== null),
            scaleMax: () => 1,
            label: row => `packets ${formatLossPercent(row.packetDropRatio)} · secrets ${formatLossPercent(row.secretDropRatio)} (${formatCompact(row.secretDropsTotal)} / ${formatCompact(row.secretsTotal)})`,
            labelParts: packetstoreFidelityLabelParts,
            note: row => `slow-write ${formatInteger(row.slowWriteDropsTotal)} · interface ${formatInteger(row.interfaceDropsTotal)} · blocks ${formatInteger(row.blocksDroppedTotal)}`,
            alertNote: row => (finiteNumber(row.slowWriteDropsTotal) || 0) > 0
                || (finiteNumber(row.interfaceDropsTotal) || 0) > 0
                || (finiteNumber(row.blocksDroppedTotal) || 0) > 0,
            // Counter-only loss sorts ahead of clean zero-rate rows, even when
            // a missing denominator prevents calculating a comparable rate.
            sort: row => -(hasCaptureLoss(row) ? 1 : 0)
                - Math.max(finiteNumber(row.packetDropRatio) || 0, finiteNumber(row.secretDropRatio) || 0)
        },
        {
            key: 'load',
            title: 'Packetstore processing headroom',
            kicker: 'HEADROOM',
            subtitle: `Highest sampled ${cycle} bucket-average input, header-compression, and disk-write load · the three are separate and are not summed`,
            axis: 'FULL LOAD',
            guide: PROCESSING_LOAD_GUIDE,
            series: [
                { value: row => ratioOfPercent(row.inputLoadPeak), color: utilizationColor },
                { value: row => ratioOfPercent(row.compressionLoadPeak), color: utilizationColor },
                { value: row => ratioOfPercent(row.diskWriteLoadPeak), color: utilizationColor }
            ],
            scaleMax: () => 1,
            label: row => `input ${formatPercent(ratioOfPercent(row.inputLoadPeak))} · compress ${formatPercent(ratioOfPercent(row.compressionLoadPeak))} · write ${formatPercent(ratioOfPercent(row.diskWriteLoadPeak))}`,
            alert: hasProcessingPressure,
            sort: row => -(peakProcessingLoad(row) || 0)
        }
    ];
}

function ratioOfPercent(value) {
    const number = finiteNumber(value);
    return number === null ? null : number / 100;
}

function utilizationColor(palette, ratio) {
    return ratio >= 1 ? palette.high : ratio >= PROCESSING_LOAD_GUIDE ? palette.mid : palette.low;
}

function formatDays(seconds) {
    const number = finiteNumber(seconds);
    return number === null ? '—' : `${(number / 86400).toFixed(1)}d`;
}

function addPacketstoreChartSlides(model, assets) {
    if (!model.packetstore_rows.length) return;
    const offlineNames = model.packetstore_rows
        .filter(row => row.offline)
        .map(row => cleanText(row.name || row.hostname || row.id, 120) || 'Unknown sensor')
        .sort((a, b) => a.localeCompare(b));
    packetstoreChartSpecs(model).forEach(spec => {
        const measured = model.packetstore_rows
            .filter(row => !row.offline)
            .map(row => ({ row, values: spec.series.map(series => series.value(row)) }))
            .filter(entry => spec.include
                ? spec.include(entry.row, entry.values)
                : entry.values.some(value => value !== null))
            .sort((a, b) => spec.sort(a.row) - spec.sort(b.row)
                || String(a.row.name || '').localeCompare(String(b.row.name || '')));
        if (!measured.length) return;
        const shown = measured.slice(0, PACKETSTORE_CHART_ROWS_PER_SLIDE * CHART_PAGES_PER_METRIC);
        const pages = chunk(shown, PACKETSTORE_CHART_ROWS_PER_SLIDE);
        pages.forEach((entries, index) => {
            const suffix = pages.length > 1 ? ` · ${index + 1} of ${pages.length}` : '';
            addPacketstoreChartSlide(model, assets, spec, entries, `${spec.title}${suffix}`, {
                withheld: index === pages.length - 1 ? measured.length - shown.length : 0,
                offline_names: offlineNames,
                show_retention_average: spec.key === 'retention' && index === 0
            });
        });
    });
}

function addPacketstoreChartSlide(model, assets, spec, entries, title, page) {
    const palette = model.palette;
    const slide = addContentSlide(model, title, spec.subtitle, assets, spec.kicker, palette.muted);
    const plotLeft = 3.35;
    const plotRight = 9.30;
    const span = plotRight - plotLeft;
    const top = 1.92;
    const rowHeight = 0.56;
    const bottom = top + rowHeight * entries.length;
    const scaleMax = spec.scaleMax(entries) || 1;

    if (page.show_retention_average && model.overview.packetstore_lookback_average_sec !== null) {
        const count = model.overview.packetstore_lookback_reporting_sources;
        slide.addText('AVERAGE LOOKBACK', {
            x: 9.55, y: 0.55, w: 3.05, h: 0.18, fontFace: FONT, fontSize: 8.5,
            bold: true, color: pptColor(palette.muted), margin: 0, charSpacing: 1.4,
            align: 'right'
        });
        slide.addText(formatDays(model.overview.packetstore_lookback_average_sec), {
            x: 9.55, y: 0.77, w: 3.05, h: 0.48, fontFace: FONT, fontSize: 31,
            bold: true, color: pptColor(palette.text), margin: 0, align: 'right', fit: 'shrink'
        });
        slide.addText(`${formatInteger(count)} reporting ${count === 1 ? 'source' : 'sources'}`, {
            x: 9.55, y: 1.27, w: 3.05, h: 0.18, fontFace: FONT, fontSize: 9,
            color: pptColor(palette.muted), margin: 0, align: 'right', fit: 'shrink'
        });
    }

    if (spec.guide) {
        const guideX = plotLeft + span * spec.guide;
        slide.addShape(model.pptx.ShapeType.line, {
            x: guideX, y: top - 0.06, w: 0, h: bottom + 0.02 - (top - 0.06),
            line: { color: pptColor(palette.mid), width: 0.75, dashType: 'dash' }
        });
        slide.addText(formatPercent(spec.guide), {
            x: guideX - 0.40, y: top - 0.28, w: 0.8, h: 0.18, fontFace: FONT, fontSize: 7.5,
            bold: true, color: pptColor(palette.mid), margin: 0, align: 'center', charSpacing: 1
        });
    }
    slide.addText(spec.axis, {
        x: plotRight - 2.4, y: top - 0.28, w: 2.4, h: 0.18, fontFace: FONT, fontSize: 7.5,
        bold: true, color: pptColor(palette.muted), margin: 0, align: 'right', charSpacing: 1
    });

    // Bars are stacked vertically inside the row and centered as a block, so a
    // one-bar chart and a three-bar chart keep the same row rhythm.
    const count = spec.series.length;
    const barHeight = count === 1 ? 0.24 : count === 2 ? 0.16 : 0.11;
    const barGap = 0.04;
    const blockHeight = count * barHeight + (count - 1) * barGap;
    let y = top;
    entries.forEach(entry => {
        const row = entry.row;
        slide.addText(clipName(`${row.name || row.hostname || row.id}`), {
            x: MARGIN, y: y + (rowHeight - 0.26) / 2, w: 2.45, h: 0.26, fontFace: FONT, fontSize: 10,
            color: pptColor(palette.subtle), margin: 0, align: 'right', breakLine: false
        });
        slide.addText(packetstoreRoleLabel(row), {
            x: MARGIN, y: y + (rowHeight - 0.26) / 2 + 0.18, w: 2.45, h: 0.16, fontFace: FONT, fontSize: 7.5,
            color: pptColor(palette.muted), margin: 0, align: 'right', charSpacing: 0.8
        });
        let barY = y + (rowHeight - blockHeight) / 2;
        entry.values.forEach((value, index) => {
            slide.addShape(model.pptx.ShapeType.rect, {
                x: plotLeft, y: barY, w: span, h: barHeight,
                fill: { color: pptColor(palette.track) }, line: { type: 'none' }
            });
            // Zero is a measured value, but it must remain an empty track. The
            // minimum width exists only to keep a genuinely non-zero value
            // visible at presentation scale.
            if (value !== null && value > 0) {
                const ratio = Math.min(value / scaleMax, 1);
                slide.addShape(model.pptx.ShapeType.rect, {
                    x: plotLeft, y: barY, w: span * ratio, h: barHeight,
                    fill: { color: pptColor(spec.series[index].color(palette, value)) },
                    line: { type: 'none' }
                });
            }
            barY += barHeight + barGap;
        });
        // Retention's minimum tick: how far the store trimmed back during the
        // window, drawn against the same scale as the latest lookback.
        const marker = spec.marker ? spec.marker(row) : null;
        if (marker !== null && marker !== undefined) {
            const markerX = plotLeft + span * Math.min(marker / scaleMax, 1);
            slide.addShape(model.pptx.ShapeType.rect, {
                x: markerX - 0.015, y: y + (rowHeight - blockHeight) / 2 - 0.04, w: 0.03, h: blockHeight + 0.08,
                // Retention has no configured target and is not scored, so its
                // observed-minimum tick stays neutral rather than implying an
                // alert solely because the lookback changed.
                fill: { color: pptColor(palette.muted) }, line: { type: 'none' }
            });
        }
        const alert = spec.alert ? spec.alert(row) : false;
        const note = spec.note ? spec.note(row) : '';
        const labelY = y + (rowHeight - (note ? 0.44 : 0.26)) / 2;
        if (spec.labelParts) {
            let partX = plotRight + 0.22;
            spec.labelParts(row).forEach(part => {
                slide.addText(part.text, {
                    x: partX, y: labelY, w: part.width, h: 0.24,
                    fontFace: FONT, fontSize: 9.5, bold: part.severity !== 'clean',
                    color: pptColor(packetstoreSeverityColor(palette, part.severity)),
                    margin: 0, breakLine: false
                });
                partX += part.width;
            });
        } else {
            slide.addText(spec.label(row), {
                x: plotRight + 0.22, y: labelY, w: 3.15, h: 0.24,
                fontFace: FONT, fontSize: 9.5, bold: alert,
                color: pptColor(alert ? palette.high : palette.text), margin: 0, breakLine: false, fit: 'shrink'
            });
        }
        if (note) {
            const noteAlert = spec.alertNote ? spec.alertNote(row) : false;
            const noteY = y + (rowHeight - 0.44) / 2 + 0.22;
            if (spec.noteParts) {
                let partX = plotRight + 0.22;
                spec.noteParts(row).forEach(part => {
                    slide.addText(part.text, {
                        x: partX, y: noteY, w: part.width, h: 0.20,
                        fontFace: FONT, fontSize: 8.5, bold: part.severity === 'warning',
                        color: pptColor(part.severity === 'warning' ? palette.mid : palette.muted),
                        margin: 0, breakLine: false
                    });
                    partX += part.width;
                });
            } else {
                slide.addText(note, {
                    x: plotRight + 0.22, y: noteY, w: 3.15, h: 0.20,
                    fontFace: FONT, fontSize: 8.5, bold: noteAlert,
                    color: pptColor(noteAlert ? palette.mid : palette.muted),
                    margin: 0, breakLine: false, fit: 'shrink'
                });
            }
        }
        y += rowHeight;
    });

    slide.addShape(model.pptx.ShapeType.line, {
        x: MARGIN, y: y + 0.20, w: SLIDE_WIDTH - MARGIN * 2, h: 0,
        line: { color: pptColor(palette.grid), width: 0.75 }
    });
    const caption = spec.key === 'load'
        ? 'Bars are scaled to full load; the three loads are measured separately.'
        : spec.key === 'fidelity'
            ? 'Bars use a fixed 0–100% scale. Orange marks >0–1% warning; red marks >1% critical. Positive cause counters are orange.'
            : 'Bars are scaled to the longest lookback on this page. Retention is reported, not scored: no customer retention target is collected.';
    slide.addText([
        offlineSummaryText(page.offline_names, 300),
        caption,
        page.withheld > 0
        ? `${formatInteger(page.withheld)} lower-ranked Packetstore sources continue in the appendix`
        : ''
    ].filter(Boolean).join('\n'), {
        x: MARGIN, y: y + 0.34, w: SLIDE_WIDTH - MARGIN * 2, h: 0.56, fontFace: FONT, fontSize: 8.5,
        color: pptColor(palette.muted), margin: 0, breakLine: true, fit: 'shrink'
    });
    addNotes(slide, model, 'Packetstore cpc metrics. Counters are report-window totals; lookback and processing loads are time-series summaries.');
}

/* ---------------------------------------------------------------- actions */

function addRecommendationSlide(model, assets) {
    const palette = model.palette;
    const slide = addContentSlide(model, 'Recommended next steps',
        'Actions derived from the conditions observed in this report', assets);
    model.recommendations.forEach((recommendation, index) => {
        const y = 1.72 + index * 1.02;
        const color = recommendationColor(recommendation, palette, model.overview);
        slide.addShape(model.pptx.ShapeType.ellipse, {
            x: MARGIN, y, w: 0.44, h: 0.44,
            fill: { color: pptColor(color) }, line: { type: 'none' }
        });
        slide.addText(String(index + 1), {
            x: MARGIN, y: y + 0.09, w: 0.44, h: 0.22, fontFace: FONT, fontSize: 12,
            bold: true, color: 'FFFFFF', align: 'center', margin: 0
        });
        slide.addText(recommendation, {
            x: MARGIN + 0.72, y: y - 0.02, w: 11.2, h: 0.6, fontFace: FONT, fontSize: 14.5,
            color: pptColor(palette.text), margin: 0, breakLine: false, fit: 'shrink',
            valign: 'top'
        });
    });
    addNotes(slide, model, 'Recommended actions are deterministic suggestions derived from the findings in this report and should be validated against deployment context.');
}

function recommendationColor(recommendation, palette, overview = {}) {
    const text = String(recommendation || '');
    if (/capture loss/i.test(text)) {
        return overview.packetstore_loss_severity === 'critical' ? palette.high : palette.mid;
    }
    if (/restore(?: appliance)? connectivity|data access|trigger drops/i.test(text)) return palette.high;
    if (/capacity pressure|confirm headroom|analysis assignments|licensed capacity|license|synchronization/i.test(text)) {
        return palette.mid;
    }
    return palette.low;
}

/* ---------------------------------------------------------------- appendix */

function addAppendixSlides(model, assets) {
    const palette = model.palette;
    const ordered = [...model.rows].sort((a, b) => {
        if (isAbsent(a) !== isAbsent(b)) return isAbsent(a) ? 1 : -1;
        const risk = row => Math.max(
            safeRatio(row.packetPeak, row.packetCapacity) || 0,
            safeRatio(row.throughputGbps, row.throughputCapacity) || 0,
            finiteNumber(row.triggerUtilization) || 0
        );
        return risk(b) - risk(a) || String(a.name || '').localeCompare(String(b.name || ''));
    });
    chunk(ordered, APPENDIX_ROWS_PER_SLIDE).forEach((items, pageIndex, pages) => {
        const suffix = pages.length > 1 ? ` · ${pageIndex + 1} of ${pages.length}` : '';
        const slide = addContentSlide(model, `Appendix · Sensor detail${suffix}`,
            'Every sensor in the fleet, including those excluded from the charts', assets);
        const headers = ['Sensor', 'Model', 'Status', 'Packet peak', 'Throughput peak',
            'Trigger', 'Drops', 'Advanced', 'Standard', 'Discovery'];
        const rows = [headers.map(text => tableCell(text, {
            bold: true, color: palette.muted, fill: palette.bg, fontSize: 8.5
        }))];
        items.forEach((row, index) => {
            const fill = index % 2 ? palette.altRow : palette.bg;
            const analysis = row.analysis || {};
            const absent = isAbsent(row);
            const ink = absent ? palette.muted : palette.subtle;
            rows.push([
                tableCell(clipName(row.name || row.hostname || row.id, 26), { bold: true, fill, color: absent ? palette.muted : palette.text }),
                tableCell(row.license_platform || (row.capacity && row.capacity.model) || 'Unknown', { fill, color: ink }),
                tableCell(String(sensorStatus(row)).replace(/_/g, ' '), { fill, color: ink }),
                tableCell(formatRate(row.packetPeak), { fill, color: ink }),
                tableCell(formatGbps(row.throughputGbps), { fill, color: ink }),
                tableCell(formatPercent(row.triggerUtilization), { fill, color: ink }),
                tableCell(formatInteger(row.triggerDropsTotal), { fill, color: ink }),
                tableCell(tierValue(analysis.advanced, row.advancedCapacity), { fill, color: ink }),
                tableCell(tierValue(analysis.standard, row.standardCapacity), { fill, color: ink }),
                tableCell(formatInteger(analysis.discovery), { fill, color: ink })
            ]);
        });
        slide.addTable(rows, {
            x: MARGIN, y: 1.62, w: SLIDE_WIDTH - MARGIN * 2, h: 5.1,
            colW: [1.85, 1.25, 1.12, 1.16, 1.24, 0.72, 0.68, 1.02, 1.02, 0.87],
            rowH: 0.42, fontFace: FONT, fontSize: 8.5,
            color: pptColor(palette.subtle), margin: 0.05,
            border: [
                { type: 'none' }, { type: 'none' },
                { type: 'solid', color: pptColor(palette.grid), pt: 0.5 },
                { type: 'none' }
            ],
            valign: 'middle', breakLine: false
        });
        addNotes(slide, model, 'Editable appendix values projected from the normalized System Health rows; missing values are shown as em dashes and never as zero.');
    });
}

function tierValue(value, capacity) {
    const used = finiteNumber(value);
    const cap = finiteNumber(capacity);
    if (used === null) return '—';
    return cap && cap > 0 ? `${formatInteger(used)} / ${formatInteger(cap)}` : formatInteger(used);
}

function tableCell(text, options = {}) {
    const cellOptions = {};
    if (options.bold) cellOptions.bold = true;
    if (options.color) cellOptions.color = pptColor(options.color);
    if (options.fill) cellOptions.fill = pptColor(options.fill);
    if (options.fontSize) cellOptions.fontSize = options.fontSize;
    return { text: cleanText(text, 480), options: cellOptions };
}

/* ---------------------------------------------------------------- assembly */

function createPresentation(deckModel, PptxGenJS, assets = {}) {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = deckModel.options.prepared_by || 'ExtraHop Admin Tools';
    pptx.company = 'ExtraHop';
    pptx.subject = 'System Health Review';
    pptx.title = deckModel.options.title;
    pptx.lang = 'en-US';
    pptx.theme = { headFontFace: FONT, bodyFontFace: FONT, lang: 'en-US' };
    const model = { ...deckModel, pptx, slideNumber: 0, gradient: gradientBackground() };
    addCover(model, assets);
    addOverview(model, assets);
    // Actions come before the evidence that supports them. In the previous
    // layout they landed on slide 46, after the reader had already left.
    addRecommendationSlide(model, assets);
    addAttentionSlides(model, assets);
    addChartSlides(model, assets);
    addPacketstoreChartSlides(model, assets);
    addAppendixSlides(model, assets);
    return pptx;
}
function ensurePptxGen() {
    if (typeof window.PptxGenJS === 'function') return Promise.resolve(window.PptxGenJS);
    if (pptxGenPromise) return pptxGenPromise;
    pptxGenPromise = new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-system-health-pptxgen]');
        const script = existing || document.createElement('script');
        const fail = () => {
            pptxGenPromise = null;
            reject(new Error('Could not load the local PowerPoint export library.'));
        };
        script.addEventListener('load', () => {
            if (typeof window.PptxGenJS === 'function') resolve(window.PptxGenJS);
            else fail();
        }, { once: true });
        script.addEventListener('error', fail, { once: true });
        if (!existing) {
            script.src = PPTXGEN_URL;
            script.async = true;
            script.dataset.systemHealthPptxgen = 'true';
            document.head.appendChild(script);
        }
    });
    return pptxGenPromise;
}

async function binaryDataUrl(path, mimeType) {
    const response = await fetch(path, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Could not load presentation asset ${path}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return `data:${mimeType};base64,${btoa(binary)}`;
}

async function loadAssets() {
    const [colorLogo, whiteLogo] = await Promise.all([
        binaryDataUrl('assets/eh-logo-color.png', 'image/png').catch(() => ''),
        binaryDataUrl('assets/eh-logo-white.png', 'image/png').catch(() => '')
    ]);
    return { colorLogo, whiteLogo };
}

async function exportDeck(input) {
    const model = buildDeckModel(input);
    const [PptxGenJS, assets] = await Promise.all([ensurePptxGen(), loadAssets()]);
    const pptx = createPresentation(model, PptxGenJS, assets);
    await pptx.writeFile({ fileName: model.filename, compression: true });
    return { filename: model.filename, slide_count: pptx._slides ? pptx._slides.length : null };
}

window.SystemHealthPptx = {
    resolveOptions,
    buildDeckModel,
    createPresentation,
    exportDeck
};

})();
