using System.IO.Pipes;
using System.Security.Principal;
using System.Text;

namespace Inkwell;

static class Program
{
    // One running copy per user: a second start (Start menu shortcut, an inkwell: link) hands its arguments over a
    // pipe that only this user can open, and the first one comes to the front at that place.
    static readonly string Pipe = "Inkwell.Windows." + (WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName);

    [STAThread]
    static void Main(string[] args)
    {
        if (args.Contains("--unregister")) { Shell.Unregister(); return; }
        using var mutex = new Mutex(true, @"Local\Inkwell.Windows", out var first);
        if (!first) { HandOver(args); return; }

        ApplicationConfiguration.Initialize();
        try { Shell.Register(); } catch { /* registry refused: inkwell: links just won't reach the app */ }

        var config = Config.Load();
        if (string.IsNullOrEmpty(config.Server))
        {
            using var connect = new ConnectForm(config.Server, null);
            if (connect.ShowDialog() != DialogResult.OK) return;
            config.Server = connect.Server;
            config.Save();
        }
        Shell.Announce(config.Server);
        // A link Halcyon handed over that is not on this server (it changed meanwhile): the browser, no window.
        if (Array.IndexOf(args, "--link") is var i and >= 0 && i + 1 < args.Length
            && !Config.Origin(args[i + 1]).Equals(Config.Origin(config.Server), StringComparison.OrdinalIgnoreCase))
        {
            if (args[i + 1].StartsWith("http:") || args[i + 1].StartsWith("https:")) Shell.Open(args[i + 1]);
            return;
        }
        var main = new MainForm(config, args);
        Listen(main);
        Application.Run(main);
    }

    static void HandOver(string[] args)
    {
        try
        {
            Shell.AllowAnyForeground();
            using var c = new NamedPipeClientStream(".", Pipe, PipeDirection.Out, PipeOptions.CurrentUserOnly);
            c.Connect(3000);
            c.Write(Encoding.UTF8.GetBytes(string.Join("\n", args.Length > 0 ? args : new[] { "--show" })));
        }
        catch { /* the first copy is just closing */ }
    }

    static void Listen(MainForm main)
    {
        var t = new Thread(() =>
        {
            while (true)
            {
                try
                {
                    using var s = new NamedPipeServerStream(Pipe, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.CurrentUserOnly);
                    s.WaitForConnection();
                    using var r = new StreamReader(s, Encoding.UTF8);
                    var args = r.ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries);
                    if (main.IsHandleCreated) main.BeginInvoke(() => main.Arrive(args));
                }
                catch { Thread.Sleep(500); }
            }
        }) { IsBackground = true, Name = "single-instance" };
        t.Start();
    }
}
