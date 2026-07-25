// Chart Theme
//
// Charts in this app are built to be exported as PNGs and dropped into slide
// decks, so their colors have to be controllable independently of the app UI.
//
// A theme is five colors: a background, a text color, and a three-step ramp
// (low / elevated / at-capacity). Everything else a chart needs -- gridlines,
// bar tracks, muted labels, alternating row tint -- is mixed from the
// background and text at render time. That keeps a theme readable at any
// background hue and keeps the editor down to five controls.
//
// Built-in themes ship with the app. Custom themes are JSON files the backend
// writes to <install>/chart-themes/, so they survive an upgrade and can be
// copied between installs.

(() => {

if (
    typeof window.initChartThemePanel === 'function'
    && typeof window.chartThemeResolvedColors === 'function'
) {
    return;
}

const CHART_THEME_STORAGE_KEY = 'ehChartTheme';
const CHART_THEME_AUTO_ID = 'auto';
const CHART_THEME_DRAFT_ID = 'draft';
const CHART_THEME_API = '/backend/chart-themes';

// Order matters: this is the order the editor renders its controls.
const CHART_THEME_SLOTS = [
    { key: 'bg', label: 'Background', hint: 'Canvas fill behind the chart' },
    { key: 'text', label: 'Text', hint: 'Sensor names and values' },
    { key: 'low', label: 'Low', hint: 'Below 80% of capacity' },
    { key: 'mid', label: 'Elevated', hint: '80% to 100% of capacity' },
    { key: 'high', label: 'At capacity', hint: 'At or above 100%' }
];

const CHART_THEME_BUILTINS = [
    {
        id: 'light',
        name: 'Light',
        colors: { bg: '#ffffff', text: '#261f63', low: '#00aaef', mid: '#f05918', high: '#ec0089' }
    },
    {
        // Sapphire is a brand color, not a canvas. At full strength behind a
        // whole chart it saturates everything drawn on top, so the background
        // is Sapphire darkened ~78% and the ramp is muted to match: cyan for
        // normal load, bronze for elevated, plum for at-capacity. Every ramp
        // color clears 4.5:1 against the background.
        id: 'dark',
        name: 'Dark',
        colors: { bg: '#131127', text: '#f1eff8', low: '#4fa9d4', mid: '#c1996b', high: '#ce78a6' }
    },
    {
        id: 'midnight',
        name: 'Midnight',
        colors: { bg: '#12131a', text: '#f2f3f7', low: '#38bdf8', mid: '#fbbf24', high: '#f43f5e' }
    },
    {
        id: 'slate',
        name: 'Slate',
        colors: { bg: '#f7f8fb', text: '#1f2937', low: '#3b82f6', mid: '#f59e0b', high: '#dc2626' }
    },
    {
        // Ramp runs light to dark so severity survives a grayscale handout.
        id: 'mono',
        name: 'Monochrome',
        colors: { bg: '#ffffff', text: '#111827', low: '#c9ccd3', mid: '#7b8190', high: '#111827' }
    }
];

// Weights used to mix each derived color between the theme background (0) and
// the theme text color (1). Tuned against the built-in light and dark themes.
const CHART_THEME_DERIVED = {
    subtle: 0.82,
    muted: 0.64,
    grid: 0.16,
    track: 0.10,
    altRow: 0.045
};

const chartThemeState = {
    initialized: false,
    selected: CHART_THEME_AUTO_ID,
    transparent: false,
    draft: null,
    saved: [],
    directory: '',
    writable: false,
    onChange: null,
    naming: false
};

/* ------------------------------ color math ------------------------------ */

// Accepts "#abc", "abc", "#aabbcc", "aabbcc". Returns null when unparseable so
// callers can fall back rather than render an invalid canvas color.
function chartThemeParseHex(value) {
    const raw = String(value == null ? '' : value).trim().replace(/^#/, '');
    const expanded = raw.length === 3 ? raw.split('').map(char => char + char).join('') : raw;
    if (!/^[0-9a-f]{6}$/i.test(expanded)) return null;
    const int = parseInt(expanded, 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function chartThemeHex(value, fallback) {
    const rgb = chartThemeParseHex(value);
    return rgb ? chartThemeToHex(rgb) : fallback;
}

function chartThemeToHex({ r, g, b }) {
    const channel = value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
    return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function chartThemeMix(fromHex, toHex, weight) {
    const from = chartThemeParseHex(fromHex) || { r: 255, g: 255, b: 255 };
    const to = chartThemeParseHex(toHex) || { r: 0, g: 0, b: 0 };
    return chartThemeToHex({
        r: from.r + (to.r - from.r) * weight,
        g: from.g + (to.g - from.g) * weight,
        b: from.b + (to.b - from.b) * weight
    });
}

/* ------------------------------ theme model ----------------------------- */

function chartThemeDefaultColors() {
    return { ...CHART_THEME_BUILTINS[0].colors };
}

function chartThemeNormalizeColors(raw) {
    const fallback = chartThemeDefaultColors();
    const colors = {};
    CHART_THEME_SLOTS.forEach(slot => {
        colors[slot.key] = chartThemeHex(raw && raw[slot.key], fallback[slot.key]);
    });
    return colors;
}

// The app's light/dark preference, so a freshly opened report matches the UI.
function chartThemeAutoId() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function chartThemeAll() {
    return [...CHART_THEME_BUILTINS, ...chartThemeState.saved];
}

function chartThemeById(id) {
    return chartThemeAll().find(theme => theme.id === id) || null;
}

// The colors currently in the editor, whichever source they came from.
function chartThemeActiveColors() {
    if (chartThemeState.selected === CHART_THEME_DRAFT_ID && chartThemeState.draft) {
        return chartThemeNormalizeColors(chartThemeState.draft);
    }
    const id = chartThemeState.selected === CHART_THEME_AUTO_ID
        ? chartThemeAutoId()
        : chartThemeState.selected;
    const theme = chartThemeById(id) || CHART_THEME_BUILTINS[0];
    return chartThemeNormalizeColors(theme.colors);
}

// The full palette a chart renderer consumes.
function chartThemeResolvedColors() {
    const colors = chartThemeActiveColors();
    const derived = {};
    Object.entries(CHART_THEME_DERIVED).forEach(([key, weight]) => {
        derived[key] = chartThemeMix(colors.bg, colors.text, weight);
    });
    return { ...colors, ...derived, transparent: chartThemeState.transparent };
}

/* -------------------------------- storage ------------------------------- */

function chartThemeLoadSelection() {
    try {
        const raw = JSON.parse(localStorage.getItem(CHART_THEME_STORAGE_KEY) || 'null');
        if (!raw || typeof raw !== 'object') return;
        if (typeof raw.selected === 'string') chartThemeState.selected = raw.selected;
        chartThemeState.transparent = !!raw.transparent;
        chartThemeState.draft = raw.draft ? chartThemeNormalizeColors(raw.draft) : null;
        if (chartThemeState.selected === CHART_THEME_DRAFT_ID && !chartThemeState.draft) {
            chartThemeState.selected = CHART_THEME_AUTO_ID;
        }
    } catch {
        // Unparseable or unavailable storage just means the defaults apply.
    }
}

function chartThemePersistSelection() {
    try {
        localStorage.setItem(CHART_THEME_STORAGE_KEY, JSON.stringify({
            selected: chartThemeState.selected,
            transparent: chartThemeState.transparent,
            draft: chartThemeState.draft
        }));
    } catch {
        // Preference will not survive a reload; the session still works.
    }
}

async function chartThemeFetchSaved() {
    try {
        const response = await fetch(CHART_THEME_API, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok) throw new Error(chartThemeErrorMessage(payload, response.status));
        chartThemeState.saved = (payload.themes || []).map(theme => ({
            id: theme.id,
            name: theme.name,
            colors: chartThemeNormalizeColors(theme.colors)
        }));
        chartThemeState.directory = payload.directory || '';
        chartThemeState.writable = !!payload.writable;
    } catch (error) {
        chartThemeState.saved = [];
        chartThemeState.writable = false;
        chartThemeSetStatus(`Saved themes unavailable: ${error.message}`, true);
    }
}

async function chartThemeSave(name) {
    const id = chartThemeUniqueId(name);
    const body = { name: name.trim(), colors: chartThemeActiveColors() };
    const response = await fetch(`${CHART_THEME_API}/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(chartThemeErrorMessage(payload, response.status));
    await chartThemeFetchSaved();
    chartThemeState.selected = payload.id;
    chartThemeState.draft = null;
    chartThemePersistSelection();
    return payload;
}

async function chartThemeDelete(id) {
    const response = await fetch(`${CHART_THEME_API}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
        let payload = null;
        try { payload = await response.json(); } catch {}
        throw new Error(chartThemeErrorMessage(payload, response.status));
    }
    await chartThemeFetchSaved();
    if (chartThemeState.selected === id) chartThemeState.selected = CHART_THEME_AUTO_ID;
    chartThemePersistSelection();
}

function chartThemeErrorMessage(payload, status) {
    const detail = payload && payload.detail;
    if (detail && typeof detail === 'object' && detail.message) return detail.message;
    if (typeof detail === 'string') return detail;
    if (payload && payload.message) return payload.message;
    return `Request failed with HTTP ${status}`;
}

function chartThemeSlug(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'theme';
}

// Built-in ids are reserved, and re-saving a name should not silently replace a
// different theme, so collisions get a numeric suffix.
function chartThemeUniqueId(name) {
    const base = chartThemeSlug(name);
    const taken = new Set(chartThemeAll().map(theme => theme.id));
    const existing = chartThemeState.saved.find(theme => theme.name.toLowerCase() === name.trim().toLowerCase());
    if (existing) return existing.id;
    if (!taken.has(base)) return base;
    for (let suffix = 2; suffix < 100; suffix += 1) {
        const candidate = `${base}-${suffix}`;
        if (!taken.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
}

/* ------------------------------- panel UI ------------------------------- */

function initChartThemePanel(options = {}) {
    if (chartThemeState.initialized) return;
    const panel = document.getElementById('chartThemePanel');
    if (!panel) return;
    chartThemeState.initialized = true;
    chartThemeState.onChange = typeof options.onChange === 'function' ? options.onChange : null;

    chartThemeLoadSelection();

    panel.addEventListener('click', chartThemeHandleClick);
    panel.addEventListener('input', chartThemeHandleInput);
    panel.addEventListener('change', chartThemeHandleInput);
    panel.addEventListener('submit', chartThemeHandleSubmit);

    // Keep "Auto" honest when the user flips the app between light and dark.
    new MutationObserver(() => {
        if (chartThemeState.selected !== CHART_THEME_AUTO_ID) return;
        chartThemeRenderPanel();
        chartThemeNotify();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    chartThemeRenderPanel();
    chartThemeFetchSaved().then(chartThemeRenderPanel);
}

function chartThemeNotify() {
    if (chartThemeState.onChange) chartThemeState.onChange();
}

function chartThemeCommit() {
    chartThemePersistSelection();
    chartThemeRenderPanel();
    chartThemeNotify();
}

function chartThemeHandleClick(event) {
    const card = event.target.closest('[data-chart-theme-select]');
    if (card) {
        chartThemeState.selected = card.dataset.chartThemeSelect;
        chartThemeState.naming = false;
        chartThemeCommit();
        return;
    }

    const action = event.target.closest('[data-chart-theme-action]');
    if (!action) return;
    const name = action.dataset.chartThemeAction;

    if (name === 'save') {
        chartThemeState.naming = true;
        chartThemeRenderPanel();
        document.getElementById('chartThemeNameInput')?.focus();
    } else if (name === 'cancel-save') {
        chartThemeState.naming = false;
        chartThemeRenderPanel();
    } else if (name === 'reset') {
        chartThemeState.selected = CHART_THEME_AUTO_ID;
        chartThemeState.transparent = false;
        chartThemeState.draft = null;
        chartThemeState.naming = false;
        chartThemeSetStatus('');
        chartThemeCommit();
    } else if (name === 'delete') {
        chartThemeDelete(action.dataset.chartThemeId)
            .then(() => {
                chartThemeSetStatus('Theme deleted.');
                chartThemeCommit();
            })
            .catch(error => chartThemeSetStatus(`Could not delete theme: ${error.message}`, true));
    }
}

function chartThemeHandleInput(event) {
    const target = event.target;

    if (target.id === 'chartThemeTransparent') {
        chartThemeState.transparent = target.checked;
        chartThemePersistSelection();
        chartThemeNotify();
        chartThemeRenderHint();
        return;
    }

    const slot = target.dataset ? target.dataset.chartThemeSlot : null;
    if (!slot) return;

    // A hex field only takes effect once it parses, so partial typing is safe.
    const parsed = chartThemeParseHex(target.value);
    if (!parsed) {
        target.classList.toggle('is-invalid', target.value.trim() !== '');
        return;
    }
    target.classList.remove('is-invalid');

    const colors = chartThemeActiveColors();
    colors[slot] = chartThemeToHex(parsed);
    chartThemeState.draft = colors;
    chartThemeState.selected = CHART_THEME_DRAFT_ID;
    chartThemePersistSelection();
    chartThemeSyncSlotInputs(slot, colors[slot]);
    chartThemeRenderCards();
    chartThemeRenderHint();
    chartThemeRenderActions();
    chartThemeNotify();
}

function chartThemeHandleSubmit(event) {
    if (event.target.id !== 'chartThemeNameForm') return;
    event.preventDefault();
    const input = document.getElementById('chartThemeNameInput');
    const name = (input?.value || '').trim();
    if (!name) {
        chartThemeSetStatus('Give the theme a name before saving.', true);
        return;
    }
    chartThemeSave(name)
        .then(theme => {
            chartThemeState.naming = false;
            chartThemeSetStatus(`Saved "${theme.name}" to ${chartThemeState.directory || 'the themes folder'}.`);
            chartThemeCommit();
        })
        .catch(error => chartThemeSetStatus(`Could not save theme: ${error.message}`, true));
}

// Keeps the swatch and the hex field for one slot in step without a full
// re-render, so the color input keeps focus while the user drags.
function chartThemeSyncSlotInputs(slot, value) {
    document.querySelectorAll(`[data-chart-theme-slot="${slot}"]`).forEach(input => {
        if (input.value.toLowerCase() !== value.toLowerCase()) input.value = value;
    });
}

function chartThemeRenderPanel() {
    chartThemeRenderCards();
    chartThemeRenderEditor();
    chartThemeRenderActions();
    chartThemeRenderHint();
}

function chartThemeRenderCards() {
    const list = document.getElementById('chartThemeList');
    if (!list) return;

    const entries = [{ id: CHART_THEME_AUTO_ID, name: 'Auto', colors: chartThemeNormalizeColors(chartThemeById(chartThemeAutoId()).colors), auto: true }]
        .concat(CHART_THEME_BUILTINS)
        .concat(chartThemeState.saved.map(theme => ({ ...theme, custom: true })));

    if (chartThemeState.selected === CHART_THEME_DRAFT_ID) {
        entries.push({ id: CHART_THEME_DRAFT_ID, name: 'Unsaved', colors: chartThemeActiveColors(), draft: true });
    }

    list.innerHTML = entries.map(entry => {
        const active = entry.id === chartThemeState.selected ? ' is-active' : '';
        const note = entry.auto ? 'Matches app theme' : entry.draft ? 'Not saved yet' : entry.custom ? 'Custom' : 'Built in';
        return `
            <button type="button" class="theme-card${active}" data-chart-theme-select="${chartThemeEscape(entry.id)}">
                <span class="theme-card-preview" style="background:${entry.colors.bg}">
                    <span class="theme-card-bar" style="background:${entry.colors.low}"></span>
                    <span class="theme-card-bar" style="background:${entry.colors.mid}"></span>
                    <span class="theme-card-bar" style="background:${entry.colors.high}"></span>
                    <span class="theme-card-ink" style="background:${entry.colors.text}"></span>
                </span>
                <span class="theme-card-name">${chartThemeEscape(entry.name)}</span>
                <span class="theme-card-note">${note}</span>
            </button>`;
    }).join('');
}

function chartThemeRenderEditor() {
    const editor = document.getElementById('chartThemeEditor');
    if (!editor) return;
    const colors = chartThemeActiveColors();
    editor.innerHTML = CHART_THEME_SLOTS.map(slot => `
        <div class="theme-slot">
            <label class="theme-slot-label" for="chartThemeHex-${slot.key}">${slot.label}</label>
            <div class="theme-slot-controls">
                <input class="theme-swatch" type="color" aria-label="${slot.label} color picker"
                       data-chart-theme-slot="${slot.key}" value="${colors[slot.key]}">
                <input class="theme-hex" id="chartThemeHex-${slot.key}" type="text" spellcheck="false"
                       inputmode="text" maxlength="7" aria-label="${slot.label} hex value"
                       data-chart-theme-slot="${slot.key}" value="${colors[slot.key]}">
            </div>
            <p class="theme-slot-hint">${slot.hint}</p>
        </div>`).join('');
}

function chartThemeRenderActions() {
    const actions = document.getElementById('chartThemeActions');
    if (!actions) return;
    const selectedSaved = chartThemeState.saved.find(theme => theme.id === chartThemeState.selected);

    const naming = chartThemeState.naming
        ? `<form class="theme-name-form" id="chartThemeNameForm">
               <input id="chartThemeNameInput" type="text" maxlength="60" placeholder="Theme name"
                      value="${chartThemeEscape(selectedSaved ? selectedSaved.name : '')}">
               <button type="submit" class="btn-primary btn-sm">Save</button>
               <button type="button" class="btn-ghost btn-sm" data-chart-theme-action="cancel-save">Cancel</button>
           </form>`
        : `<button type="button" class="btn btn-sm" data-chart-theme-action="save"${chartThemeState.writable ? '' : ' disabled'}>Save as theme…</button>`;

    actions.innerHTML = `
        <label class="check">
            <input id="chartThemeTransparent" type="checkbox"${chartThemeState.transparent ? ' checked' : ''}>
            <span>Transparent PNG background</span>
        </label>
        <div class="theme-actions-buttons">
            ${naming}
            ${selectedSaved ? `<button type="button" class="btn-danger btn-sm" data-chart-theme-action="delete" data-chart-theme-id="${chartThemeEscape(selectedSaved.id)}">Delete</button>` : ''}
            <button type="button" class="btn-ghost btn-sm" data-chart-theme-action="reset">Reset</button>
        </div>`;
}

function chartThemeRenderHint() {
    const hint = document.getElementById('chartThemeHint');
    if (!hint) return;
    const theme = chartThemeState.selected === CHART_THEME_DRAFT_ID
        ? { name: 'Unsaved custom' }
        : chartThemeState.selected === CHART_THEME_AUTO_ID
            ? { name: `Auto · ${chartThemeById(chartThemeAutoId()).name}` }
            : chartThemeById(chartThemeState.selected) || { name: 'Light' };
    hint.textContent = chartThemeState.transparent ? `${theme.name} · transparent PNG` : theme.name;
}

function chartThemeSetStatus(message, isError = false) {
    const status = document.getElementById('chartThemeStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', !!isError && !!message);
}

function chartThemeEscape(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

// This file is loaded as a dependency before the dynamically injected System
// Health report. Export the small public surface explicitly instead of relying
// on browser-specific handling of top-level function declarations.
window.initChartThemePanel = initChartThemePanel;
window.chartThemeResolvedColors = chartThemeResolvedColors;

})();
