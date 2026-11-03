using System.Text.Json;
using System.Text.Json.Nodes;
using System.Web;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Inkwell;

/// <summary>The user's Inkwell server in WebView2, set up for writing with a pen: no swipe-to-go-back and no page
/// zoom by pinching (the paper zooms itself), files saved to Downloads, other sites in the default browser.
/// Start menu shortcuts and inkwell: links open a place in the app (#/new?do=hand …). The page sees
/// window.inkwellNative (Bridge.js).</summary>
public sealed class MainForm : Form
{
    const string Home = "#/";
    readonly Config config;
    readonly WebView2 web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.White };
    CoreWebView2Environment? env;
    string? scriptId;
    string startRoute;
    string? startUrl;
    bool pageOk;
    // Signing in with Halcyon (/api/auth/halcyon/start): its sign-in pages show in this window until the server takes
    // over again, so the session lands in this window's profile (not in the browser or Halcyon's app).
    bool signingIn;

    string Server => config.Server;
    string Origin => Config.Origin(config.Server);

    public MainForm(Config config, string[] args)
    {
        this.config = config;
        startRoute = RouteOf(args) ?? Home;
        startUrl = LinkOf(args);
        Text = "Inkwell";
        Icon = Icons.App;
        MinimumSize = new Size(380, 500);
        AutoScaleMode = AutoScaleMode.Dpi;
        Size = new Size(1300, 900);
        StartPosition = FormStartPosition.CenterScreen;
        if (config.Bounds is { Length: 4 } b)
        {
            var r = new Rectangle(b[0], b[1], Math.Max(b[2], 380), Math.Max(b[3], 500));
            if (Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(r))) { StartPosition = FormStartPosition.Manual; Bounds = r; }
        }
        if (config.Maximized) WindowState = FormWindowState.Maximized;
        Controls.Add(web);
        ResizeEnd += (_, _) => KeepBounds();
        Resize += (_, _) => { if (WindowState != FormWindowState.Minimized) config.Maximized = WindowState == FormWindowState.Maximized; };
        HandleCreated += async (_, _) => await Init();
    }

    void KeepBounds()
    {
        if (WindowState != FormWindowState.Normal) return;
        config.Bounds = new[] { Bounds.X, Bounds.Y, Bounds.Width, Bounds.Height };
        Save();
    }

    void Save() { try { config.Save(); } catch (Exception e) { Log.Write("config: " + e.Message); } }

    async Task Init()
    {
        try
        {
            env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Config.LocalDir, "WebView2"));
            await web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            if (MessageBox.Show("Inkwell needs the Microsoft Edge WebView2 Runtime, which is part of Windows 11 and most Windows 10 PCs. Open the download page?", "Inkwell", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                Shell.Open("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            Close();
            return;
        }
        var core = web.CoreWebView2;
        core.Settings.UserAgent += $" InkwellWindows/{Version}";
        core.Settings.IsStatusBarEnabled = false;
        // A pen stroke sideways must not go back a page, and two fingers zoom the paper, not the whole window.
        core.Settings.IsSwipeNavigationEnabled = false;
        core.Settings.IsPinchZoomEnabled = false;
        core.DocumentTitleChanged += (_, _) => { Text = string.IsNullOrEmpty(core.DocumentTitle) ? "Inkwell" : core.DocumentTitle; };
        core.WebMessageReceived += (_, e) => Message(e);
        core.NavigationStarting += (_, e) =>
        {
            var u = e.Uri;
            if (Ours(u)) { signingIn = Uri.TryCreate(u, UriKind.Absolute, out var p) && p.AbsolutePath.StartsWith("/api/auth/"); pageOk = false; return; }
            if (u.StartsWith("about:") || u.StartsWith("data:")) { pageOk = false; return; }
            if (signingIn && (u.StartsWith("https:") || u.StartsWith("http:"))) { pageOk = false; return; }
            // The window only ever shows the server; everything else opens in the default browser.
            e.Cancel = true;
            if (u.StartsWith("http:") || u.StartsWith("https:")) Shell.OpenLink(u);
        };
        core.NavigationCompleted += (_, e) =>
        {
            var src = core.Source;
            if (e.IsSuccess) { pageOk = Ours(src); return; }
            if (e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled || !Ours(src)) return;
            pageOk = false;
            Problem(e.WebErrorStatus is CoreWebView2WebErrorStatus.CertificateIsInvalid or CoreWebView2WebErrorStatus.CertificateCommonNameIsIncorrect or CoreWebView2WebErrorStatus.CertificateExpired
                ? $"The certificate of {new Uri(Server).Host} is not trusted by this PC. If it comes from your own CA, add that CA certificate (Change server → Add CA certificate) or install it in Windows."
                : $"{Server} cannot be reached{(e.WebErrorStatus == CoreWebView2WebErrorStatus.Unknown ? "" : $" ({e.WebErrorStatus})")}. Check the network or VPN, or whether the server is running.");
        };
        Wire(core);
        await Inject();
        core.Navigate(startUrl ?? $"{Server}/{startRoute}");
    }

    static string Version => Application.ProductVersion.Split('+')[0];

    /// <summary>What the main window and its pop-ups share: links, downloads, certificates.</summary>
    void Wire(CoreWebView2 core)
    {
        core.NewWindowRequested += (_, e) => NewWindow(core, e);
        core.DownloadStarting += (_, e) =>
        {
            var downloads = Shell.Downloads;
            Directory.CreateDirectory(downloads);
            e.ResultFilePath = Shell.FreeName(downloads, Path.GetFileName(e.ResultFilePath));
        };
        core.ServerCertificateErrorDetected += (_, e) =>
        {
            try
            {
                if (Trust.Accepts(e.ServerCertificate.ToX509Certificate2(), new Uri(e.RequestUri).Host, Server)) e.Action = CoreWebView2ServerCertificateErrorAction.AlwaysAllow;
            }
            catch (Exception x) { Log.Write("certificate: " + x.Message); }
        };
    }

    /// <summary>window.open / target=_blank: the server's files download, its pages get a window of this app (a page
    /// to print as PDF, a public link), other sites open in the browser.</summary>
    async void NewWindow(CoreWebView2 from, CoreWebView2NewWindowRequestedEventArgs e)
    {
        var u = e.Uri;
        var file = Ours(u) && Uri.TryCreate(u, UriKind.Absolute, out var uri) && uri.AbsolutePath.StartsWith("/api/") && !u.Contains("format=pdf") && !uri.AbsolutePath.StartsWith("/api/public/");
        if (file)
        {
            e.Handled = true;
            _ = from.ExecuteScriptAsync($"(() => {{ const a = document.createElement('a'); a.href = {JsonSerializer.Serialize(u)}; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }})()");
            return;
        }
        if (Ours(u) || u.Length == 0 || u.StartsWith("about:blank"))
        {
            var deferral = e.GetDeferral();
            try
            {
                var popup = new PopupForm(e.WindowFeatures);
                popup.Show(this);
                await popup.Web.EnsureCoreWebView2Async(env);
                var core = popup.Web.CoreWebView2;
                core.Settings.UserAgent = web.CoreWebView2.Settings.UserAgent;
                core.Settings.IsSwipeNavigationEnabled = false;
                Wire(core);
                if (scriptId != null) await core.AddScriptToExecuteOnDocumentCreatedAsync(Bridge());
                e.NewWindow = core;
                e.Handled = true;
            }
            catch (Exception x) { Log.Write("popup: " + x.Message); }
            finally { deferral.Complete(); }
            return;
        }
        e.Handled = true;
        if (u.StartsWith("http:") || u.StartsWith("https:")) Shell.OpenLink(u);
    }

    async Task Inject()
    {
        var core = web.CoreWebView2;
        if (scriptId != null) core.RemoveScriptToExecuteOnDocumentCreated(scriptId);
        scriptId = await core.AddScriptToExecuteOnDocumentCreatedAsync(Bridge());
    }

    string Bridge()
    {
        using var s = typeof(MainForm).Assembly.GetManifestResourceStream("Bridge.js")!;
        using var r = new StreamReader(s);
        return r.ReadToEnd().Replace("__ORIGIN__", JsonSerializer.Serialize(Origin)).Replace("__VERSION__", JsonSerializer.Serialize(Version));
    }

    bool Ours(string url) => Origin.Length > 0 && Config.Origin(url).Equals(Origin, StringComparison.OrdinalIgnoreCase);

    /// <summary>From Bridge.js (only on the server's pages) and from the error page (retry / change server).</summary>
    void Message(CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonNode? m;
        try { m = JsonNode.Parse(e.WebMessageAsJson); } catch { return; }
        var type = (string?)m?["type"];
        var local = e.Source.StartsWith("about:") || e.Source.StartsWith("data:");
        if (!local && !Ours(e.Source)) return;
        if (type == "retry" && local) web.CoreWebView2.Navigate($"{Server}/{Home}");
        if (type == "changeServer") ChangeServer();
    }

    /// <summary>A second start of the app (Start menu shortcut, inkwell: link) handed its arguments over.</summary>
    public void Arrive(string[] args)
    {
        var link = Array.IndexOf(args, "--link") is var i and >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        if (link != null && !Ours(link))
        {
            // Not this server's: Halcyon handed it over because it is not Halcyon's either.
            if (link.StartsWith("http:") || link.StartsWith("https:")) Shell.Open(link);
            return;
        }
        Shell.Front(this);
        if (link != null) { if (web.CoreWebView2 == null) startUrl = link; else web.CoreWebView2.Navigate(link); return; }
        var r = RouteOf(args);
        if (r != null) Go(r);
    }

    /// <summary>"--link url" from Halcyon on the first start: only a page of the server is opened here.</summary>
    string? LinkOf(string[] args)
    {
        var i = Array.IndexOf(args, "--link");
        return i >= 0 && i + 1 < args.Length && Ours(args[i + 1]) ? args[i + 1] : null;
    }

    /// <summary>"inkwell:#/new?do=hand", "inkwell://#/…" or "--route=#/…" → "#/new?do=hand". Only places inside the
    /// web app: any program may start this.</summary>
    static string? RouteOf(string[] args)
    {
        foreach (var a in args)
        {
            var s = a.StartsWith("--route=") ? a[8..] : a.StartsWith(Shell.Protocol + ":", StringComparison.OrdinalIgnoreCase) ? a[(Shell.Protocol.Length + 1)..].TrimStart('/') : null;
            if (s == null) continue;
            s = HttpUtility.UrlDecode(s);
            return s.StartsWith("#/") ? s : Home;
        }
        return null;
    }

    /// <summary>Moves the running page to a route; a page that is not loaded (yet) is loaded there.</summary>
    void Go(string route)
    {
        if (web.CoreWebView2 == null) { startRoute = route; return; }
        if (pageOk) web.CoreWebView2.ExecuteScriptAsync($"location.hash = {JsonSerializer.Serialize(route)}");
        else web.CoreWebView2.Navigate($"{Server}/{route}");
    }

    void Problem(string text)
    {
        var esc = HttpUtility.HtmlEncode(text);
        web.CoreWebView2.NavigateToString($$"""
            <!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
            <body style="font-family:'Segoe UI',system-ui,sans-serif;padding:40px 32px;max-width:640px">
            <h2 style="margin:0 0 10px">Inkwell</h2><p style="line-height:1.5">{{esc}}</p>
            <button onclick="chrome.webview.postMessage({type:'retry'})" style="height:36px;padding:0 18px;border:0;border-radius:8px;background:#2563EB;color:#fff;font-weight:600;cursor:pointer">Try again</button>
            <button onclick="chrome.webview.postMessage({type:'changeServer'})" style="height:36px;padding:0 14px;border:0;background:none;color:#2563EB;font-weight:600;cursor:pointer">Change server</button>
            </body>
            """);
    }

    void ChangeServer()
    {
        Shell.Front(this);
        using var f = new ConnectForm(Server, null);
        if (f.ShowDialog(this) != DialogResult.OK) return;
        config.Server = f.Server;
        Save();
        Shell.Announce(Server);
        if (web.CoreWebView2 == null) return;
        _ = Inject().ContinueWith(_ => BeginInvoke(() => web.CoreWebView2.Navigate($"{Server}/{Home}")));
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        KeepBounds();
        base.OnFormClosing(e);
    }
}

