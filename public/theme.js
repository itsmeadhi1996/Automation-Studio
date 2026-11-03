/* Shared preference, applied before the page paints. */
(() => {
  const STORAGE_KEY = 'studio-theme';
  const root = document.documentElement;
  const BULB_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path class="bulb-glass" d="M8.5 16c0-2-3-3.2-3-6.5a6.5 6.5 0 0 1 13 0c0 3.3-3 4.5-3 6.5Z"/>' +
    '<path d="M9 19h6m-5 3h4M12 16v-5m-2-1 2 1 2-1"/>' +
    '<path class="bulb-rays" d="M12 0v1M3 3l1 1m16-1-1 1M0 10h2m20 0h2M2 17l2-1m16 0 2 1"/>' +
    '</svg>';

  const normalize = (value) => (value === 'dark' ? 'dark' : 'light');

  let theme = 'light';
  try {
    theme = normalize(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage may be disabled; the default theme still works.
  }

  const toggleTitle = () =>
    theme === 'dark'
      ? 'Dark mode (bulb off). Switch to normal mode.'
      : 'Normal mode (bulb on). Switch to dark mode.';

  function apply(value) {
    theme = normalize(value);
    root.dataset.theme = theme;
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.innerHTML = BULB_ICON;
      button.setAttribute('aria-pressed', String(theme === 'dark'));
      button.title = toggleTitle();
    });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#121a18' : '#f6f8f7';
  }

  window.StudioTheme = {
    button: () =>
      `<button type="button" class="theme-toggle" data-theme-toggle aria-label="Dark mode" ` +
      `aria-pressed="${theme === 'dark'}" title="${toggleTitle()}">${BULB_ICON}</button>`,
  };

  apply(theme);
  document.addEventListener('DOMContentLoaded', () => apply(theme));

  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-theme-toggle]')) return;
    apply(theme === 'dark' ? 'light' : 'dark');
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Toggling still works for this page.
    }
  });

  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) apply(event.newValue);
  });
})();
