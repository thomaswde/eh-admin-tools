(function attachSystemHealthViewModel(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SystemHealthViewModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildSystemHealthViewModel() {
    'use strict';

    const PROCESSING_LOAD_GUIDE = 0.8;
    const PACKETSTORE_WARNING_DROP_RATIO = 0.001;
    const PACKETSTORE_CRITICAL_DROP_RATIO = 0.01;
    const PACKETSTORE_TIME_SERIES_METRICS = ['est_lookback_sec', 'input_load', 'compress_load', 'disk_write_load'];
    const PACKETSTORE_TOTAL_METRICS = [
        'pkts',
        'pkts_dropped',
        'pkts_dropped_wrslow',
        'secrets',
        'secrets_dropped',
        'if_drops',
        'blocks_dropped'
    ];
    const EXPECTED_SENSOR_METRICS = ['bytes', 'pkts', 'trigger_cycles', 'trigger_cycles_avail', 'trigger_drops'];
    const PACKETSTORE_LOSS_COUNTERS = [
        'packetDropsTotal',
        'slowWriteDropsTotal',
        'interfaceDropsTotal',
        'blocksDroppedTotal',
        'secretDropsTotal'
    ];

    function cleanText(value, maxLength = 240) {
        return String(value == null ? '' : value)
            .trim()
            .slice(0, maxLength);
    }

    function finiteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function safeRatio(value, capacity) {
        const numerator = finiteNumber(value);
        const denominator = finiteNumber(capacity);
        return numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : null;
    }

    function metricSummaryValue(report, metricName, field, id) {
        const metric = report && report.metrics && report.metrics[metricName];
        const values = metric && metric.summary && metric.summary[field];
        const value = values && values[String(id)];
        return value === undefined ? null : value;
    }

    function metricPeakRate(report, metricName, id) {
        const duration = metricSummaryValue(report, metricName, 'peak_duration_ms', id);
        const peak = metricSummaryValue(report, metricName, 'peak_values', id);
        return duration && peak !== null ? Number(peak) / (Number(duration) / 1000) : null;
    }

    function metricStatus(report, id) {
        const statuses = Object.fromEntries(EXPECTED_SENSOR_METRICS.map((name) => [name, 'unknown']));
        Object.entries((report && report.metrics) || {}).forEach(([metricName, metric]) => {
            statuses[metricName] =
                (metric.sensor_status && metric.sensor_status[String(id)] && metric.sensor_status[String(id)].status) ||
                'unknown';
        });
        return statuses;
    }

    function projectSensorRows(report = {}) {
        return (report.appliances || [])
            .filter((sensor) => sensor.appliance_role !== 'packetstore')
            .map((sensor) => {
                const id = String(sensor.id);
                const capacity = sensor.capacity || {};
                const analysis = (report.device_analysis && report.device_analysis[id]) || {
                    advanced: null,
                    standard: null,
                    discovery: null,
                    total: null,
                    status: 'empty'
                };
                const alignedTrigger =
                    report.trigger_utilization &&
                    report.trigger_utilization.peak_by_sensor &&
                    report.trigger_utilization.peak_by_sensor[id];
                const statuses = metricStatus(report, id);
                statuses.trigger_utilization = alignedTrigger
                    ? statuses.trigger_cycles === 'unknown'
                        ? 'complete'
                        : statuses.trigger_cycles
                    : (report.trigger_utilization &&
                          report.trigger_utilization.invalid_by_sensor &&
                          report.trigger_utilization.invalid_by_sensor[id]) ||
                      statuses.trigger_cycles ||
                      'empty';
                const byteDuration = metricSummaryValue(report, 'bytes', 'peak_duration_ms', id);
                const bytePeak = metricSummaryValue(report, 'bytes', 'peak_values', id);
                return {
                    ...sensor,
                    offline: !sensor.online,
                    collectionStatus: { ...statuses, device_analysis: analysis.status || 'unknown' },
                    analysis,
                    packetPeak: metricPeakRate(report, 'pkts', id),
                    packetCapacity: Number(capacity.base_packetrate || 0),
                    throughputGbps:
                        byteDuration && bytePeak !== null
                            ? (Number(bytePeak) * 8) / (Number(byteDuration) / 1000) / 1_000_000_000
                            : null,
                    throughputCapacity: Number(capacity.base_gbps || 0),
                    triggerCyclesPeak: alignedTrigger ? alignedTrigger.used_cycles : null,
                    triggerCyclesAvail: alignedTrigger ? alignedTrigger.available_cycles : null,
                    triggerUtilization: alignedTrigger ? alignedTrigger.utilization : null,
                    triggerPeakTimestampMs: alignedTrigger ? alignedTrigger.timestamp_ms : null,
                    triggerPeakDurationMs: alignedTrigger ? alignedTrigger.duration_ms : null,
                    triggerDropsPeak: null,
                    triggerDropsTotal: metricSummaryValue(report, 'trigger_drops', 'totals', id),
                    advancedCapacity: Number(capacity.advanced_analysis || 0),
                    standardCapacity: Number(capacity.standard_analysis || 0)
                };
            });
    }

    function packetstoreMetric(report, metricName) {
        return (
            (report && report.packetstore && report.packetstore.metrics && report.packetstore.metrics[metricName]) ||
            null
        );
    }

    function packetstoreSummaryValue(report, metricName, field, id) {
        const metric = packetstoreMetric(report, metricName);
        const values = metric && metric.summary && metric.summary[field];
        return values && values[String(id)] !== undefined ? values[String(id)] : null;
    }

    function projectPacketstoreRows(report = {}) {
        const ids = new Set(((report.packetstore && report.packetstore.appliance_ids) || []).map(String));
        return (report.appliances || [])
            .filter((appliance) => ids.has(String(appliance.id)))
            .map((appliance) => {
                const id = String(appliance.id);
                const total = (name) => packetstoreSummaryValue(report, name, 'totals', id);
                const peak = (name) => packetstoreSummaryValue(report, name, 'peak_values', id);
                const latest = (name) => packetstoreSummaryValue(report, name, 'latest_values', id);
                const minimum = (name) => packetstoreSummaryValue(report, name, 'min_values', id);
                const status = {};
                [...PACKETSTORE_TIME_SERIES_METRICS, ...PACKETSTORE_TOTAL_METRICS].forEach((name) => {
                    const metric = packetstoreMetric(report, name);
                    status[name] =
                        metric && metric.sensor_status && metric.sensor_status[id]
                            ? metric.sensor_status[id].status
                            : 'unknown';
                });
                const packets = total('pkts');
                const packetDrops = total('pkts_dropped');
                const secrets = total('secrets');
                const secretDrops = total('secrets_dropped');
                return {
                    ...appliance,
                    offline: !appliance.online,
                    collectionStatus: status,
                    lookbackLatestSec: latest('est_lookback_sec'),
                    lookbackMinSec: minimum('est_lookback_sec'),
                    packetsTotal: packets,
                    packetDropsTotal: packetDrops,
                    slowWriteDropsTotal: total('pkts_dropped_wrslow'),
                    interfaceDropsTotal: total('if_drops'),
                    blocksDroppedTotal: total('blocks_dropped'),
                    packetDropRatio:
                        packets !== null && packets > 0 && packetDrops !== null ? packetDrops / packets : null,
                    secretsTotal: secrets,
                    secretDropsTotal: secretDrops,
                    secretDropRatio:
                        secrets !== null && secrets > 0 && secretDrops !== null ? secretDrops / secrets : null,
                    inputLoadPeak: peak('input_load'),
                    compressionLoadPeak: peak('compress_load'),
                    diskWriteLoadPeak: peak('disk_write_load')
                };
            })
            .sort((a, b) => {
                const risk = (row) =>
                    Math.max(
                        row.packetDropRatio || 0,
                        row.secretDropRatio || 0,
                        (row.inputLoadPeak || 0) / 100,
                        (row.compressionLoadPeak || 0) / 100,
                        (row.diskWriteLoadPeak || 0) / 100
                    );
                return risk(b) - risk(a) || String(a.name || '').localeCompare(String(b.name || ''));
            });
    }

    function sensorStatus(row) {
        const states = Object.entries(row.collectionStatus || {})
            .filter(([key]) => key !== 'device_analysis' || supportsDeviceAnalysis(row))
            .map(([, state]) => state);
        const incomplete = states.find((state) => !['complete', 'zero_valued'].includes(state));
        if (incomplete) return incomplete;
        if (states.length && states.every((state) => state === 'zero_valued')) return 'zero_valued';
        return row.offline ? 'offline' : 'complete';
    }

    function isAbsent(row) {
        return !!row.offline || row.data_access === false;
    }

    function applianceModelLabel(row) {
        return (
            cleanText(row && (row.license_platform || (row.capacity && row.capacity.model) || row.platform), 80) ||
            'Unknown model'
        );
    }

    function applianceNameWithModel(row) {
        const name = cleanText(row && (row.name || row.hostname || row.id), 120) || 'Unknown sensor';
        return `${name} (${applianceModelLabel(row)})`;
    }

    function applianceRole(row) {
        const model = applianceModelLabel(row).replace(/\s+/g, '').toUpperCase();
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

    function severityRank(value) {
        return value === 'CRITICAL' ? 2 : value === 'WARNING' ? 1 : 0;
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

    function formatGbps(value) {
        const number = finiteNumber(value);
        return number === null ? '—' : `${number.toLocaleString(undefined, { maximumFractionDigits: 2 })} Gbps`;
    }

    function tierValue(value, capacity) {
        const used = finiteNumber(value);
        const cap = finiteNumber(capacity);
        if (used === null) return '—';
        return cap && cap > 0 ? `${formatInteger(used)} / ${formatInteger(cap)}` : formatInteger(used);
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

    function findingForRow(row) {
        const conditions = [];
        const add = (severity, label, detail) => {
            if (!label || conditions.some((item) => item.label === label)) return;
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
            ['Advanced analysis', advancedRatio, `${tierValue(analysis.advanced, row.advancedCapacity)} devices`],
            ['Standard analysis', standardRatio, `${tierValue(analysis.standard, row.standardCapacity)} devices`]
        ].forEach(([label, ratio, detail]) => {
            if (ratio === null) return;
            if (ratio >= 1) add('CRITICAL', `${label} full`, detail);
            else if (ratio >= PROCESSING_LOAD_GUIDE) add('WARNING', `${label} near capacity`, detail);
        });

        const drops = finiteNumber(row.triggerDropsTotal);
        if (drops !== null && drops > 0) {
            const load =
                triggerRatio === null ? '' : `trigger load reached ${formatPercent(triggerRatio)} of available cycles`;
            add('CRITICAL', 'Trigger drops', [`${formatInteger(drops)} drops`, load].filter(Boolean).join('; '));
        }
        [
            [
                'Packet rate',
                packetRatio,
                formatCompact(row.packetPeak, ' p/s'),
                formatCompact(row.packetCapacity, ' p/s')
            ],
            ['Throughput', throughputRatio, formatGbps(row.throughputGbps), formatGbps(row.throughputCapacity)],
            ['Trigger load', triggerRatio, formatCompact(row.triggerCyclesPeak), formatCompact(row.triggerCyclesAvail)]
        ].forEach(([label, ratio, used, capacity]) => {
            if (ratio === null) return;
            const detail = `${used} of ${capacity}; ${formatPercent(ratio)} of capacity`;
            if (ratio >= 1) add('CRITICAL', `${label} at capacity`, detail);
            else if (ratio >= PROCESSING_LOAD_GUIDE) add('WARNING', `High ${label.toLowerCase()}`, detail);
        });

        const discovery = finiteNumber(analysis.discovery);
        if (discovery !== null && discovery > 0) {
            add('WARNING', 'Devices in Discovery', `${formatInteger(discovery)} not assigned to an analysis tier`);
        }
        (row.health_conditions || []).forEach((condition) => {
            if (condition && condition.type === 'offline' && row.offline) return;
            if (condition && condition.type === 'data_access' && row.data_access === false) return;
            const message = cleanText(condition && condition.message, 160);
            if (!message) return;
            add(
                condition.status === 'failed' ? 'CRITICAL' : 'WARNING',
                conditionLabel(condition),
                sentenceCase(message)
            );
        });

        const collection = row.collectionStatus || {};
        const collectionLabels = {
            pkts: 'packet rate',
            bytes: 'throughput',
            trigger_utilization: 'trigger utilization',
            trigger_drops: 'trigger drops',
            device_analysis: 'device analysis'
        };
        const gaps = Object.entries(collectionLabels)
            .filter(([key]) => {
                if (key === 'device_analysis' && !supportsDeviceAnalysis(row)) return false;
                const status = collection[key];
                return status && !['complete', 'zero_valued'].includes(status);
            })
            .map(([, label]) => label);
        if (gaps.length) add('WARNING', 'Incomplete collection', `No data returned for ${joinList(gaps)}`);

        const severity = conditions.some((item) => item.severity === 'CRITICAL')
            ? 'CRITICAL'
            : conditions.length
              ? 'WARNING'
              : 'OK';
        const ordered = conditions.slice().sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
        const primary = ordered[0] || null;
        const others = ordered.slice(1);
        const evidence = primary
            ? [
                  primary.detail,
                  others.length
                      ? `Other conditions: ${others
                            .slice(0, 2)
                            .map((item) => item.label.toLowerCase())
                            .join(', ')}` + (others.length > 2 ? ` +${others.length - 2} more` : '')
                      : ''
              ]
                  .filter(Boolean)
                  .join('. ')
            : '';
        const findings = ordered.map((item) => [item.label, item.detail].filter(Boolean).join(': '));
        const ratios = [packetRatio, throughputRatio, triggerRatio, advancedRatio, standardRatio];
        return {
            id: String(row.id || ''),
            name: cleanText(row.name || row.hostname || row.id || 'Unknown sensor', 120),
            model: cleanText(row.license_platform || (row.capacity && row.capacity.model) || 'Unknown', 80),
            severity,
            condition: primary ? primary.label : '',
            evidence,
            findings,
            finding_text: findings.join('; '),
            worst_ratio: Math.max(...ratios.filter((value) => value !== null), 0),
            at_capacity: ratios.some((ratio) => ratio !== null && ratio >= 1),
            absent: isAbsent(row),
            row
        };
    }

    function recommendationPriority(recommendation, overview = {}) {
        const text = String(recommendation || '');
        if (/capture loss/i.test(text)) return overview.packetstore_loss_severity === 'critical' ? 2 : 1;
        if (/restore(?: appliance)? connectivity|data access|trigger drops/i.test(text)) return 2;
        if (
            /at or above 80%|processing load|capacity pressure|analysis assignments|licensed capacity|license|synchronization|loss-counter collection/i.test(
                text
            )
        )
            return 1;
        return 0;
    }

    function recommendationsFromFindings(findings, overview = {}) {
        const recommendations = [];
        const has = (pattern) => findings.some((item) => pattern.test(item.finding_text));
        if (overview.absent) {
            const noun = overview.absent === 1 ? 'sensor' : 'sensors';
            recommendations.push(
                `Restore connectivity or data access for the ${formatInteger(overview.absent)} ${noun} that returned no data, then rerun the report.`
            );
        }
        if (overview.packetstores_with_loss) {
            recommendations.push(
                `Investigate capture loss on ${formatInteger(overview.packetstores_with_loss)} of ${formatInteger(overview.packetstores)} Packetstore sources. Compare offered load with rated capture throughput, then review slow-write, interface, block-drop, and disk-write metrics.`
            );
        }
        if (has(/trigger drops/i))
            recommendations.push(
                'Review trigger drops first. Check trigger load and trigger execution during the report window.'
            );
        if (has(/packet rate|throughput|trigger load/i)) {
            recommendations.push(
                'Review sensors at or above 80% of packet rate, throughput, or trigger capacity. Confirm that appliance sizing allows for expected traffic growth.'
            );
        }
        if (!overview.packetstores_with_loss && overview.packetstores_loaded) {
            const noun = overview.packetstores_loaded === 1 ? 'Packetstore source' : 'Packetstore sources';
            recommendations.push(
                `Review processing load on ${formatInteger(overview.packetstores_loaded)} ${noun} at or above ${formatPercent(PROCESSING_LOAD_GUIDE)} before adding capture traffic or increasing retention.`
            );
        }
        if (overview.packetstores_loss_unavailable) {
            const noun = overview.packetstores_loss_unavailable === 1 ? 'source' : 'sources';
            recommendations.push(
                `Restore Packetstore loss-counter collection for ${formatInteger(overview.packetstores_loss_unavailable)} ${noun}, then rerun the report before concluding that capture was lossless.`
            );
        }
        if (has(/advanced analysis|standard analysis|Discovery/i)) {
            recommendations.push(
                'Reassign devices or increase licensed analysis capacity before moving more devices into Advanced or Standard Analysis.'
            );
        }
        if (!overview.absent && has(/incomplete collection|data access/i)) {
            recommendations.push('Restore appliance connectivity and data access, then rerun the report.');
        }
        if (has(/license|synchronization/i)) {
            recommendations.push(
                'Resolve license or synchronization warnings before using the report for capacity decisions.'
            );
        }
        if (!recommendations.length) {
            recommendations.push(
                'Use the same report window and aggregation cycle for future reports so the results are comparable.'
            );
        }
        return recommendations
            .map((recommendation, index) => ({
                recommendation,
                index,
                priority: recommendationPriority(recommendation, overview)
            }))
            .sort((a, b) => b.priority - a.priority || a.index - b.index)
            .slice(0, 5)
            .map((item) => item.recommendation);
    }

    function isStandalonePacketstoreSource(row) {
        return String((row && row.appliance_role) || '') === 'packetstore';
    }

    function packetstoreModelLabel(row) {
        return applianceModelLabel(row);
    }

    function hasCaptureLoss(row) {
        return PACKETSTORE_LOSS_COUNTERS.some((key) => {
            const value = finiteNumber(row && row[key]);
            return value !== null && value > 0;
        });
    }

    function packetstoreLossStatus(row) {
        if (hasCaptureLoss(row)) return 'loss';
        return PACKETSTORE_LOSS_COUNTERS.every((key) => finiteNumber(row && row[key]) !== null)
            ? 'clean'
            : 'unavailable';
    }

    function packetstoreDropSeverity(ratio, droppedTotal = 0) {
        const value = finiteNumber(ratio);
        if (value !== null && value > PACKETSTORE_CRITICAL_DROP_RATIO) return 'critical';
        if (value !== null) return value >= PACKETSTORE_WARNING_DROP_RATIO ? 'warning' : 'clean';
        // A positive counter without an offered-total denominator cannot be
        // compared with the percentage threshold, so keep it visible.
        if ((finiteNumber(droppedTotal) || 0) > 0) return 'warning';
        return 'clean';
    }

    function packetstoreLossSeverity(row) {
        const packet = packetstoreDropSeverity(row && row.packetDropRatio, row && row.packetDropsTotal);
        const secret = packetstoreDropSeverity(row && row.secretDropRatio, row && row.secretDropsTotal);
        if (packet === 'critical' || secret === 'critical') return 'critical';
        if (
            packet === 'warning' ||
            secret === 'warning' ||
            (finiteNumber(row && row.slowWriteDropsTotal) || 0) > 0 ||
            (finiteNumber(row && row.interfaceDropsTotal) || 0) > 0 ||
            (finiteNumber(row && row.blocksDroppedTotal) || 0) > 0
        )
            return 'warning';
        return packetstoreLossStatus(row) === 'unavailable' ? 'unavailable' : 'clean';
    }

    function peakProcessingLoad(row) {
        const loads = [row.inputLoadPeak, row.compressionLoadPeak, row.diskWriteLoadPeak]
            .map(finiteNumber)
            .filter((value) => value !== null);
        return loads.length ? Math.max(...loads) / 100 : null;
    }

    function hasProcessingPressure(row) {
        const load = peakProcessingLoad(row);
        return load !== null && load >= PROCESSING_LOAD_GUIDE;
    }

    function isPacketstoreRowHighlighted(row) {
        const lossSeverity = packetstoreLossSeverity(row);
        return ['warning', 'critical'].includes(lossSeverity) || hasProcessingPressure(row);
    }

    function hasReportedPacketstoreLookback(row) {
        if (!row || row.offline) return false;
        const value = finiteNumber(row.lookbackLatestSec);
        if (value === null || value < 0) return false;
        const status = row.collectionStatus && row.collectionStatus.est_lookback_sec;
        return value > 0 || ['complete', 'zero_valued'].includes(status);
    }

    function averagePacketstoreLookback(rows) {
        const sources = rows || [];
        const measured = sources.filter(hasReportedPacketstoreLookback);
        return {
            average_seconds: measured.length
                ? measured.reduce((sum, row) => sum + finiteNumber(row.lookbackLatestSec), 0) / measured.length
                : null,
            reporting_sources: measured.length,
            total_sources: sources.length
        };
    }

    function packetstoreVerdictClause(overview) {
        if (!overview.packetstores) return '';
        if (overview.packetstores_with_loss) {
            const loss = `${formatInteger(overview.packetstores_with_loss)} of ${formatInteger(overview.packetstores)} Packetstore sources reported capture loss.`;
            return overview.packetstores_loss_unavailable
                ? `${loss} Capture-loss status was unavailable for ${formatInteger(overview.packetstores_loss_unavailable)} additional ${overview.packetstores_loss_unavailable === 1 ? 'source' : 'sources'}.`
                : loss;
        }
        if (overview.packetstores_loss_unavailable) {
            if (!overview.packetstores_loss_reporting) {
                return `Capture-loss status was unavailable for all ${formatInteger(overview.packetstores)} Packetstore sources.`;
            }
            return `No capture loss was reported by the ${formatInteger(overview.packetstores_clean)} Packetstore ${overview.packetstores_clean === 1 ? 'source' : 'sources'} with conclusive counters. Capture-loss status was unavailable for ${formatInteger(overview.packetstores_loss_unavailable)} ${overview.packetstores_loss_unavailable === 1 ? 'source' : 'sources'}.`;
        }
        if (overview.packetstores_loaded) {
            return (
                `${formatInteger(overview.packetstores_loaded)} Packetstore ` +
                `${overview.packetstores_loaded === 1 ? 'source' : 'sources'} reached at least ` +
                `${formatPercent(PROCESSING_LOAD_GUIDE)} processing load. No capture loss was reported.`
            );
        }
        if (overview.packetstores === 1) return 'The Packetstore source reported no capture loss.';
        return `No capture loss was reported by any of the ${formatInteger(overview.packetstores)} Packetstore sources.`;
    }

    function verdictFor(overview) {
        const packetstores = packetstoreVerdictClause(overview);
        if (!overview.sensors) {
            const none = 'No sensors were returned for this report window.';
            return packetstores ? `${none} ${packetstores}` : none;
        }
        const absentShare = overview.absent / overview.sensors;
        let sensorVerdict;
        if (absentShare >= 0.5) {
            sensorVerdict = `${formatInteger(overview.absent)} of ${formatInteger(overview.sensors)} sensors returned no data. Resolve connectivity or data-access issues before evaluating capacity.`;
        } else if (overview.at_capacity) {
            sensorVerdict = `${formatInteger(overview.at_capacity)} ${overview.at_capacity === 1 ? 'sensor is' : 'sensors are'} at or over a capacity limit and should be addressed before further devices are assigned.`;
        } else if (overview.attention) {
            sensorVerdict = `${formatInteger(overview.attention)} of ${formatInteger(overview.reporting)} reporting sensors need review. No sensor reached a capacity limit.`;
        } else if (overview.absent) {
            sensorVerdict = `All ${formatInteger(overview.reporting)} reporting sensors are within capacity. ${formatInteger(overview.absent)} returned no data.`;
        } else {
            sensorVerdict = `All ${formatInteger(overview.sensors)} sensors are reporting and within capacity thresholds.`;
        }
        return [sensorVerdict, packetstores].filter(Boolean).join(' ');
    }

    function buildNarrativeModel(input = {}) {
        const rows = Array.isArray(input.rows) ? input.rows.map((row) => ({ ...row })) : [];
        const packetstoreRows = Array.isArray(input.packetstore_rows)
            ? input.packetstore_rows.map((row) => ({ ...row }))
            : [];
        const allFindings = rows.map(findingForRow);
        const absent = allFindings.filter((item) => item.absent);
        const findings = allFindings
            .filter((item) => !item.absent && item.severity !== 'OK')
            .sort(
                (a, b) =>
                    severityRank(b.severity) - severityRank(a.severity) ||
                    b.worst_ratio - a.worst_ratio ||
                    a.name.localeCompare(b.name)
            );
        const modelCounts = {};
        rows.forEach((row) => {
            const model = cleanText(row.license_platform || (row.capacity && row.capacity.model) || 'Unknown', 80);
            modelCounts[model] = (modelCounts[model] || 0) + 1;
        });
        const retention = averagePacketstoreLookback(packetstoreRows);
        const lossSeverities = packetstoreRows.map(packetstoreLossSeverity);
        const lossStatuses = packetstoreRows.map(packetstoreLossStatus);
        const triggerDropRows = rows.filter((row) => finiteNumber(row.triggerDropsTotal) !== null);
        const overview = {
            sensors: rows.length,
            reporting: rows.length - absent.length,
            healthy: Math.max(0, rows.length - absent.length - findings.length),
            offline: rows.filter((row) => row.offline).length,
            no_access: rows.filter((row) => !row.offline && row.data_access === false).length,
            absent: absent.length,
            attention: findings.length,
            at_capacity: findings.filter((item) => item.at_capacity).length,
            trigger_drops: triggerDropRows.length
                ? triggerDropRows.reduce((sum, row) => sum + Math.max(0, finiteNumber(row.triggerDropsTotal)), 0)
                : null,
            trigger_drops_reporting: triggerDropRows.length,
            trigger_drops_unavailable: rows.length - triggerDropRows.length,
            packetstores: packetstoreRows.length,
            packetstores_all_in_one: packetstoreRows.filter((row) => row.appliance_role === 'all_in_one').length,
            packetstores_standalone: packetstoreRows.filter(isStandalonePacketstoreSource).length,
            packetstores_with_loss: packetstoreRows.filter(hasCaptureLoss).length,
            packetstores_clean: lossStatuses.filter((status) => status === 'clean').length,
            packetstores_loss_reporting: lossStatuses.filter((status) => status !== 'unavailable').length,
            packetstores_loss_unavailable: lossStatuses.filter((status) => status === 'unavailable').length,
            packetstores_with_critical_loss: lossSeverities.filter((level) => level === 'critical').length,
            packetstore_loss_severity: lossSeverities.includes('critical')
                ? 'critical'
                : lossSeverities.includes('warning')
                  ? 'warning'
                  : lossSeverities.includes('unavailable')
                    ? 'unavailable'
                    : 'clean',
            packetstores_loaded: packetstoreRows.filter(hasProcessingPressure).length,
            packetstore_lookback_average_sec: retention.average_seconds,
            packetstore_lookback_reporting_sources: retention.reporting_sources,
            model_counts: Object.entries(modelCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        };
        return {
            rows,
            packetstore_rows: packetstoreRows,
            findings,
            absent,
            overview,
            verdict: verdictFor(overview),
            recommendations: recommendationsFromFindings(findings, overview)
        };
    }

    function buildReportViewModel(report = {}) {
        const rows = projectSensorRows(report);
        const packetstoreRows = projectPacketstoreRows(report);
        return buildNarrativeModel({ rows, packetstore_rows: packetstoreRows });
    }

    function rendererCycleLabel(metrics, fallback) {
        const cycles = new Set();
        Object.values(metrics || {}).forEach((metric) => {
            Object.values((metric && metric.summary && metric.summary.actual_cycles) || {})
                .filter(Boolean)
                .forEach((cycle) => cycles.add(String(cycle)));
            ((metric && metric.collection_metadata) || []).forEach((item) => {
                if (item && item.cycle) cycles.add(String(item.cycle));
            });
        });
        return cycles.size ? [...cycles].sort().join('/') : String(fallback || 'unknown-cycle');
    }

    function rendererHealthConditions(row) {
        return ((row && row.health_conditions) || []).slice(0, 64).map((condition) => ({
            type: cleanText(condition && condition.type, 40),
            status: cleanText(condition && condition.status, 40),
            message: cleanText(condition && condition.message, 160)
        }));
    }

    function rendererCollectionStatus(statuses) {
        return Object.fromEntries(
            Object.entries(statuses || {})
                .slice(0, 32)
                .map(([name, status]) => [cleanText(name, 64), cleanText(status || 'unknown', 64)])
        );
    }

    function rendererAnalysisSummary(analysis = {}) {
        return {
            advanced: finiteNumber(analysis.advanced),
            standard: finiteNumber(analysis.standard),
            discovery: finiteNumber(analysis.discovery),
            total: finiteNumber(analysis.total),
            status: cleanText(analysis.status || 'unknown', 64)
        };
    }

    function rendererSensorSummary(row) {
        return {
            id: String(row.id),
            name: cleanText(row.name || row.hostname || row.id || 'Unknown sensor', 120),
            model: applianceModelLabel(row),
            online: !row.offline,
            dataAccess: row.data_access === undefined ? null : row.data_access !== false,
            applianceRole: applianceRole(row),
            collectionStatus: rendererCollectionStatus(row.collectionStatus),
            analysis: rendererAnalysisSummary(row.analysis),
            packetPeak: finiteNumber(row.packetPeak),
            packetCapacity: finiteNumber(row.packetCapacity),
            throughputGbps: finiteNumber(row.throughputGbps),
            throughputCapacity: finiteNumber(row.throughputCapacity),
            triggerCyclesPeak: finiteNumber(row.triggerCyclesPeak),
            triggerCyclesAvail: finiteNumber(row.triggerCyclesAvail),
            triggerUtilization: finiteNumber(row.triggerUtilization),
            triggerPeakTimestampMs: finiteNumber(row.triggerPeakTimestampMs),
            triggerPeakDurationMs: finiteNumber(row.triggerPeakDurationMs),
            triggerDropsTotal: finiteNumber(row.triggerDropsTotal),
            advancedCapacity: finiteNumber(row.advancedCapacity),
            standardCapacity: finiteNumber(row.standardCapacity),
            healthConditions: rendererHealthConditions(row)
        };
    }

    function rendererPacketstoreSummary(row) {
        return {
            id: String(row.id),
            name: cleanText(row.name || row.hostname || row.id || 'Unknown Packetstore', 120),
            model: packetstoreModelLabel(row),
            online: !row.offline,
            applianceRole: cleanText(row.appliance_role || 'packetstore', 40),
            collectionStatus: rendererCollectionStatus(row.collectionStatus),
            lookbackLatestSec: finiteNumber(row.lookbackLatestSec),
            lookbackMinSec: finiteNumber(row.lookbackMinSec),
            packetsTotal: finiteNumber(row.packetsTotal),
            packetDropsTotal: finiteNumber(row.packetDropsTotal),
            packetDropRatio: finiteNumber(row.packetDropRatio),
            slowWriteDropsTotal: finiteNumber(row.slowWriteDropsTotal),
            interfaceDropsTotal: finiteNumber(row.interfaceDropsTotal),
            blocksDroppedTotal: finiteNumber(row.blocksDroppedTotal),
            secretsTotal: finiteNumber(row.secretsTotal),
            secretDropsTotal: finiteNumber(row.secretDropsTotal),
            secretDropRatio: finiteNumber(row.secretDropRatio),
            inputLoadPeak: finiteNumber(row.inputLoadPeak),
            compressionLoadPeak: finiteNumber(row.compressionLoadPeak),
            diskWriteLoadPeak: finiteNumber(row.diskWriteLoadPeak)
        };
    }

    function buildRendererProjection(report = {}) {
        const model = buildReportViewModel(report);
        const stripFindingRow = (finding) => {
            const summary = { ...finding };
            delete summary.row;
            return summary;
        };
        const target = report.target || {};
        const window = report.window || {};
        const cyclePolicy = report.cycle_policy || null;
        return {
            schema_version: '1',
            metadata: {
                generated_at: cleanText(report.generated_at, 64),
                target: {
                    type: cleanText(target.type, 40),
                    tenant: cleanText(target.tenant, 120),
                    host: cleanText(target.host, 240),
                    name: cleanText(target.name, 120)
                },
                window: {
                    lookback_days: finiteNumber(window.lookback_days),
                    from_ms: finiteNumber(window.from_ms),
                    until_ms: finiteNumber(window.until_ms),
                    from_iso: cleanText(window.from_iso, 64),
                    until_iso: cleanText(window.until_iso, 64)
                },
                requested_cycle: cleanText(report.requested_cycle, 40),
                cycle: cleanText(report.cycle, 40),
                cycle_label: rendererCycleLabel(report.metrics, report.cycle || report.requested_cycle),
                packetstore_cycle_label: rendererCycleLabel(
                    report.packetstore && report.packetstore.metrics,
                    report.cycle || report.requested_cycle
                ),
                cycle_policy: cyclePolicy
                    ? {
                          requested_cycle: cleanText(cyclePolicy.requested_cycle, 40),
                          query_cycle: cleanText(cyclePolicy.query_cycle, 40),
                          minimum_safe_cycle: cleanText(cyclePolicy.minimum_safe_cycle, 40),
                          estimated_buckets_per_sensor: finiteNumber(cyclePolicy.estimated_buckets_per_sensor),
                          estimated_scalar_points: finiteNumber(cyclePolicy.estimated_scalar_points),
                          adjusted: cyclePolicy.adjusted === true,
                          policy: cleanText(cyclePolicy.policy, 80)
                      }
                    : null,
                capacity_catalog_loaded: report.capacity_catalog_loaded === true,
                errors: (report.errors || []).slice(0, 1000).map((error) => cleanText(error, 500))
            },
            sensor_summaries: model.rows.map(rendererSensorSummary),
            packetstore_summaries: model.packetstore_rows.map(rendererPacketstoreSummary),
            findings: model.findings.map(stripFindingRow),
            absent: model.absent.map(stripFindingRow),
            overview: {
                ...model.overview,
                model_counts: model.overview.model_counts.map(([modelName, count]) => ({
                    model: modelName,
                    count
                }))
            },
            verdict: model.verdict,
            recommendations: model.recommendations
        };
    }

    return {
        PROCESSING_LOAD_GUIDE,
        PACKETSTORE_WARNING_DROP_RATIO,
        PACKETSTORE_CRITICAL_DROP_RATIO,
        PACKETSTORE_TIME_SERIES_METRICS,
        PACKETSTORE_TOTAL_METRICS,
        cleanText,
        finiteNumber,
        safeRatio,
        projectSensorRows,
        packetstoreMetric,
        packetstoreSummaryValue,
        projectPacketstoreRows,
        sensorStatus,
        isAbsent,
        applianceRole,
        applianceModelLabel,
        applianceNameWithModel,
        supportsDeviceAnalysis,
        joinList,
        severityRank,
        findingForRow,
        recommendationPriority,
        recommendationsFromFindings,
        isStandalonePacketstoreSource,
        packetstoreModelLabel,
        hasCaptureLoss,
        packetstoreLossStatus,
        packetstoreDropSeverity,
        packetstoreLossSeverity,
        peakProcessingLoad,
        hasProcessingPressure,
        isPacketstoreRowHighlighted,
        hasReportedPacketstoreLookback,
        averagePacketstoreLookback,
        verdictFor,
        buildNarrativeModel,
        buildReportViewModel,
        buildRendererProjection,
        rendererSensorSummary,
        rendererPacketstoreSummary
    };
});
