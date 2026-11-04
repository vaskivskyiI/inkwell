# Inkwell for Windows

A small native Windows app (C# / .NET 8 WinForms + Microsoft Edge WebView2, ~1.3 MB) that shows **your Inkwell
server** in its own window, set up for writing with a pen:

- No swipe-to-go-back and no zooming of the whole window by pinching: a sideways pen stroke stays a stroke, two
  fingers zoom the paper. Only the pen writes; the mouse and fingers move the paper until ✋ in the pen toolbar is on.
- Full screen over the whole monitor, taskbar hidden: **F11** for the whole app (F11 again to leave), or the page's
  *Full screen* button for the paper or the page (Esc to leave).
- Connect window: the server address, checked with `GET <server>/api/health` before it is saved
  (`%APPDATA%\Inkwell\windows\config.json`). A certificate from your own CA: **Add CA certificate…** there (accepted
  only for that server's host; or install the CA in Windows). The error page has **Change server**.
- One running copy; window size and position are remembered. The WebView2 profile (sign-in, the pages kept for
  offline use) is in `%LOCALAPPDATA%\Inkwell\windows\WebView2`.
- `inkwell:` links open a place in the app, e.g. `inkwell:#/new?do=hand` (a blank handwritten page with the pen
  ready), `inkwell:#/new?do=today` (today's journal), `inkwell:#/search`. Also `Inkwell.exe --route=#/…` — handy
  for pinned shortcuts.
- Right-click shows Inkwell's own menus (on the paper: cut, copy, paste handwriting; pages: open, print, …); in
  text and fields only the editing entries, none of the browser's (Back, Reload, Inspect…).
- Exports go to the Downloads folder; "Export as PDF" opens Windows' print dialog (Save as PDF); links to other
  sites open in the default browser.

The app always shows the current web app from your server, so a server upgrade needs no app update.

Requirements: Windows 10 1809+ or 11, the **.NET 8 Desktop Runtime** and the **WebView2 Runtime** (part of Windows 11;
the app offers the download when it is missing). `Inkwell.exe --unregister` removes the `inkwell:` link handler.

## Build

Needs the .NET 8 SDK (without admin rights it can go into any folder with
[dotnet-install.ps1](https://dot.net/v1/dotnet-install.ps1) `-Channel 8.0 -InstallDir <folder>`):

```powershell
dotnet publish windows/Inkwell/Inkwell.csproj -c Release -r win-x64 --self-contained false -o windows/Inkwell/bin/publish-x64
windows/Inkwell/bin/publish-x64/Inkwell.exe
```

`-r win-arm64` for ARM PCs. The icon comes from `web/public/icon-512.png`: `powershell -File windows/tools/make-icon.ps1`.
