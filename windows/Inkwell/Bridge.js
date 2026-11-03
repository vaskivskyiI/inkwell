// Injected by the Windows app (MainForm.Bridge) into the server's pages before they run: window.inkwellNative tells
// the web app it runs inside the app (no "Install app" offer) and lets it open the server window. F11 makes the whole
// app full screen (over the taskbar), as in a browser.
(() => {
  const ORIGIN = __ORIGIN__;
  const wv = window.chrome && window.chrome.webview;
  if (!wv || window.top !== window || location.origin !== ORIGIN) return;
  window.inkwellNative = Object.freeze({
    platform: 'windows',
    version: __VERSION__,
    changeServer: () => wv.postMessage({ type: 'changeServer' }),
    toggleFullScreen: () => wv.postMessage({ type: 'fullscreen' }),
  });
  addEventListener('keydown', (e) => {
    if (e.key !== 'F11' || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    wv.postMessage({ type: 'fullscreen' });
  }, true);
})();
