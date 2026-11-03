using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Inkwell;

/// <summary>Per-user (HKCU) registrations and small Windows shell helpers. Nothing here needs administrator rights.</summary>
public static class Shell
{
    public const string AppId = "Inkwell.Windows"; // AppUserModelID: taskbar grouping, the installer's shortcuts
    public const string Protocol = "inkwell";      // inkwell:#/new?do=hand opens the app at that place

    public static string Exe => Environment.ProcessPath ?? Application.ExecutablePath;

    /// <summary>Written on every start, so a moved or updated app still gets its links.</summary>
    public static void Register()
    {
        SetCurrentProcessExplicitAppUserModelID(AppId);
        using var k = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{Protocol}");
        k.SetValue("", "URL:Inkwell");
        k.SetValue("URL Protocol", "");
        using (var i = k.CreateSubKey("DefaultIcon")) i.SetValue("", $"\"{Exe}\",0");
        using var c = k.CreateSubKey(@"shell\open\command");
        c.SetValue("", $"\"{Exe}\" \"%1\"");
    }

    /// <summary>HKCU\Software\Inkwell\Windows: where this app is and which server it shows, so Halcyon can hand it
    /// links to that server (Inkwell.exe --link url).</summary>
    public static void Announce(string server)
    {
        try
        {
            using var k = Registry.CurrentUser.CreateSubKey(@"Software\Inkwell\Windows");
            k.SetValue("Exe", Exe);
            k.SetValue("Server", Config.Origin(server));
        }
        catch { /* Halcyon then opens Inkwell links in the browser */ }
    }

    /// <summary>An outside http(s) link: Halcyon's app when it is installed and the link is on its server (it
    /// recorded itself in HKCU\Software\Halcyon\Windows), else the default browser.</summary>
    public static void OpenLink(string url)
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(@"Software\Halcyon\Windows");
            if (k?.GetValue("Exe") is string exe && k.GetValue("Server") is string server && File.Exists(exe)
                && server.Length > 0 && Config.Origin(url).Equals(server.TrimEnd('/'), StringComparison.OrdinalIgnoreCase))
            {
                var p = new ProcessStartInfo(exe) { UseShellExecute = false };
                p.ArgumentList.Add("--link");
                p.ArgumentList.Add(url);
                AllowAnyForeground();
                Process.Start(p);
                return;
            }
        }
        catch (Exception e) { Log.Write("halcyon link: " + e.Message); }
        Open(url);
    }

    /// <summary>Uninstall: Inkwell.exe --unregister.</summary>
    public static void Unregister()
    {
        Registry.CurrentUser.DeleteSubKeyTree($@"Software\Classes\{Protocol}", false);
        Registry.CurrentUser.DeleteSubKeyTree(@"Software\Inkwell\Windows", false);
    }

    public static void Open(string target) => Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });

    public static string Downloads
    {
        get
        {
            try
            {
                if (SHGetKnownFolderPath(new Guid("374DE290-123F-4565-9164-39C4925E467B"), 0, 0, out var p) == 0)
                {
                    var s = Marshal.PtrToStringUni(p);
                    Marshal.FreeCoTaskMem(p);
                    if (!string.IsNullOrEmpty(s)) return s;
                }
            }
            catch { }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        }
    }

    /// <summary>A free file name in a folder: "name (2).ext" when "name.ext" exists.</summary>
    public static string FreeName(string dir, string name)
    {
        name = string.Join("_", name.Split(Path.GetInvalidFileNameChars())).Trim();
        if (name.Length == 0) name = "download";
        var path = Path.Combine(dir, name);
        for (var i = 2; File.Exists(path); i++) path = Path.Combine(dir, $"{Path.GetFileNameWithoutExtension(name)} ({i}){Path.GetExtension(name)}");
        return path;
    }

    public static void Front(Form f)
    {
        if (!f.Visible) f.Show();
        if (f.WindowState == FormWindowState.Minimized) ShowWindow(f.Handle, 9); // SW_RESTORE
        f.Activate();
        SetForegroundWindow(f.Handle);
    }

    public static void AllowAnyForeground() => AllowSetForegroundWindow(-1);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string id);
    [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(in Guid id, uint flags, IntPtr token, out IntPtr path);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
}
