/* exported ApplianceManagement */

const ApplianceManagement = (() => {
    const TERMINAL_SUCCESS = new Set(['DONE']);
    const TERMINAL_FAILURE = new Set(['ERROR', 'FAILED', 'CANCELLED', 'CANCELED']);

    function emptyFirmwareState(status, error = null) {
        return { status, versions: [], error };
    }

    function buildFirmwareAvailability(appliances, releases, error = null) {
        const availability = {};
        for (const appliance of appliances || []) {
            const id = String(appliance.id);
            availability[id] = id === '0'
                ? emptyFirmwareState('not-applicable')
                : emptyFirmwareState(error ? 'failed' : 'no-upgrade', error);
        }
        if (error) return availability;

        for (const release of Array.isArray(releases) ? releases : []) {
            const releaseName = String(release?.release || '');
            for (const candidate of Array.isArray(release?.versions) ? release.versions : []) {
                const version = String(candidate?.version || '').trim();
                if (!version) continue;
                for (const systemId of Array.isArray(candidate?.system_ids) ? candidate.system_ids : []) {
                    const id = String(systemId);
                    if (!availability[id] || id === '0') continue;
                    const entry = availability[id];
                    if (!entry.versions.some(item => item.version === version)) {
                        entry.versions.push({ release: releaseName, version });
                    }
                    entry.status = 'available';
                }
            }
        }
        return availability;
    }

    function mergeSingleFirmwareAvailability(availability, applianceId, releases, error = null) {
        const id = String(applianceId);
        const single = buildFirmwareAvailability([{ id }], releases, error);
        return { ...availability, [id]: single[id] };
    }

    function mergeLocalFirmwareAvailability(availability, releases, error = null) {
        const local = emptyFirmwareState(error ? 'failed' : 'no-upgrade', error);
        if (!error) {
            for (const release of Array.isArray(releases) ? releases : []) {
                const releaseName = String(release?.release || '');
                for (const candidate of Array.isArray(release?.versions) ? release.versions : []) {
                    const version = String(candidate || '').trim();
                    if (!version || local.versions.some(item => item.version === version)) continue;
                    local.versions.push({ release: releaseName, version });
                    local.status = 'available';
                }
            }
        }
        return { ...availability, '0': local };
    }

    function isConsoleInventory(appliances) {
        return (appliances || []).some(appliance =>
            String(appliance.id) === '0' && String(appliance.platform || '').toLowerCase() === 'command'
        );
    }

    function maskProductKey(value) {
        const text = String(value || '');
        if (!text) return '';
        const visible = text.slice(-4);
        return `${'•'.repeat(Math.max(4, Math.min(12, text.length - visible.length)))}${visible}`;
    }

    function normalizeProductKeys(response) {
        const items = Array.isArray(response) ? response : [response];
        return items
            .map(item => typeof item === 'string' ? item : item?.product_key)
            .map(value => String(value || '').trim())
            .filter(Boolean);
    }

    function isSafeJobLocation(location) {
        return /^\/api\/v1\/jobs\/[A-Za-z0-9._~-]+$/.test(String(location || ''));
    }

    function classifyFirmwareJob(job) {
        const status = String(job?.status || '').toUpperCase();
        const remoteStatuses = (Array.isArray(job?.remote_jobs) ? job.remote_jobs : [])
            .map(item => String(item?.status || '').toUpperCase())
            .filter(Boolean);
        if (TERMINAL_FAILURE.has(status) || remoteStatuses.some(item => TERMINAL_FAILURE.has(item))) {
            return 'failed';
        }
        if (
            TERMINAL_SUCCESS.has(status)
            && remoteStatuses.every(item => TERMINAL_SUCCESS.has(item))
        ) {
            return 'done';
        }
        return null;
    }

    function summarizeRemoteJobs(job) {
        return (Array.isArray(job?.remote_jobs) ? job.remote_jobs : [])
            .map(item => {
                const status = item?.status || 'Unknown';
                const step = String(item?.step_description || '').trim();
                const details = String(item?.details || '').trim();
                const messages = [step, details].filter((value, index, values) =>
                    value && values.indexOf(value) === index
                );
                return `${status}${messages.length ? ` — ${messages.join(' — ')}` : ''}`;
            })
            .join('; ');
    }

    function waitForPoll(milliseconds, signal) {
        return new Promise((resolve, reject) => {
            let timeoutId = null;
            const cleanup = () => signal?.removeEventListener('abort', abort);
            const finish = () => {
                cleanup();
                resolve();
            };
            const abort = () => {
                clearTimeout(timeoutId);
                cleanup();
                const error = signal.reason || new Error('The firmware job poll was cancelled.');
                if (!error.name || error.name === 'Error') error.name = 'AbortError';
                reject(error);
            };
            timeoutId = setTimeout(finish, milliseconds);
            if (signal?.aborted) {
                abort();
            } else if (signal) {
                signal.addEventListener('abort', abort, { once: true });
            }
        });
    }

    async function pollFirmwareJob({
        fetchJob,
        location,
        signal,
        onUpdate = () => {},
        intervalMs = 15_000,
        deadlineMs = 60 * 60 * 1000,
        now = () => Date.now(),
        wait = waitForPoll
    }) {
        if (!isSafeJobLocation(location)) {
            throw new TypeError('The firmware job location is invalid.');
        }
        const deadline = now() + deadlineMs;
        let lastJob = null;
        while (now() < deadline) {
            if (signal?.aborted) {
                const error = signal.reason || new Error('The firmware job poll was cancelled.');
                if (!error.name || error.name === 'Error') error.name = 'AbortError';
                throw error;
            }
            lastJob = await fetchJob(location, { signal });
            onUpdate(lastJob);
            const terminalState = classifyFirmwareJob(lastJob);
            if (terminalState) return { state: terminalState, job: lastJob };
            if (now() >= deadline) break;
            await wait(Math.min(intervalMs, Math.max(0, deadline - now())), signal);
        }
        return { state: 'timed-out', job: lastJob };
    }

    return Object.freeze({
        buildFirmwareAvailability,
        mergeSingleFirmwareAvailability,
        mergeLocalFirmwareAvailability,
        isConsoleInventory,
        maskProductKey,
        normalizeProductKeys,
        isSafeJobLocation,
        classifyFirmwareJob,
        summarizeRemoteJobs,
        pollFirmwareJob
    });
})();

if (typeof window !== 'undefined') window.ApplianceManagement = ApplianceManagement;
