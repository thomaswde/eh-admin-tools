// Theme control: light, dark, or follow the operating system.
// The initial value is applied by js/theme-init.js before first paint.

const THEME_KEY = 'eh-admin-theme';
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');

function getThemePref() {
    try {
        return localStorage.getItem(THEME_KEY) || 'system';
    } catch (error) {
        return 'system';
    }
}

function resolveTheme(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return themeMedia.matches ? 'dark' : 'light';
}

function applyTheme(pref) {
    document.documentElement.setAttribute('data-theme', resolveTheme(pref));
    document.querySelectorAll('#themeSeg .seg-btn').forEach(button => {
        button.classList.toggle('active', button.dataset.value === pref);
    });
}

function setTheme(pref) {
    try {
        localStorage.setItem(THEME_KEY, pref);
    } catch (error) {
        // Preference will not survive a reload, but the current session still updates.
    }
    applyTheme(pref);
}

function initTheme() {
    document.querySelectorAll('#themeSeg .seg-btn').forEach(button => {
        button.addEventListener('click', () => setTheme(button.dataset.value));
    });

    themeMedia.addEventListener('change', () => {
        if (getThemePref() === 'system') applyTheme('system');
    });

    applyTheme(getThemePref());
}