/// <summary>A window the page opened (print preview, a public page, a sign-in pop-up).</summary>
public sealed class PopupForm : Form
{
    public readonly WebView2 Web = new() { Dock = DockStyle.Fill };

    public PopupForm(CoreWebView2WindowFeatures f)
    {
        Text = "Inkwell";
        Icon = Icons.App;
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.CenterParent;
        Size = f.HasSize ? new Size((int)Math.Max(f.Width, 400), (int)Math.Max(f.Height, 300) + 40) : new Size(1000, 800);
        Controls.Add(Web);
        Web.CoreWebView2InitializationCompleted += (_, e) =>
        {
            if (!e.IsSuccess) return;
            Web.CoreWebView2.DocumentTitleChanged += (_, _) => Text = string.IsNullOrEmpty(Web.CoreWebView2.DocumentTitle) ? "Inkwell" : Web.CoreWebView2.DocumentTitle;
            Web.CoreWebView2.WindowCloseRequested += (_, _) => Close();
        };
    }
}

static class Icons
{
    public static readonly Icon App = Load();
    static Icon Load()
    {
        using var s = typeof(Icons).Assembly.GetManifestResourceStream("inkwell.ico");
        return s != null ? new Icon(s) : SystemIcons.Application;
    }
}

static class Log
{
    public static void Write(string line)
    {
        try
        {
            Directory.CreateDirectory(Config.LocalDir);
            var file = Path.Combine(Config.LocalDir, "inkwell.log");
            if (File.Exists(file) && new FileInfo(file).Length > 1_000_000) File.Delete(file);
            File.AppendAllText(file, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {line}{Environment.NewLine}");
        }
        catch { }
    }
}
