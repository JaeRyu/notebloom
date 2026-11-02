# Notebloom

A Notion-style **personal note app**. One codebase runs on Windows, macOS, Linux, Android, iOS and the web.
Notes are stored in **your own Google Drive** and sync automatically across every device signed in to the same Google account.
There is no server and no Firebase.

> The app's UI is currently in Korean.

## Features

- **Block editor**: `/` slash commands, headings, lists, checklists, tables, code and quote blocks, drag-to-reorder blocks, Markdown shortcuts
- **Note hierarchy**: unlimited nested pages, drag and drop in the sidebar to re-parent, breadcrumbs
- **Local-first**: every note is saved on the device first (IndexedDB), so the app works without signing in and while offline
- **Google Drive sync**: edits upload about 1.5 s after you stop typing; other devices pick up changes every 5 s
- **Conflict-free merging**: edit the same paragraph offline on two devices and both edits survive once they reconnect (Yjs CRDT)
- **Trash** (restore / delete permanently on all devices), **quick search** `Ctrl/Cmd + K`, dark mode, mobile layout
- **Works with AI tools**: an [MCP server](mcp/README.md) lets Claude, Cursor and other AI assistants search, read, write and organize your notes through the desktop app

## How it works

```
 Device A (Windows app)        Device B (Android app)        Device C (web)
 ┌──────────────────────┐      ┌──────────────────────┐
 │ Editor ↔ Yjs document │      │ Editor ↔ Yjs document │      ...
 │      ↕ IndexedDB      │      │      ↕ IndexedDB      │
 └──────────┬───────────┘      └──────────┬───────────┘
            │   upload / download (Drive REST API)   │
            └───────────────────┬────────────────────┘
          Your Google Drive · "Notebloom" folder
             index.yjs         page list, titles, hierarchy
             note-{id}.yjs     note content (one file per note)
```

