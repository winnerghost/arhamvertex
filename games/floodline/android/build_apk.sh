#!/usr/bin/env bash
# Builds a signed Floodline APK without Gradle: aapt2 + javac + dx + zipalign + apksigner.
# Usage: build_apk.sh <www-dir> <out.apk> <keystore>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WWW="$1"; OUT="$2"; KS="$3"
SDK=/usr/lib/android-sdk
JAR=$SDK/platforms/android-23/android.jar
BT=$SDK/build-tools/debian
WORK="$(mktemp -d)"
mkdir -p "$WORK/res" "$WORK/gen" "$WORK/classes" "$WORK/assets/www"
python3 "$HERE/make_icons.py" "$WORK/res" >/dev/null
aapt2 compile --dir "$WORK/res" -o "$WORK/res.zip"
cp -r "$WWW"/. "$WORK/assets/www/"
aapt2 link -o "$WORK/base.apk" -I "$JAR" --manifest "$HERE/AndroidManifest.xml" \
  --java "$WORK/gen" -A "$WORK/assets" --min-sdk-version 23 --target-sdk-version 34 \
  --version-code 2 --version-name 1.1 -0 js -0 html "$WORK/res.zip"
javac -nowarn -source 8 -target 8 -bootclasspath "$JAR" -d "$WORK/classes" \
  $(find "$HERE/src" "$WORK/gen" -name '*.java') 2>&1 | grep -v "^warning\|^Note\|^1 warning" || true
"$BT/dx" --dex --min-sdk-version=23 --output="$WORK/classes.dex" "$WORK/classes"
(cd "$WORK" && cp base.apk unsigned.apk && zip -q -j unsigned.apk classes.dex)
zipalign -f -p 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"
apksigner sign --ks "$KS" --ks-pass pass:floodline --key-pass pass:floodline --out "$OUT" "$WORK/aligned.apk"
apksigner verify --print-certs "$OUT" | head -3
rm -rf "$WORK"
