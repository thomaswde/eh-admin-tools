// Applies the saved theme before first paint so the page never flashes.
// Kept separate from theme.js because it must run in <head>, before the body renders.
(function () {
    try {
        var pref = localStorage.getItem('eh-admin-theme') || 'system';
        var dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    } catch {
        // Storage or matchMedia unavailable (private mode, old browser). Light is the default.
    }
})();
