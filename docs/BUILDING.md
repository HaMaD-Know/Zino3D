# Building Zino3D

## 1. Web app

```bash
npm ci                 # installs exactly what package-lock.json specifies
npm run dev            # dev server with hot reload
npm run lint           # ESLint
npm run typecheck      # TypeScript (strict)
npm test               # Vitest unit + integration tests (Node, fake IndexedDB)
npm run build          # type-check + production build into dist/
npm run preview        # serve dist/ on http://localhost:4173
npm run test:e2e       # Playwright UI tests against the preview server (run `npm run build` first)
```

The build is fully self-contained: three.js, the Draco / Basis decoders (WASM) and all icons are bundled.
No CDN is used at runtime, and a strict Content-Security-Policy (`build/cspPlugin.ts`) blocks any remote host.

### PWA / offline

`build/serviceWorkerPlugin.ts` generates `dist/sw.js` with a precache list of the build output and a cache name
derived from a hash of the files, so each deployment gets a fresh cache and old caches are deleted on
activation. Only the application shell is cached — user models live in IndexedDB, never in the service worker.

The service worker registers only in production builds served from a secure origin (HTTPS or `localhost`).
To verify offline support manually: `npm run build && npm run preview`, open the app once, then enable
“Offline” in the browser dev tools and reload — the home screen, existing projects, editing and export work.

Deploy `dist/` to any static host (GitHub Pages, Netlify, an S3 bucket, a USB stick served by a local web
server…). The build uses relative URLs, so it works from a sub-path.

## 2. Android

Requirements: JDK 21, Android SDK (API 36). The GitHub-hosted Ubuntu runner already has the SDK.

```bash
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug     # app/build/outputs/apk/debug/app-debug.apk
```

Install the debug APK on a device with “Install unknown apps” allowed (or `adb install`).

### Signed release (optional)

Release signing is read **only from environment variables** (`android/app/build.gradle`), which the workflow
fills from GitHub secrets. Create a keystore once on a trusted machine:

```bash
keytool -genkeypair -v -keystore zino3d-release.jks -alias zino3d -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 zino3d-release.jks > keystore.b64     # macOS: base64 -i zino3d-release.jks
```

Add these repository secrets (Settings → Secrets and variables → Actions):

| Secret                      | Value                      |
| --------------------------- | -------------------------- |
| `ANDROID_KEYSTORE_BASE64`   | contents of `keystore.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password          |
| `ANDROID_KEY_ALIAS`         | `zino3d` (or your alias)   |
| `ANDROID_KEY_PASSWORD`      | key password               |

Never commit the keystore (`*.jks`, `*.keystore` are in `.gitignore`). Keep an offline backup: losing it means
you can no longer update the app on Google Play.

## 3. iOS / iPadOS

The iOS project uses **Swift Package Manager** (Capacitor 8 default) — no CocoaPods.
Bundle identifier: `com.zino3d.editor` (change it in Xcode or via the `IOS_BUNDLE_ID` repository _variable_
for CI if that identifier is taken in your Apple account).

Building requires macOS with Xcode. You do **not** need a Mac yourself: the `iOS build` workflow runs on a
GitHub-hosted macOS runner and produces three clearly different outputs:

| Artifact                                    | What it is                                                   | Installable on iPhone/iPad?                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zino3d-ios-SIMULATOR-ONLY-not-for-devices` | `App.app` built for the iOS Simulator                        | **No.** Simulator only.                                                                                                                                                             |
| `zino3d-ios-UNSIGNED-requires-resigning`    | `Zino3D-UNSIGNED.ipa`, device architecture, **no signature** | **Not as is.** It must be re-signed first (e.g. with your own Apple ID in a sideloading tool, or in Xcode). Apps signed with a free Apple ID expire after 7 days.                   |
| `zino3d-ios-signed-ipa`                     | Signed IPA (ad-hoc, development or App Store Connect)        | **Yes**, on devices included in the provisioning profile (ad-hoc/development), or via TestFlight/App Store (app-store-connect). Only produced when the signing secrets below exist. |

### Requirements for a device-installable IPA

1. **Apple Developer Program membership** (paid, per year) — required for ad-hoc, development and App Store
   distribution profiles.
2. An **App ID** matching the bundle identifier (`com.zino3d.editor` or your own).
3. A **signing certificate** (Apple Distribution for ad-hoc / App Store, Apple Development for development),
   exported from Keychain Access as a `.p12` with a password. If you have no Mac, create the CSR with OpenSSL
   and download the certificate from the Apple Developer website, then build the `.p12` with OpenSSL.
4. A **provisioning profile** for that App ID and certificate. Ad-hoc and development profiles list the
   UDIDs of the devices allowed to install the app.

Add these repository secrets:

| Secret                            | Value                                   |
| --------------------------------- | --------------------------------------- |
| `IOS_CERTIFICATE_P12_BASE64`      | `base64` of the `.p12` file             |
| `IOS_CERTIFICATE_PASSWORD`        | password of the `.p12`                  |
| `IOS_PROVISIONING_PROFILE_BASE64` | `base64` of the `.mobileprovision` file |
| `IOS_TEAM_ID`                     | your 10-character Apple Team ID         |

The workflow imports them into a temporary keychain that is deleted at the end of the job; they are never
written to artifacts or logs. Choose the export method when running the workflow manually
(Actions → iOS build → Run workflow → `export_method`).

Install an ad-hoc IPA on an iPad without a Mac via Apple Configurator (needs a Mac), a device-management tool,
or an over-the-air manifest — or distribute through **TestFlight** (export method `app-store-connect`, then
upload with Transporter / `xcrun altool` from a Mac or an additional CI step using an App Store Connect API key).

## 4. GitHub Actions

| Workflow            | Runner       | Trigger                  | Produces                                                               |
| ------------------- | ------------ | ------------------------ | ---------------------------------------------------------------------- |
| `web-ci.yml`        | ubuntu-24.04 | every push / PR          | lint, types, unit tests, build, Playwright UI tests; `zino3d-web-dist` |
| `android-build.yml` | ubuntu-24.04 | push (non-docs) / manual | debug APK; signed APK + AAB if keystore secrets exist                  |
| `ios-build.yml`     | macos-15     | push (non-docs) / manual | simulator app, unsigned IPA; signed IPA if signing secrets exist       |

### Costs and limits

GitHub Actions is free for public repositories on standard runners. For **private** repositories, each account
gets a monthly allowance of included minutes, and **macOS minutes are billed at a much higher multiplier than
Linux minutes** (historically 10×). One iOS workflow run (two or three macOS jobs) can take 10–30 minutes, so
frequent iOS builds can exhaust the allowance quickly. To save minutes:

- run `ios-build.yml` only manually (remove the `push:` trigger), or restrict it to a release branch;
- keep `paths-ignore` so documentation changes don't trigger native builds;
- artifacts count against storage quotas; retention is set to 7–30 days.

Check the current pricing and your plan's allowance on GitHub before relying on frequent macOS builds.

### CI status

The workflows were written and validated as YAML in the development container, which has no macOS and no
Android SDK (and the Android SDK download host is blocked there), so **the Android and iOS builds have not
been executed yet**. Their first real run happens on GitHub after the branch is pushed. The web pipeline's
steps (format, lint, typecheck, unit tests, build, Playwright) were all run locally and pass.
