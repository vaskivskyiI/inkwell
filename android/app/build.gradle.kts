// The Inkwell app: the server's web app in a WebView, plus what a web page cannot do well on Android — the share
// sheet, launcher shortcuts, the camera for photos, printing to PDF, downloads and a private CA. Built by
// android/build-local.sh (or .github/workflows/android.yml).
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun prop(name: String) = (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() }

android {
    namespace = "cc.inkwell.notes"
    compileSdk = 36
    defaultConfig {
        applicationId = prop("inkwell.package") ?: "cc.inkwell.notes"
        minSdk = 24
        targetSdk = 36
        versionCode = prop("inkwell.versionCode")?.toInt() ?: 1
        versionName = prop("inkwell.version") ?: "1.0.0"
        // Pre-filled on the first start (the build script's HOST), still changeable there.
        buildConfigField("String", "DEFAULT_SERVER", "\"${prop("inkwell.server") ?: ""}\"")
        resValue("string", "app_name", prop("inkwell.name") ?: "Inkwell")
    }
    signingConfigs {
        create("release") {
            prop("inkwell.keystore")?.let {
                storeFile = file(it)
                storePassword = prop("inkwell.keystorePassword")
                keyAlias = prop("inkwell.keyAlias") ?: "inkwell"
                keyPassword = prop("inkwell.keystorePassword")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            if (prop("inkwell.keystore") != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    lint { checkReleaseBuilds = false }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
}
