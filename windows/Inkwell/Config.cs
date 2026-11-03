using System.Text.Json;

namespace Inkwell;

/// <summary>%APPDATA%\Inkwell\windows\config.json: the server and the window's place. The WebView2 profile (cookies,
/// cache, the pages kept for offline use) lives in %LOCALAPPDATA%\Inkwell\windows\WebView2.</summary>
public sealed class Config
{
    public string Server { get; set; } = "";
    public int[]? Bounds { get; set; } // x, y, width, height of the normal (not maximised) window
    public bool Maximized { get; set; }

    public static string Dir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Inkwell", "windows");
    public static string LocalDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Inkwell", "windows");
    static string FilePath => Path.Combine(Dir, "config.json");
    static readonly JsonSerializerOptions Json = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static Config Load()
    {
        try { return JsonSerializer.Deserialize<Config>(File.ReadAllText(FilePath), Json) ?? new Config(); }
        catch { return new Config(); }
    }

    public void Save()
    {
        Directory.CreateDirectory(Dir);
        var tmp = FilePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(this, Json));
        File.Move(tmp, FilePath, true);
    }

    /// <summary>"notes.example.com" → "https://notes.example.com"; no trailing slash, no path beyond the base.</summary>
    public static string? Normalize(string input)
    {
        var s = input.Trim().TrimEnd('/');
        if (s.Length == 0) return null;
        if (!s.Contains("://")) s = "https://" + s;
        if (!Uri.TryCreate(s, UriKind.Absolute, out var u) || (u.Scheme != "https" && u.Scheme != "http") || string.IsNullOrEmpty(u.Host)) return null;
        return (u.GetLeftPart(UriPartial.Authority) + u.AbsolutePath).TrimEnd('/');
    }

    public static string Origin(string url) => Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.GetLeftPart(UriPartial.Authority) : "";
}
