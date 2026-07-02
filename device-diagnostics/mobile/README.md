# Device Diagnostics — native app (Capacitor)

This folder wraps the hosted web app in a real, store-distributable iOS/Android app using [Capacitor](https://capacitorjs.com). The native shell loads your hosted server directly (`server.url` in `capacitor.config.json`), so:

- the app always shows the latest deployed version — no app-store update needed for changes,
- login sessions, camera capture, and uploads work exactly as in the browser,
- the backend (and your Anthropic API key) stays on your Azure server.

## Prerequisites

- The web app deployed over HTTPS (see `../DEPLOY.md`)
- **Android:** [Android Studio](https://developer.android.com/studio)
- **iOS:** a Mac with Xcode + CocoaPods, and an Apple Developer account ($99/yr) to ship to the App Store
- Google Play developer account ($25 one-off) to ship to the Play Store

## Build — Android

```bash
cd mobile
# 1. Point the app at your server
#    edit capacitor.config.json → "url": "https://<your-app>.azurewebsites.net"
npm install
npx cap add android
npx cap open android    # opens Android Studio
```

In Android Studio: **Build → Generate Signed App Bundle** for the Play Store, or **Build APK** to sideload onto your own phone immediately (enable "Install unknown apps" on the phone).

## Build — iOS (on a Mac)

```bash
cd mobile
npm install
npx cap add ios
npx cap open ios        # opens Xcode
```

In Xcode: set your signing team, then run on a device or archive for App Store / TestFlight distribution.

## Updating

Changing the web app requires **no rebuild** — just redeploy the server. Rebuild the native app only when you change `capacitor.config.json` (e.g. the server URL) or add native plugins.

## Store review notes

Apps that are "just a website in a shell" can get pushback in Apple review. If that happens, the fix is adding a few native touches (e.g. the `@capacitor/camera` plugin for capture, haptics, push notifications). For personal/sideloaded use on Android this doesn't matter at all.
