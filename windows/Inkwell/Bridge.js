// Injected by the Windows app (MainForm.Bridge) into the server's pages before they run: window.inkwellNative tells
// the web app it runs inside the app (no "Install app" offer) and lets it open the server window.
(() => {
  const ORIGIN = __ORIGIN__;
  const wv = window.chrome && window.chrome.webview;
  if (!wv || window.top !== window || location.origin !== ORIGIN) return;
  window.inkwellNative = Object.freeze({
    platform: 'windows',
    version: __VERSION__,
    changeServer: () => wv.postMessage({ type: 'changeServer' }),
  });
})();
