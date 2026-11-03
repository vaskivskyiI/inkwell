package cc.inkwell.notes

import android.content.Context

/** What the app remembers: the server's address. */
object Prefs {
    private fun p(ctx: Context) = ctx.getSharedPreferences("inkwell", Context.MODE_PRIVATE)

    fun server(ctx: Context): String? = p(ctx).getString("server", null)
    fun setServer(ctx: Context, url: String) = p(ctx).edit().putString("server", url).apply()

    /** "https://notes.example.com" from what was typed (no trailing slash; https when no scheme). */
    fun normalize(input: String): String? {
        var s = input.trim().trimEnd('/')
        if (s.isEmpty()) return null
        if (!s.contains("://")) s = "https://$s"
        val u = android.net.Uri.parse(s)
        if (u.scheme !in listOf("http", "https") || u.host.isNullOrEmpty()) return null
        val path = u.path?.trimEnd('/').orEmpty()
        return "${u.scheme}://${u.authority}$path"
    }
}
