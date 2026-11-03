package cc.inkwell.notes

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.Message
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * The user's Inkwell server in a WebView, set up for the pen (S-Pen pressure reaches the page as pointer events; the
 * paper zooms itself under two fingers, typed pages zoom like in the browser). Launcher shortcuts say where to go (EXTRA_ROUTE, a hash route like
 * "#/new?do=hand"); the share sheet hands photos, files, text and links to the web app's share page through
 * window.inkwellAndroid (web/src/pwa.js takeShared).
 */
class MainActivity : ComponentActivity() {
    companion object {
        const val ACTION_OPEN = "cc.inkwell.notes.OPEN"
        const val EXTRA_ROUTE = "route"
        const val EXTRA_URL = "url" // a page of the server, handed over by LinkActivity (a link from Halcyon)
        const val HOME = "#/"
        const val SHARE_LIMIT_MB = 200
    }

    private class Shared(val title: String, val text: String, val url: String, val files: List<Triple<String, String, ByteArray>>)

    private lateinit var web: WebView
    private lateinit var server: String
    private lateinit var downloads: Downloads
    private var last = HOME
    @Volatile private var pageOrigin = ""
    @Volatile private var shared: Shared? = null
    private var files: ValueCallback<Array<Uri>>? = null
    private var photo: Uri? = null
    private var permission: PermissionRequest? = null
    // Signing in with Halcyon (/api/auth/halcyon/start): its sign-in pages show in this WebView until the server takes
    // over again, so the session lands here (not in the browser or Halcyon's app).
    @Volatile private var signingIn = false
    private var printing: WebView? = null // kept until Android's print dialog has the page
    private val pool = Executors.newSingleThreadExecutor()

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        files?.onReceiveValue(picked(r))
        files = null
    }
    private val takePhoto = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        files?.onReceiveValue(if (ok) photo?.let { arrayOf(it) } else null)
        files = null
    }
    private val askMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        permission?.let { if (ok) it.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else it.deny() }
        permission = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        server = Prefs.server(this) ?: run {
            startActivity(Intent(this, ConnectActivity::class.java))
            finish()
            return
        }
        enableEdgeToEdge()
        downloads = Downloads(this)
        Shortcuts.publish(this)

        web = WebView(this)
        val root = FrameLayout(this)
        root.setBackgroundColor(ContextCompat.getColor(this, R.color.page))
        root.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val i = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        setUpWebView()

        // Back = back in the web app's history; at its start the app goes to the background (and stays signed in).
        onBackPressedDispatcher.addCallback(this) { if (web.canGoBack()) web.goBack() else moveTaskToBack(true) }

        urlOf(intent)?.let { web.loadUrl(it) } ?: load(arrive(intent) ?: HOME)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        urlOf(intent)?.let { web.loadUrl(it) } ?: arrive(intent)?.let { go(it) }
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }

    /** Where an intent points: a shortcut's place, or the share page for what another app shared. */
    private fun arrive(i: Intent?): String? {
        i ?: return null
        if (i.action == Intent.ACTION_SEND || i.action == Intent.ACTION_SEND_MULTIPLE) { receive(i); return null }
        // Only places inside the web app: another app may start this activity too.
        return i.getStringExtra(EXTRA_ROUTE)?.takeIf { it.startsWith("#/") }
    }

    /** Only the server's own pages: another app may start this activity too. */
    private fun urlOf(i: Intent?): String? = i?.getStringExtra(EXTRA_URL)?.takeIf { ours(Uri.parse(it)) }

    private fun load(route: String) {
        last = route
        web.loadUrl("$server/$route")
    }

    /** Moves the running web app to a route (a hash change; the page stays loaded). */
    private fun go(route: String) {
        if (pageOrigin != serverOrigin) return load(route)
        // The same route again (a second share): through home, so the page shows it afresh.
        web.evaluateJavascript("(() => { const r = ${JSONObject.quote(route)}; if (location.hash === r) { location.hash = '#/'; setTimeout(() => { location.hash = r; }, 50); } else location.hash = r; })()", null)
    }

    // ---- the share sheet: read here (the shared files are only readable now), then the web app's share page
    private fun receive(i: Intent) {
        @Suppress("DEPRECATION")
        val uris = if (i.action == Intent.ACTION_SEND_MULTIPLE) i.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
        else listOfNotNull(i.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        val text = i.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
        val title = i.getStringExtra(Intent.EXTRA_SUBJECT) ?: i.getStringExtra(Intent.EXTRA_TITLE) ?: ""
        pool.execute {
            var total = 0L
            val list = mutableListOf<Triple<String, String, ByteArray>>()
            try {
                for (u in uris) {
                    val bytes = contentResolver.openInputStream(u)?.use { it.readBytes() } ?: continue
                    total += bytes.size
                    if (total > SHARE_LIMIT_MB * 1024L * 1024L) throw IllegalStateException(getString(R.string.share_too_big, SHARE_LIMIT_MB))
                    list += Triple(nameOf(u), contentResolver.getType(u) ?: "application/octet-stream", bytes)
                }
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this, e.message, Toast.LENGTH_LONG).show() }
                return@execute
            }
            val url = Regex("https?://\\S+").find(text)?.value.orEmpty()
            shared = Shared(title, text.takeIf { it != url } ?: "", url, list)
            runOnUiThread { go("#/share") }
        }
    }

    private fun nameOf(u: Uri): String = runCatching {
        contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    }.getOrNull() ?: u.lastPathSegment?.substringAfterLast('/') ?: "file"

    private fun origin(u: Uri) = "${u.scheme}://${u.authority}"
    private val serverOrigin get() = origin(Uri.parse(server))
    private fun ours(u: Uri) = origin(u) == serverOrigin

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWebView() {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(true)
            // Two fingers zoom typed pages like in the browser (no +/- buttons); on the paper the page zooms itself.
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString InkwellAndroid/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.addJavascriptInterface(Bridge(), "inkwellAndroid")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = link(request.url)

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                pageOrigin = if (url.startsWith("data:") || url == "about:blank") "app" else origin(Uri.parse(url))
            }

            override fun onPageFinished(view: WebView, url: String) {
                CookieManager.getInstance().flush()
            }

            @SuppressLint("WebViewClientOnReceivedSslError")
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                // Checked against the CAs added in the app (Trust.kt); anything else is refused.
                if (Trust.acceptsWebView(this@MainActivity, error)) return handler.proceed()
                handler.cancel()
                problem("The server's certificate is not trusted by this phone. If it comes from your own CA, add that CA certificate (Change server → Add CA certificate) or install it in Android's settings.")
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) problem("$server cannot be reached: ${error.description}")
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                files?.onReceiveValue(null)
                files = callback
                // <input capture="environment">: straight to the camera (a photo for the page).
                if (params.isCaptureEnabled && params.acceptTypes.any { it.startsWith("image/") }) {
                    val dir = File(cacheDir, "camera").apply { mkdirs() }
                    dir.listFiles()?.forEach { if (System.currentTimeMillis() - it.lastModified() > 86_400_000) it.delete() }
                    photo = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", File(dir, "photo-${System.currentTimeMillis()}.jpg"))
                    return try { takePhoto.launch(photo!!); true } catch (_: ActivityNotFoundException) { files = null; false }
                }
                val i = params.createIntent()
                if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                return try { pickFiles.launch(i); true } catch (_: ActivityNotFoundException) { files = null; false }
            }

            // Recording a meeting into a page: the microphone, only for the user's server, after Android's own question.
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (!ours(request.origin) || !request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) return@runOnUiThread request.deny()
                    if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    } else {
                        permission?.deny()
                        permission = request
                        askMic.launch(Manifest.permission.RECORD_AUDIO)
                    }
                }
            }

            // window.open / target=_blank: a throwaway WebView catches the address, which is then handled like a link.
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                val probe = WebView(this@MainActivity)
                var done = false
                fun take(u: Uri) {
                    if (done) return
                    done = true
                    popup(u)
                    probe.post { probe.stopLoading(); probe.destroy() }
                }
                probe.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean { take(r.url); return true }
                    override fun onPageStarted(v: WebView, url: String, favicon: Bitmap?) = take(Uri.parse(url))
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = probe
                resultMsg.sendToTarget()
                return true
            }
        }

        web.setDownloadListener { url, userAgent, disposition, mime, _ ->
            if (url.startsWith("blob:")) blob(url, Downloads.fileName(url, disposition, mime ?: "application/octet-stream"))
            else downloads.fetch(url, userAgent)
        }
    }

    private fun isPdf(u: Uri) = ours(u) && u.path.orEmpty().endsWith("/export") && u.getQueryParameter("format") == "pdf"

    /** A link in the page: the server's pages stay, its files are downloaded, PDFs printed, the rest opens outside. */
    private fun link(u: Uri): Boolean {
        if (ours(u)) signingIn = u.path.orEmpty().startsWith("/api/auth/")
        when {
            ours(u) && signingIn -> return false
            !ours(u) && signingIn && u.scheme in listOf("http", "https") -> return false
            isPdf(u) -> print(u)
            ours(u) && u.path.orEmpty().startsWith("/api/") && !u.path.orEmpty().startsWith("/api/public/") -> downloads.fetch(u.toString(), web.settings.userAgentString)
            ours(u) || u.scheme in listOf("blob", "data", "about", "javascript") -> return false
            else -> outside(u)
        }
        return true
    }

    private fun popup(u: Uri) {
        when {
            u.scheme == "blob" -> blob(u.toString(), "")
            u.scheme == "about" -> {}
            isPdf(u) -> print(u)
            ours(u) && !u.path.orEmpty().startsWith("/api/") -> web.loadUrl(u.toString())
            else -> link(u)
        }
    }

    /**
     * "Export as PDF": the server's print page (A4, handwriting cut between lines) in a WebView of its own, handed to
     * Android's printing, where "Save as PDF" is. A WebView has no window.print().
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun print(u: Uri) {
        Toast.makeText(this, R.string.printing, Toast.LENGTH_SHORT).show()
        printing?.destroy()
        val p = WebView(this).also { printing = it }
        p.settings.javaScriptEnabled = false // its script only calls print(), which does nothing here
        p.webViewClient = object : WebViewClient() {
            var done = false
            override fun onPageFinished(view: WebView, url: String) {
                if (done) return
                done = true
                val name = view.title?.takeIf { it.isNotBlank() } ?: "Inkwell"
                val attrs = PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build()
                getSystemService(PrintManager::class.java).print(name, view.createPrintDocumentAdapter(name), attrs)
            }
            @SuppressLint("WebViewClientOnReceivedSslError")
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                if (Trust.acceptsWebView(this@MainActivity, error)) handler.proceed() else handler.cancel()
            }
        }
        p.loadUrl(u.toString())
    }

    private fun outside(u: Uri) {
        // Halcyon, when installed, decides: its own server's pages open in it, the rest in the browser.
        if (u.scheme == "http" || u.scheme == "https") try {
            startActivity(Intent("cc.halcyon.mail.OPEN_LINK").setPackage("cc.halcyon.mail").putExtra("url", u.toString()))
            return
        } catch (_: ActivityNotFoundException) {}
        try { startActivity(Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE)) }
        catch (_: ActivityNotFoundException) { Toast.makeText(this, getString(R.string.no_app, u.toString()), Toast.LENGTH_LONG).show() }
    }

    /** A file the page made (blob:), read by the page and handed to the bridge. */
    private fun blob(url: String, name: String) {
        web.evaluateJavascript("""(async () => { try {
            const b = await (await fetch(${JSONObject.quote(url)})).blob();
            const r = new FileReader();
            r.onload = () => inkwellAndroid.saveFile(String(r.result).split(',')[1] || '', ${JSONObject.quote(name)}, b.type || '');
            r.readAsDataURL(b);
          } catch (e) {} })()""", null)
    }

    private fun problem(text: String) {
        val esc = text.replace("&", "&amp;").replace("<", "&lt;")
        val dark = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
        val (bg, fg) = if (dark) "#111827" to "#E5E7EB" else "#FFFFFF" to "#1D2433"
        web.loadDataWithBaseURL(null, """<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <body style="font-family:system-ui,sans-serif;padding:32px 24px;background:$bg;color:$fg">
            <h2 style="margin:0 0 10px">Inkwell</h2><p style="line-height:1.5">$esc</p>
            <button onclick="inkwellAndroid.retry()" style="height:40px;padding:0 18px;border:0;border-radius:8px;background:#2563EB;color:#fff;font-weight:600">Try again</button>
            <button onclick="inkwellAndroid.changeServer()" style="height:40px;padding:0 14px;border:0;background:none;color:#2563EB;font-weight:600">Change server</button>
            </body>""", "text/html", "utf-8", null)
    }

    private fun picked(r: ActivityResult): Array<Uri>? {
        if (r.resultCode != RESULT_OK) return null
        val d = r.data ?: return null
        d.clipData?.let { c -> return Array(c.itemCount) { c.getItemAt(it).uri } }
        return d.data?.let { arrayOf(it) }
    }

    /** window.inkwellAndroid in the page. Called on a WebView thread; the server's pages only (and the error page). */
    private inner class Bridge {
        private fun trusted() = pageOrigin == serverOrigin

        /** What was shared: { title, text, url, files: [{ name, type, size }] }, or null. */
        @JavascriptInterface
        fun sharedMeta(): String {
            val s = shared?.takeIf { trusted() } ?: return "null"
            val list = JSONArray()
            s.files.forEach { (name, type, bytes) -> list.put(JSONObject().put("name", name).put("type", type).put("size", bytes.size)) }
            return JSONObject().put("title", s.title).put("text", s.text).put("url", s.url).put("files", list).toString()
        }

        @JavascriptInterface
        fun sharedFile(i: Int): String {
            val f = shared?.takeIf { trusted() }?.files?.getOrNull(i) ?: return ""
            return Base64.encodeToString(f.third, Base64.NO_WRAP)
        }

        @JavascriptInterface
        fun clearShared() { if (trusted()) shared = null }

        @JavascriptInterface
        fun saveFile(base64: String, name: String, mime: String) {
            if (trusted()) downloads.saveBytes(Base64.decode(base64, Base64.DEFAULT), name, mime)
        }

        @JavascriptInterface
        fun retry() = runOnUiThread { load(last) }

        @JavascriptInterface
        fun changeServer() = runOnUiThread { startActivity(Intent(this@MainActivity, ConnectActivity::class.java)) }
    }
}

