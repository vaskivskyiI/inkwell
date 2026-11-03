# Inkwell for Android

A native Android app (Kotlin, `android/`) that shows your Inkwell server in a WebView and adds what a web page cannot
do well on a phone or tablet:

- **Pen**: S-Pen and other styluses reach the page with pressure. Only the pen writes: one finger scrolls, two
  fingers zoom the paper (typed pages zoom like in the browser). ✋ in the pen toolbar lets a finger draw too.
- **Share sheet**: photos, files, text and links shared from other apps go to Inkwell's share page — into the page
  you are working on (on any device) or a new page. Up to 200 MB at once.
- **Launcher shortcuts** (long-press the icon): Write by hand, Today's journal, Photo to a page, New page, Search.
- **Camera**: "Take a photo" opens the camera directly.
- **Export as PDF**: Android's print dialog with the A4 page (Save as PDF).
- **Recording** a meeting into a page: Android asks for the microphone the first time.
- **Files**: exports are saved to Downloads.
- **Your own CA**: a server with a certificate from your own certificate authority works, either with the CA added
  in the app (connect screen → *Add CA certificate…*) or installed on the phone.
- The back gesture goes back inside the app. You stay signed in; pages you opened stay readable offline.

On the first start, enter your server's address, for example `https://notes.example.com`, then sign in. *Change
server* is on the page that appears when the server cannot be reached.

The app always shows the current web app from your server, so a server upgrade needs no app update. Rebuild the app
only when `android/` changes.

## Build

On Linux or WSL with JDK 17 and the Android SDK (platform 36, build-tools 36.1.0) in `~/android-build/{jdk,sdk}`:

```bash
./android/build-local.sh                 # HOST=notes.example.com pre-fills the server
```

The signed APK lands in `dist-apps/Inkwell-<version>.apk`. The first build makes a signing key in
`../inkwell-android-signing/` (next to the repository): keep that folder — every update of the installed app must be
signed with the same key. Install by opening the APK on the device (allow installing from that source once), or
`adb install -r dist-apps/Inkwell-1.0.0.apk`.