- The app only requests the `drive.file` scope: it can access the files it creates itself and nothing else in your Drive.
  The files live in a `Notebloom` folder you can see in Drive. They're managed by the app, so don't edit or delete them by hand.
  (Files are found by a hidden marker, so renaming or moving the folder doesn't break sync.)
- Why not the hidden app-data folder (`drive.appdata`)? Google doesn't allow that scope with the device-code sign-in the apps use.
- Sync = download the remote file → merge it into the local document → upload if the local copy has anything the remote one lacks.
  Yjs merges are order-independent and safe to repeat, so even if two devices upload at the same moment and one overwrites the other,
  the overwritten device notices the difference on its next check and uploads again. Every edit ends up merged.
- Changes from other devices are detected with the Drive **changes API**, so polling is very cheap when nothing has changed.

Key code: [src/sync/engine.ts](src/sync/engine.ts) (sync), [src/sync/drive.ts](src/sync/drive.ts) (Drive API),
[src/sync/auth.ts](src/sync/auth.ts) (Google sign-in), [src/store/docs.ts](src/store/docs.ts) (local storage)

## Try it without a Google account

A mock Google server lets you try sign-in and sync locally. Requires Node.js 20+.

```bash
npm install
```

Terminal 1 (mock Google Drive):

```bash
npm run mock-drive
```

Terminal 2 (the app):

```bash
npm run dev:mock
```

- <http://localhost:5174> and <http://127.0.0.1:5174> have separate storage, so they behave like **two different devices**. Open both and connect each one.
- Connecting shows a device code. Enter it at <http://127.0.0.1:8787/device> to approve.
- Stop and restart the mock server to simulate going offline and reconnecting (its data persists in `.mock-drive.json`).

## Connecting Google Drive

### Official releases

If you install an official Notebloom release, there is nothing to set up. Just sign in with Google.

### Building from source

Google requires every app that accesses Drive to be registered, so if you build Notebloom yourself you register it once
as **your own app** on Google Cloud. It's free (no billing account needed) and takes about 10 minutes. The setup helper walks you through it:

```bash
npm run setup:google
```

It opens each Google Cloud console page in order, tells you what to fill in, checks the values you paste,
**verifies your client with Google's servers**, and saves the result to `.env.local` (never committed).
To re-check an existing setup:

```bash
npm run setup:google -- --check
```

<details>
<summary>What the helper does, step by step (for reference)</summary>

At <https://console.cloud.google.com>:

1. **Create a project**
2. **APIs & Services → Library**: enable the `Google Drive API`
3. **OAuth consent screen** (Google Auth Platform)
   - Audience `External`; app name and support email (the support email is shown on the sign-in screen)
   - Data access (scopes): `.../auth/drive.file`, `openid`, `email`, `profile`
   - **Publish to production.** While the app is in `Testing`, only listed test users can sign in and Google expires sign-ins (refresh tokens) every 7 days.
     `drive.file` is a narrow, non-sensitive scope recommended by Google; the console shows any verification requirements.
4. **Credentials → Create OAuth client**, twice:
   - `TVs and Limited Input devices`: for the desktop and mobile apps (client ID + client secret)
   - `Web application`: for the web version; add `http://localhost:5173` (and your deployed URL) to the authorized JavaScript origins
5. Copy `.env.example` to `.env.local` and fill in the values

</details>

How sign-in works:
- **Web**: Google's sign-in popup. Browsers don't get a refresh token here, so you'll need to click "reconnect" after an hour.
- **Apps** (Windows, macOS, Android, iOS): enter the code shown in the app once in your browser, and you stay signed in from then on.
  It works the same way on every platform without native plugins.

> **About the OAuth values:** client IDs are public identifiers (every site with Google sign-in exposes one), and Google does not treat
> the client secret of installed apps as confidential. They can't be used to read anyone's notes (each user must sign in and consent),
> and the Drive API is free, so there is no billing risk. They are kept out of this repository anyway; official builds include them at build time.

## Using Notebloom from AI tools (MCP)

The [mcp](mcp) folder contains a [Model Context Protocol](https://modelcontextprotocol.io) server, so AI assistants such as
Claude (Desktop and Code) and Cursor can list, search, read, create and edit your notes, and move them around or to the trash.
It talks directly to the Notebloom desktop app on the same computer (over `127.0.0.1` with a per-launch access token), so changes
show up in the app instantly and sync to your other devices as usual. It needs no sign-in of its own and works offline.

```bash
cd mcp && npm install
```

```bash
claude mcp add notebloom --scope user -- node /path/to/notebloom/mcp/server.mjs
```

AI access can be turned off in the app (account/sync dialog → AI 도구 연결). See [mcp/README.md](mcp/README.md) for other AI tools,
how it works and security notes.

## Building the desktop & mobile apps (Tauri 2)

Common prerequisites: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), Rust (`rustup`).

### Windows

- Requires: Visual Studio 2022 C++ build tools, WebView2 (preinstalled on Windows 11)
- Run in development: `npm run desktop:dev`
- Release build: `npm run desktop:build` → installers in `src-tauri/target/release/bundle/` (`.msi`, `-setup.exe`)

### Android

- Requires: Android Studio (SDK + NDK), JDK 17+, and Rust's Android targets:

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

- Environment variables: `ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk`, `NDK_HOME=%ANDROID_HOME%\ndk\<installed version>`
- The Android project already exists in [src-tauri/gen/android](src-tauri/gen/android), so you don't need `android:init`.
- Run on a connected phone or emulator: `npm run android:dev`
- Test APK: `npx tauri android build --debug --apk` (signed with a debug key, installable right away)
- Release: `npm run android:build`. Publishing to the Play Store requires [signing setup](https://v2.tauri.app/distribute/sign/android/).
- Android 15+ edge-to-edge handling (status bar, navigation bar and keyboard insets) lives in
  [MainActivity.kt](src-tauri/gen/android/app/src/main/java/io/github/jaeryu/notebloom/MainActivity.kt).

### macOS & iOS (a Mac is required)

- Apple only allows iOS apps to be built on **macOS with Xcode** (not possible on Windows).
- On a Mac:

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
```

```bash
npm run ios:init
```

```bash
npm run ios:dev
```

  Commit the `src-tauri/gen/apple` folder that `ios:init` creates.
- Installing on an iPhone requires an Apple account (a free account can install on your own device for 7 days; the App Store requires the paid Apple Developer Program).
- Without a Mac, GitHub Actions macOS runners can build for macOS/iOS (store the signing certificates in the repository's Secrets).

Notes:
- The app identifier `identifier` (`io.github.jaeryu.notebloom`) in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) becomes the Android/iOS package name and can't be changed after publishing to a store.
- The app's network allowlist is in [src-tauri/capabilities/default.json](src-tauri/capabilities/default.json) (only Google sign-in and the Drive API).
  To test the desktop/mobile app against the mock server, temporarily add `{ "url": "http://127.0.0.1:8787/*" }` during development.

## Security

- **Least privilege**: the only Google scope is `drive.file` (only files the app created), and the app's network allowlist contains just the Google sign-in and Drive API hosts.
- **AI tool connection**: the desktop app accepts requests from the MCP server only on `127.0.0.1`, only with an access token that changes
  on every launch (stored in a file only your user can read), and rejects requests from web pages. It can be turned off in the app,
  and there is no way to delete notes permanently through it ([details](mcp/README.md#security)).
- **CSP**: the desktop and mobile apps enforce a Content Security Policy that blocks external and inline scripts ([tauri.conf.json](src-tauri/tauri.conf.json)).
  When hosting the web version, send a similar CSP header from your server (allowing Google's sign-in script and the Drive API):
  `default-src 'self'; script-src 'self' https://accounts.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com; frame-src https://accounts.google.com; object-src 'none'; base-uri 'self'`
- **Links in notes**: the editor (BlockNote) only accepts safe URL schemes such as http, https and mailto, so `javascript:` links are blocked; the apps open external links in the system browser.
- **Android**: release builds don't allow unencrypted HTTP, and auto backup (`allowBackup`) is disabled so sign-in tokens never end up in device backups.
- **Dependency audits**: run `npm audit` and `cargo audit` (RustSec).
- **Known limitation**: sign-in tokens are stored in app storage (localStorage). Moving them to the OS keychain (Windows Credential Manager, macOS Keychain, Android Keystore) would be safer.

## Project structure

```
src/
  store/docs.ts             Yjs documents + IndexedDB persistence (shared instances, release)
  store/notes.ts            page list (index document): create, update, trash, delete permanently
  sync/auth.ts              Google sign-in (web popup / device code in apps), token refresh
  sync/drive.ts             Google Drive REST API (Notebloom folder, changes, uploads)
  sync/engine.ts            sync engine (change detection, merging, uploads, delete propagation, account switching)
  components/               Sidebar, PageView, Editor, Home, Dialogs, ui
  ai/                       requests from AI tools (MCP): local connection + note operations in Markdown
  platform.ts               web vs. app (Tauri) differences (HTTP, external links)
scripts/
  setup-google.mjs          Google Drive setup helper (npm run setup:google)
  mock-drive.mjs            mock Google server for development (npm run mock-drive)
  third-party-notices.mjs   generates the open source license notices (runs on build)
src-tauri/                  Tauri 2 native shell (Rust), Android project in gen/android
  src/ai_bridge.rs          local HTTP endpoint for the MCP server (127.0.0.1, access token)
mcp/                        MCP server for AI tools (separate npm package, talks to the desktop app)
```

## Known limitations / roadmap

- No image or file attachments yet (could be added as separate files in Drive)
- Search only covers note titles
- Store sign-in tokens in the OS keychain
- One-click sign-in: return to the app automatically after signing in on desktop, native Google sign-in on Android
- If the same note is open in several tabs of one browser, the tabs don't update each other in real time (changes arrive via Drive a few seconds later)
- Note version history, export (Markdown/PDF), templates, English UI

## License

[MIT](LICENSE)

The core packages of [BlockNote](https://github.com/TypeCellOS/BlockNote), the editor, are MPL-2.0. Using the npm packages as-is is fine,
but if you modify BlockNote's own source files and distribute them, those files must be published under MPL-2.0.
(The `@blocknote/xl-*` packages are GPL/commercially licensed, so take care if you add them.)

Release builds (`npm run build`, `npm run desktop:build`, …) automatically include `THIRD_PARTY_NOTICES.txt` with the license texts
of every bundled npm package and Rust crate ([scripts/third-party-notices.mjs](scripts/third-party-notices.mjs)).