/** Long-press on the app icon: always opens that place, also when the app is already running. */
object Shortcuts {
    fun publish(ctx: Context) {
        val list = listOf(
            listOf("hand", R.string.sc_hand, R.string.sc_hand_short, R.drawable.sc_hand, "#/new?do=hand"),
            listOf("today", R.string.sc_today, R.string.sc_today_short, R.drawable.sc_today, "#/new?do=today"),
            listOf("photo", R.string.sc_photo, R.string.sc_photo_short, R.drawable.sc_photo, "#/share?photo=1"),
            listOf("page", R.string.sc_page, R.string.sc_page, R.drawable.sc_page, "#/new?do=page"),
            listOf("search", R.string.sc_search, R.string.sc_search, R.drawable.sc_search, "#/search"),
        )
        val max = ShortcutManagerCompat.getMaxShortcutCountPerActivity(ctx).coerceAtLeast(4)
        val shortcuts = list.take(max).mapIndexed { rank, s ->
            ShortcutInfoCompat.Builder(ctx, s[0] as String)
                .setLongLabel(ctx.getString(s[1] as Int))
                .setShortLabel(ctx.getString(s[2] as Int))
                .setIcon(IconCompat.createWithResource(ctx, s[3] as Int))
                .setRank(rank)
                .setIntent(Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN).putExtra(MainActivity.EXTRA_ROUTE, s[4] as String))
                .build()
        }
        runCatching { ShortcutManagerCompat.setDynamicShortcuts(ctx, shortcuts) }
    }
}
