// System Health PowerPoint Export
//
// This module deliberately knows nothing about ExtraHop API response shapes or
// chart rendering. The System Health report passes it a safe, normalized deck
// model containing report metadata, display rows, resolved colors, and PNG
// charts. PptxGenJS is loaded only when the user confirms an export.

(() => {

if (window.SystemHealthPptx) return;

const PPTXGEN_URL = 'js/vendor/pptxgen.bundle.js?v=4.0.1';
const SLIDE_WIDTH = 13.333;
const SLIDE_HEIGHT = 7.5;
const MARGIN = 0.62;
const FONT = 'Arial';
const BRAND_SAPPHIRE = '#261f63';
const DEFAULT_TITLE = 'System Health Review';
const ATTENTION_ROWS_PER_SLIDE = 10;
const APPENDIX_ROWS_PER_SLIDE = 11;
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
        bg: '#ffffff', text: BRAND_SAPPHIRE, subtle: '#4d477f', muted: '#74709b',
        grid: '#dcdbe6', track: '#e9e9ef', altRow: '#f5f5f8',
        low: '#00aaef', mid: '#f05918', high: '#ec0089'
    };
    const palette = {};
    Object.keys(fallback).forEach(key => {
        palette[key] = validHex(raw[key]) ? String(raw[key]).toLowerCase() : fallback[key];
    });
    palette.transparent = !!raw.transparent;
    return palette;
}

function validHex(value) {
    return /^#[0-9a-f]{6}$/i.test(String(value || ''));
}

function sensorStatus(row) {
    const states = Object.values(row.collectionStatus || {});
    const incomplete = states.find(state => !['complete', 'zero_valued'].includes(state));
    if (incomplete) return incomplete;
    if (states.length && states.every(state => state === 'zero_valued')) return 'zero_valued';
    return row.offline ? 'offline' : 'complete';
}

function findingForRow(row) {
    const critical = [];
    const warning = [];
    const add = (list, text) => {
        if (text && !list.includes(text)) list.push(text);
    };

    if (row.offline) add(critical, 'Appliance is offline');
    if (row.data_access === false) add(critical, 'Data access is unavailable');

    const packetRatio = safeRatio(row.packetPeak, row.packetCapacity);
    const throughputRatio = safeRatio(row.throughputGbps, row.throughputCapacity);
    const triggerRatio = finiteNumber(row.triggerUtilization);
    const advancedRatio = safeRatio(row.analysis && row.analysis.advanced, row.advancedCapacity);
    const standardRatio = safeRatio(row.analysis && row.analysis.standard, row.standardCapacity);
    const utilizationFindings = [
        ['Packet rate', packetRatio],
        ['Throughput', throughputRatio],
        ['Trigger load', triggerRatio],
        ['Advanced analysis', advancedRatio],
        ['Standard analysis', standardRatio]
    ];
    utilizationFindings.forEach(([label, ratio]) => {
        if (ratio === null) return;
        if (ratio >= 1) add(critical, `${label} at ${Math.round(ratio * 100)}% of capacity`);
        else if (ratio >= 0.8) add(warning, `${label} at ${Math.round(ratio * 100)}% of capacity`);
    });

    const drops = finiteNumber(row.triggerDropsTotal);
    if (drops !== null && drops > 0) add(critical, `${formatInteger(drops)} trigger drops`);
    const discovery = finiteNumber(row.analysis && row.analysis.discovery);
    if (discovery !== null && discovery > 0) add(warning, `${formatInteger(discovery)} devices in Discovery`);

    (row.health_conditions || []).forEach(condition => {
        if (condition && condition.type === 'offline' && row.offline) return;
        if (condition && condition.type === 'data_access' && row.data_access === false) return;
        const message = cleanText(condition && condition.message, 160);
        if (!message) return;
        add(condition.status === 'failed' ? critical : warning, sentenceCase(message));
    });

    const collection = row.collectionStatus || {};
    const collectionLabels = {
        pkts: 'Packet rate', bytes: 'Throughput', trigger_utilization: 'Trigger utilization',
        trigger_drops: 'Trigger drops', device_analysis: 'Device analysis'
    };
    Object.entries(collectionLabels).forEach(([key, label]) => {
        const status = collection[key];
        if (status && !['complete', 'zero_valued'].includes(status)) {
            add(warning, `${label} data ${String(status).replace(/_/g, ' ')}`);
        }
    });

    const severity = critical.length ? 'CRITICAL' : warning.length ? 'WARNING' : 'OK';
    const findings = critical.concat(warning);
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
        findings,
        finding_text: findings.join('; '),
        worst_ratio: worstRatio,
        row
    };
}

