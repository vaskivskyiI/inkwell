#!/usr/bin/env bash
# Builds the Inkwell Android app (android/) on this machine (Linux / WSL) as a signed release APK in dist-apps/.
#   ./android/build-local.sh                         (HOST=notes.example.com pre-fills the server on the first start)
# Needs JDK 17 in $T/jdk and the Android SDK in $T/sdk (platform 36, build-tools 36.1.0); Gradle is downloaded into
# $T once. Makes a signing key on the first run in $KEYDIR: keep that folder; every update of the installed app must be
# signed with the same key. Output: dist-apps/Inkwell-<version>.apk
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
HOST=${HOST:-}; PKG=${PKG:-cc.inkwell.notes}; APP_NAME=${APP_NAME:-Inkwell}; VERSION=${VERSION:-1.0.0}
KEYDIR=${KEYDIR:-$ROOT/../inkwell-android-signing}
T=${T:-$HOME/android-build}
GRADLE_VERSION=8.11.1
# JAVA_HOME / ANDROID_HOME / GRADLE from the environment win (the GitHub workflow sets them).
[ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/keytool" ] || JAVA_HOME=$T/jdk
export JAVA_HOME ANDROID_HOME=${ANDROID_HOME:-$T/sdk} PATH="$JAVA_HOME/bin:$PATH"
mkdir -p "$T" "$KEYDIR"

if [ -n "${KEYSTORE_PASSWORD:-}" ]; then
  printf '%s\n' "$KEYSTORE_PASSWORD" > "$KEYDIR/password.txt"
elif [ ! -f "$KEYDIR/inkwell-android.keystore" ]; then
  P=$(openssl rand -hex 16)
  keytool -genkeypair -keystore "$KEYDIR/inkwell-android.keystore" -alias inkwell -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$P" -keypass "$P" -dname "CN=Inkwell" > /dev/null 2>&1
  printf '%s\n' "$P" > "$KEYDIR/password.txt"; chmod 600 "$KEYDIR/password.txt"
fi
P=$(cat "$KEYDIR/password.txt")

G=${GRADLE:-$T/gradle-$GRADLE_VERSION/bin/gradle}
if [ ! -x "$G" ]; then
  curl -fsSL -o "$T/gradle.zip" "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
  (cd "$T" && jar xf gradle.zip && rm gradle.zip && chmod +x "gradle-$GRADLE_VERSION/bin/gradle")
fi

# Built in a copy, so the checkout stays clean.
W=$T/inkwell; rm -rf "$W"; mkdir -p "$W"
tar -C "$ROOT/android" --exclude=build --exclude=.gradle --exclude=local.properties -cf - . | tar -C "$W" -xf -

# Each build gets a higher version code (minutes since 2025).
CODE=$(( $(date +%s) / 60 - 29000000 ))
# The password goes in the build copy's properties (not on the command line) and is removed right after.
(umask 077; printf 'inkwell.keystorePassword=%s\n' "$P" >> "$W/gradle.properties")
trap 'rm -f "$W/gradle.properties"' EXIT
"$G" -p "$W" --no-daemon -q assembleRelease \
  -Pinkwell.package="$PKG" -Pinkwell.name="$APP_NAME" -Pinkwell.version="$VERSION" -Pinkwell.versionCode="$CODE" \
  -Pinkwell.server="$HOST" -Pinkwell.keystore="$KEYDIR/inkwell-android.keystore"

OUT=$ROOT/dist-apps; mkdir -p "$OUT"
cp "$W/app/build/outputs/apk/release/app-release.apk" "$OUT/Inkwell-$VERSION.apk"
echo "Built $OUT/Inkwell-$VERSION.apk (package $PKG, version $VERSION / $CODE)."
