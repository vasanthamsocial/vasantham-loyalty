# Vasantham Rewards — Android app

A Capacitor wrapper around the Customer App (`customer-app/web`, served at `/customer`). The app opens the server URL set in
`capacitor.config.json` → `server.url`:

| Where the app runs | `server.url` |
|---|---|
| Android emulator on this PC | `http://10.0.2.2:4000/customer/` (10.0.2.2 = the PC's localhost) |
| Real phone on the same Wi-Fi | `http://<PC's IP>:4000/customer/` |
| Production | `https://<your domain>/customer/` (then remove `"cleartext": true`) |

## Build and install (Windows)

Tools are installed under `%LOCALAPPDATA%\Android` (JDK 17, Android SDK, emulator, AVD `Vasantham_Pixel`).

```powershell
$A = "$env:LOCALAPPDATA\Android"
$env:JAVA_HOME = "$A\jdk-17.0.20.1+1"; $env:ANDROID_HOME = "$A\Sdk"
$env:JAVA_TOOL_OPTIONS = "-Djava.net.preferIPv4Stack=true"   # Gradle downloads time out over IPv6 on this network

cd customer-appndroid-app
npx cap sync android                      # after changing capacitor.config.json
cd android; .\gradlew.bat assembleDebug   # → app\build\outputs\apk\debug\app-debug.apk

& "$A\Sdk\emulator\emulator.exe" -avd Vasantham_Pixel      # start the emulator (separate window)
& "$A\Sdk\platform-tools\adb.exe" install -r app\build\outputs\apk\debug\app-debug.apk
```

The backend (`npm start` in the main `vasantham-loyalty` folder) must be running. Because the app loads its screens from
the server, changes to `customer-app/web/` appear in the app without rebuilding the APK.

For the Play Store, build a signed release bundle (`.\gradlew.bat bundleRelease` with a keystore) against
the production HTTPS URL.