function recommendationsFromFindings(findings) {
    const recommendations = [];
    const has = pattern => findings.some(item => pattern.test(item.finding_text));
    if (has(/trigger drops/i)) {
        recommendations.push('Investigate sensors with trigger drops first; validate trigger load and execution behavior during the reported window.');
    }
    if (has(/packet rate|throughput|trigger load/i)) {
        recommendations.push('Review sustained capacity pressure against appliance sizing and expected traffic growth.');
    }
    if (has(/advanced analysis|standard analysis|Discovery/i)) {
        recommendations.push('Rebalance analysis assignments and confirm licensed capacity before moving additional devices into higher analysis tiers.');
    }
    if (has(/offline|data access|data .*empty|data .*failed|data .*timed out/i)) {
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

function buildDeckModel(input) {
    const meta = { ...(input && input.meta || {}) };
    const options = resolveOptions(meta, input && input.options || {});
    const rows = Array.isArray(input && input.rows) ? input.rows.map(row => ({ ...row })) : [];
    const findings = rows.map(findingForRow)
        .filter(item => item.severity !== 'OK')
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity)
            || b.worst_ratio - a.worst_ratio
            || a.name.localeCompare(b.name));
    const modelCounts = {};
    rows.forEach(row => {
        const model = cleanText(row.license_platform || (row.capacity && row.capacity.model) || 'Unknown', 80);
        modelCounts[model] = (modelCounts[model] || 0) + 1;
    });
    const totalDrops = rows.reduce((sum, row) => sum + Math.max(0, finiteNumber(row.triggerDropsTotal) || 0), 0);
    const overview = {
        sensors: rows.length,
        active: rows.filter(row => finiteNumber(row.packetPeak) !== null && Number(row.packetPeak) > 0).length,
        offline: rows.filter(row => row.offline).length,
        attention: findings.length,
        trigger_drops: totalDrops,
        model_counts: Object.entries(modelCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    };
    return {
        options,
        meta,
        palette: normalizedPalette(input && input.palette),
        rows,
        findings,
        overview,
        recommendations: recommendationsFromFindings(findings),
        charts: Array.isArray(input && input.charts) ? input.charts : [],
        collector_notes: Array.isArray(input && input.collector_notes)
            ? input.collector_notes.map(note => cleanText(note, 300)).filter(Boolean)
            : [],
        filename: deckFilename(meta, options)
    };
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

function formatPercent(value) {
    const ratio = finiteNumber(value);
    return ratio === null ? '—' : `${Math.round(ratio * 100)}%`;
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

function addFooter(slide, model, slideNumber) {
    const palette = model.palette;
    slide.addShape(model.pptx.ShapeType.line, {
        x: MARGIN, y: 7.14, w: SLIDE_WIDTH - MARGIN * 2, h: 0,
        line: { color: pptColor(palette.grid), width: 0.7 }
    });
    slide.addText(model.options.title, {
        x: MARGIN, y: 7.19, w: 5.5, h: 0.16, fontFace: FONT, fontSize: 8,
        color: pptColor(palette.muted), margin: 0
    });
    slide.addText(String(slideNumber), {
        x: 12.15, y: 7.19, w: 0.55, h: 0.16, fontFace: FONT, fontSize: 8,
        color: pptColor(palette.muted), margin: 0, align: 'right'
    });
}

function addContentSlide(model, title, subtitle, assets) {
    const pptx = model.pptx;
    const palette = model.palette;
    const slide = pptx.addSlide();
    slide.background = { color: pptColor(palette.bg, 'FFFFFF') };
    slide.addText(title, {
        x: MARGIN, y: 0.34, w: 10.8, h: 0.46, fontFace: FONT, fontSize: 27,
        bold: true, color: pptColor(palette.text), margin: 0, breakLine: false,
        fit: 'shrink'
    });
    if (subtitle) {
        slide.addText(subtitle, {
            x: MARGIN, y: 0.9, w: 11.3, h: 0.28, fontFace: FONT, fontSize: 12,
            color: pptColor(palette.muted), margin: 0, fit: 'shrink'
        });
    }
    addLogo(slide, model, assets, 11.45, 0.42, 1.25);
    model.slideNumber += 1;
    addFooter(slide, model, model.slideNumber);
    return slide;
}

function addCover(model, assets) {
    const pptx = model.pptx;
    const palette = model.palette;
    const slide = pptx.addSlide();
    slide.background = { color: pptColor(palette.bg, 'FFFFFF') };
    slide.addShape(pptx.ShapeType.rect, {
        x: 0, y: 0, w: 0.18, h: SLIDE_HEIGHT,
        line: { color: pptColor(palette.low), transparency: 100 },
        fill: { color: pptColor(palette.low) }
    });
    slide.addShape(pptx.ShapeType.rect, {
        x: 0.18, y: 0, w: 0.18, h: SLIDE_HEIGHT,
        line: { color: pptColor(palette.mid), transparency: 100 },
        fill: { color: pptColor(palette.mid) }
    });
    slide.addShape(pptx.ShapeType.rect, {
        x: 0.36, y: 0, w: 0.18, h: SLIDE_HEIGHT,
        line: { color: pptColor(palette.high), transparency: 100 },
        fill: { color: pptColor(palette.high) }
    });
    addLogo(slide, model, assets, 0.9, 0.64, 2.05);
    slide.addText(model.options.title, {
        x: 0.9, y: 2.35, w: 10.9, h: 0.95, fontFace: FONT, fontSize: 44,
        bold: true, color: pptColor(palette.text), margin: 0, fit: 'shrink'
    });
    const subtitle = [model.options.customer, model.options.window_label].filter(Boolean).join('  |  ');
    if (subtitle) {
        slide.addText(subtitle, {
            x: 0.92, y: 3.48, w: 10.8, h: 0.44, fontFace: FONT, fontSize: 19,
            color: pptColor(palette.subtle), margin: 0, fit: 'shrink'
        });
    }
    if (model.options.context) {
        slide.addText(model.options.context, {
            x: 0.92, y: 4.26, w: 9.9, h: 0.9, fontFace: FONT, fontSize: 15,
            color: pptColor(palette.muted), margin: 0, breakLine: false, fit: 'shrink'
        });
    }
    if (model.options.prepared_by) {
        slide.addText(`Prepared by ${model.options.prepared_by}`, {
            x: 0.92, y: 6.46, w: 6.5, h: 0.3, fontFace: FONT, fontSize: 12,
            color: pptColor(palette.muted), margin: 0
        });
    }
    model.slideNumber += 1;
    addNotes(slide, model, 'ExtraHop System Health report metadata supplied by the exporting user and application.');
}

function addOverview(model, assets) {
    const subtitle = `Report window: ${model.options.window_label} · Peak ${model.meta.cycle_label || 'reported-cycle'} averages`;
    const slide = addContentSlide(model, 'Fleet health at a glance', subtitle, assets);
    const palette = model.palette;
    const stats = [
        ['Sensors', model.overview.sensors, 'returned'],
        ['Active', model.overview.active, 'seeing packets'],
        ['Offline', model.overview.offline, 'appliances'],
        ['Attention', model.overview.attention, 'sensors'],
        ['Trigger drops', formatCompact(model.overview.trigger_drops), 'total in window']
    ];
    const statWidth = 2.35;
    stats.forEach(([label, value, note], index) => {
        const x = MARGIN + index * 2.47;
        const color = (label === 'Attention' && model.overview.attention) || (label === 'Trigger drops' && model.overview.trigger_drops)
            ? palette.high : palette.text;
        slide.addText(String(value), {
            x, y: 1.62, w: statWidth, h: 0.68, fontFace: FONT, fontSize: 38,
            bold: true, color: pptColor(color), margin: 0, fit: 'shrink'
        });
        slide.addText(label, {
            x, y: 2.36, w: statWidth, h: 0.24, fontFace: FONT, fontSize: 12,
            bold: true, color: pptColor(palette.subtle), margin: 0
        });
        slide.addText(note, {
            x, y: 2.66, w: statWidth, h: 0.22, fontFace: FONT, fontSize: 10,
            color: pptColor(palette.muted), margin: 0
        });
        slide.addShape(model.pptx.ShapeType.line, {
            x, y: 3.02, w: statWidth - 0.15, h: 0,
            line: { color: pptColor(index < 3 ? palette.low : palette.high), width: 2 }
        });
    });

    const modelText = model.overview.model_counts.length
        ? model.overview.model_counts.map(([name, count]) => `${name} ×${count}`).join('   ·   ')
        : 'No sensor models reported';
    slide.addText('Fleet composition', {
        x: MARGIN, y: 3.55, w: 3.0, h: 0.3, fontFace: FONT, fontSize: 16,
        bold: true, color: pptColor(palette.text), margin: 0
    });
    slide.addText(modelText, {
        x: MARGIN, y: 3.98, w: 12.0, h: 0.65, fontFace: FONT, fontSize: 13,
        color: pptColor(palette.subtle), margin: 0, fit: 'shrink'
    });
    const notes = model.collector_notes.slice(0, 3);
    slide.addText(notes.length ? 'Collection context' : 'Review context', {
        x: MARGIN, y: 5.0, w: 3.0, h: 0.3, fontFace: FONT, fontSize: 16,
        bold: true, color: pptColor(palette.text), margin: 0
    });
    slide.addText(notes.length ? notes.map(note => `• ${note}`).join('\n') : 'All reported statistics retain their collection status; unavailable data is not treated as zero.', {
        x: MARGIN, y: 5.42, w: 11.9, h: 1.12, fontFace: FONT, fontSize: 12,
        color: pptColor(palette.subtle), margin: 0, breakLine: false, fit: 'shrink',
        valign: 'top'
    });
    addNotes(slide, model, 'Headline counts calculated from the normalized System Health sensor rows.');
}

function addAttentionSlides(model, assets) {
    const pages = chunk(model.findings, ATTENTION_ROWS_PER_SLIDE);
    pages.forEach((items, pageIndex) => {
        const suffix = pages.length > 1 ? ` · ${pageIndex + 1} of ${pages.length}` : '';
        const slide = addContentSlide(model, `Sensors that need attention${suffix}`, 'Prioritized from health state, missing data, utilization, trigger drops, and analysis pressure', assets);
        if (!items.length) {
            slide.addText('No sensors crossed the report thresholds in this window.', {
                x: MARGIN, y: 2.55, w: 11.9, h: 0.65, fontFace: FONT, fontSize: 22,
                color: pptColor(model.palette.subtle), margin: 0, align: 'center'
            });
        } else {
            const header = ['Sensor', 'Model', 'Severity', 'Finding'];
            const rows = [header.map(text => tableCell(text, {
                bold: true, color: model.palette.bg, fill: model.palette.text, fontSize: 11
            }))];
            items.forEach((item, index) => {
                const severityColor = item.severity === 'CRITICAL' ? model.palette.high : model.palette.mid;
                rows.push([
                    tableCell(item.name, { bold: true, fill: index % 2 ? model.palette.altRow : model.palette.bg }),
                    tableCell(item.model, { fill: index % 2 ? model.palette.altRow : model.palette.bg }),
                    tableCell(item.severity, { bold: true, color: severityColor, fill: index % 2 ? model.palette.altRow : model.palette.bg }),
                    tableCell(item.finding_text, { fill: index % 2 ? model.palette.altRow : model.palette.bg })
                ]);
            });
            slide.addTable(rows, {
                x: MARGIN, y: 1.44, w: 12.05, h: 5.4,
                colW: [2.35, 1.65, 1.05, 7.0],
                rowH: 0.46, fontFace: FONT, fontSize: 10.5,
                color: pptColor(model.palette.text), margin: 0.07,
                border: { type: 'solid', color: pptColor(model.palette.grid), width: 0.6 },
                valign: 'middle', breakLine: false
            });
        }
        addNotes(slide, model, 'Findings calculated from the normalized System Health sensor rows using the report thresholds: elevated at 80%, at capacity at 100%.');
    });
}

function tableCell(text, options = {}) {
    const cellOptions = {};
    if (options.bold) cellOptions.bold = true;
    if (options.color) cellOptions.color = pptColor(options.color);
    if (options.fill) cellOptions.fill = pptColor(options.fill);
    if (options.fontSize) cellOptions.fontSize = options.fontSize;
    return { text: cleanText(text, 480), options: cellOptions };
}

function addChartSlides(model, assets) {
    model.charts.forEach(chart => {
        const suffix = chart.page_count > 1 ? ` · ${chart.page_number} of ${chart.page_count}` : '';
        const slide = addContentSlide(model, `${cleanText(chart.title, 120)}${suffix}`, cleanText(chart.subtitle, 220), assets);
        const frame = fitContain(
            finiteNumber(chart.pixel_width) || 1120,
            finiteNumber(chart.pixel_height) || 560,
            MARGIN, 1.35, 12.08, 5.56
        );
        if (chart.image_data) {
            slide.addImage({ data: chart.image_data, ...frame });
        } else {
            slide.addText('Chart image was unavailable during export.', {
                x: MARGIN, y: 3.1, w: 12.0, h: 0.5, fontFace: FONT, fontSize: 18,
                color: pptColor(model.palette.muted), align: 'center', margin: 0
            });
        }
        if (chart.caption) {
            slide.addText(cleanText(chart.caption, 260), {
                x: MARGIN, y: 6.87, w: 11.5, h: 0.18, fontFace: FONT, fontSize: 9,
                color: pptColor(model.palette.muted), margin: 0, fit: 'shrink'
            });
        }
        addNotes(slide, model, `PNG chart rendered from the normalized System Health rows for ${chart.model || 'the reported fleet'} using the active chart theme.`);
    });
}

function fitContain(sourceWidth, sourceHeight, x, y, width, height) {
    const sourceRatio = sourceWidth / sourceHeight;
    const frameRatio = width / height;
    if (sourceRatio > frameRatio) {
        const fittedHeight = width / sourceRatio;
        return { x, y: y + (height - fittedHeight) / 2, w: width, h: fittedHeight };
    }
    const fittedWidth = height * sourceRatio;
    return { x: x + (width - fittedWidth) / 2, y, w: fittedWidth, h: height };
}

function addRecommendationSlide(model, assets) {
    const slide = addContentSlide(model, 'Recommended next steps', 'Actions derived from the conditions observed in this report', assets);
    model.recommendations.forEach((recommendation, index) => {
        const y = 1.55 + index * 1.08;
        slide.addShape(model.pptx.ShapeType.ellipse, {
            x: 0.78, y, w: 0.48, h: 0.48,
            line: { color: pptColor(model.palette.low), transparency: 100 },
            fill: { color: pptColor(index === 0 ? model.palette.high : model.palette.low) }
        });
        slide.addText(String(index + 1), {
            x: 0.78, y: y + 0.07, w: 0.48, h: 0.2, fontFace: FONT, fontSize: 12,
            bold: true, color: 'FFFFFF', align: 'center', margin: 0
        });
        slide.addText(recommendation, {
            x: 1.55, y: y - 0.02, w: 10.9, h: 0.62, fontFace: FONT, fontSize: 16,
            color: pptColor(model.palette.text), margin: 0, breakLine: false, fit: 'shrink'
        });
    });
    addNotes(slide, model, 'Recommended actions are deterministic suggestions derived from the findings in this report and should be validated against deployment context.');
}

function addAppendixSlides(model, assets) {
    const ordered = [...model.rows].sort((a, b) => {
        const aRisk = Math.max(safeRatio(a.packetPeak, a.packetCapacity) || 0, safeRatio(a.throughputGbps, a.throughputCapacity) || 0, finiteNumber(a.triggerUtilization) || 0);
        const bRisk = Math.max(safeRatio(b.packetPeak, b.packetCapacity) || 0, safeRatio(b.throughputGbps, b.throughputCapacity) || 0, finiteNumber(b.triggerUtilization) || 0);
        return bRisk - aRisk || String(a.name || '').localeCompare(String(b.name || ''));
    });
    chunk(ordered, APPENDIX_ROWS_PER_SLIDE).forEach((items, pageIndex, pages) => {
        const suffix = pages.length > 1 ? ` · ${pageIndex + 1} of ${pages.length}` : '';
        const slide = addContentSlide(model, `Appendix · Sensor detail${suffix}`, 'Editable values from the same normalized rows used to render the charts', assets);
        const headers = ['Sensor', 'Model', 'Status', 'Packet peak', 'Throughput peak', 'Trigger', 'Drops', 'Advanced', 'Standard', 'Discovery'];
        const rows = [headers.map(text => tableCell(text, {
            bold: true, color: model.palette.bg, fill: model.palette.text, fontSize: 9.5
        }))];
        items.forEach((row, index) => {
            const fill = index % 2 ? model.palette.altRow : model.palette.bg;
            const analysis = row.analysis || {};
            rows.push([
                tableCell(row.name || row.hostname || row.id, { bold: true, fill }),
                tableCell(row.license_platform || (row.capacity && row.capacity.model) || 'Unknown', { fill }),
                tableCell(String(sensorStatus(row)).replace(/_/g, ' '), { fill }),
                tableCell(formatRate(row.packetPeak), { fill }),
                tableCell(formatGbps(row.throughputGbps), { fill }),
                tableCell(formatPercent(row.triggerUtilization), { fill }),
                tableCell(formatInteger(row.triggerDropsTotal), { fill }),
                tableCell(tierValue(analysis.advanced, row.advancedCapacity), { fill }),
                tableCell(tierValue(analysis.standard, row.standardCapacity), { fill }),
                tableCell(formatInteger(analysis.discovery), { fill })
            ]);
        });
        slide.addTable(rows, {
            x: 0.42, y: 1.38, w: 12.5, h: 5.46,
            colW: [1.75, 1.18, 1.15, 1.2, 1.25, 0.74, 0.62, 1.0, 1.0, 0.82],
            rowH: 0.43, fontFace: FONT, fontSize: 8.5,
            color: pptColor(model.palette.text), margin: 0.045,
            border: { type: 'solid', color: pptColor(model.palette.grid), width: 0.5 },
            valign: 'middle', breakLine: false
        });
        addNotes(slide, model, 'Editable appendix values projected from the normalized System Health rows; missing values are shown as em dashes.');
    });
}

function tierValue(value, capacity) {
    const used = finiteNumber(value);
    const cap = finiteNumber(capacity);
    if (used === null) return '—';
    return cap && cap > 0 ? `${formatInteger(used)} / ${formatInteger(cap)}` : formatInteger(used);
}

function createPresentation(deckModel, PptxGenJS, assets = {}) {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = deckModel.options.prepared_by || 'ExtraHop Admin Tools';
    pptx.company = 'ExtraHop';
    pptx.subject = 'System Health Review';
    pptx.title = deckModel.options.title;
    pptx.lang = 'en-US';
    pptx.theme = {
        headFontFace: FONT,
        bodyFontFace: FONT,
        lang: 'en-US'
    };
    const model = { ...deckModel, pptx, slideNumber: 0 };
    addCover(model, assets);
    addOverview(model, assets);
    addAttentionSlides(model, assets);
    addChartSlides(model, assets);
    addRecommendationSlide(model, assets);
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
