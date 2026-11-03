package cc.inkwell.notes

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast

/**
 * cc.inkwell.notes.OPEN_LINK from Halcyon (extra "url"): a page of the configured server opens in the app, anything
 * else in the browser — never back into Halcyon, which handed it over because it was not its own.
 */
class LinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val u = intent.getStringExtra("url")?.let { Uri.parse(it) }
        val server = Prefs.server(this)?.let { Uri.parse(it) }
        if (u != null && u.scheme in listOf("http", "https")) {
            if (server != null && origin(u) == origin(server))
                startActivity(Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_URL, u.toString()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            else try { startActivity(Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE)) }
            catch (_: ActivityNotFoundException) { Toast.makeText(this, getString(R.string.no_app, u.toString()), Toast.LENGTH_LONG).show() }
        }
        finish()
    }

    private fun origin(u: Uri) = "${u.scheme}://${u.authority}"
}
