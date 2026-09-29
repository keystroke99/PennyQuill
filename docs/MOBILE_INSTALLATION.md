# iOS and Android implementation

PennyQuill's first mobile release is the deployed Progressive Web App. This is the simplest manual installation path, needs no App Store or Play Store account, keeps UI/API on one origin and receives updates at the next launch.

## iPhone and iPad: install the PWA

1. Deploy PennyQuill and open its HTTPS address in Safari.
2. Tap the Page menu or Share button.
3. Tap **Add to Home Screen**. If hidden, choose **Edit Actions** and add it.
4. Turn on **Open as Web App**.
5. Tap **Add**.
6. Launch PennyQuill from the Home Screen icon and sign in.

The installed app has its own standalone browser storage context, so a user may need to sign in again even if signed in inside Safari.

### iOS SMS reality

Neither a PWA nor a normal iOS app can read the general Messages inbox. Apple's Message Filter extension is limited to filtering incoming SMS/MMS from unknown senders and is not a general history API. PennyQuill therefore supports:

- manual amount-first entry;
- copy a bank alert in Messages, open PennyQuill, paste, preview and approve;
- a device-tested personal Shortcut that opens PennyQuill's quick-entry or clipboard review screen.

Do not market a Shortcut as automatic inbox access. Apple does not guarantee arbitrary received-message bodies are exposed to every automation/action combination.

## Android: install the PWA

1. Open the HTTPS address in Chrome.
2. Tap the three-dot menu.
3. Choose **Install app** or **Add to Home screen**.
4. Confirm **Install**.
5. Open PennyQuill from the launcher and sign in.

No APK is needed for this path.

### Android SMS reality

READ_SMS and RECEIVE_SMS are dangerous, hard-restricted permissions. Sideloading alone does not guarantee an app can receive them. Google Play generally requires the app to be the genuine default SMS handler or fit a narrow approved exception. PennyQuill should not pretend to be a default messaging app.

The safe Android baseline matches iOS: manual entry, share/copy text, review, then save. Any future native ingestion bridge must be separately consented, tested on target devices, parse on-device where possible, send only normalized fields and use the same duplicate/review API.

## Optional native shell: a separate future workstream

The shipped and supported mobile client is the installable PWA above. Do **not** wrap the current `dist` folder directly in Capacitor: PennyQuill deliberately uses same-origin Secure, HttpOnly cookies and relative `/api` calls. A `capacitor://localhost` or `http://localhost` WebView is a different origin, so a naive wrapper will fail authentication and origin checks.

If a native binary is later required for biometrics, share targets or managed distribution, treat it as its own security-reviewed client project. Keep the Cloudflare Worker and D1 as the backend and first implement:

- a dedicated native authentication contract with short-lived access tokens, refresh rotation, revocation and secure Keychain/Keystore storage;
- an explicit production API base URL and narrowly allow-listed native origin;
- CSRF/CORS behavior for that contract, TLS-error handling and no setup key or password in the binary;
- universal/app links, privacy disclosures and a physical-device test matrix.

Only after that contract exists should the native projects be scaffolded:

~~~powershell
npm install @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
npx cap init PennyQuill com.example.pennyquill --web-dir dist
npx cap add ios
npx cap add android
npm run build
npx cap sync
~~~

Replace com.example.pennyquill with a reverse-domain identifier you control.

### Native iOS steps

1. Run npx cap open ios on macOS with Xcode installed.
2. Select your Apple development team and a unique bundle identifier.
3. Configure the reviewed native API/auth contract above; the current cookie-only PWA contract is not sufficient for a WebView origin.
4. Add a share extension only for user-mediated text sharing; do not request nonexistent inbox privileges.
5. Build to a connected device.
6. A free Personal Team install normally expires after seven days. For longer manual distribution, join the Apple Developer Program and use registered devices with an Ad Hoc profile, or TestFlight/App Store.
7. Test login cookies, safe-area insets, keyboard entry, share flow and offline shell on a physical iPhone.

### Native Android steps

1. Install Android Studio and a current SDK/JDK supported by Capacitor.
2. Run npx cap open android.
3. Set a unique application ID and produce a private release signing key.
4. Configure the reviewed native API/auth contract and Cloudflare HTTPS base URL; never embed the setup key, access token or owner password.
5. Implement an Android Share Target for selected text if desired. Shared text must open the same preview/edit/approve flow.
6. Do not add READ_SMS/RECEIVE_SMS unless policy review proves eligibility and the installer/device can grant the restricted permission.
7. Build a signed App Bundle for Play or signed APK for deliberate sideloading.
8. On Android 8+, a sideloading user must allow **Install unknown apps** for the distributing source. Explain update and signing-key ownership.
9. Test on physical devices from more than one manufacturer, including permission denial and duplicate imports.

## Mobile acceptance checklist

- Primary actions are reachable with one thumb.
- Interactive targets are at least 44 by 44 points/pixels.
- Icons always have a text label or accessible name.
- Amount, category, member and account can be recorded in under 20 seconds.
- Charts resize without horizontal page scrolling and have table alternatives.
- No API response containing financial data is cached by the service worker.
- Sign-out revokes the server session.
- Raw pasted SMS is absent from D1 and logs.
- Duplicate import is blocked.
- Forecast uncertainty and assumptions remain visible on small screens.
