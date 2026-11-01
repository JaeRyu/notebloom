// Google Drive setup helper.
// Walks people who build Notebloom from source through registering it as their own app on
// Google Cloud, then saves the issued OAuth client values to .env.local. (About 10 minutes, free.)
//
//   npm run setup:google              interactive setup
//   npm run setup:google -- --check   re-check the saved values only
//
// Environment: NO_BROWSER=1 (don't open the browser), NOTEBLOOM_ENV_FILE (custom output path, for tests)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import path from "node:path";

const ENV_FILE = process.env.NOTEBLOOM_ENV_FILE ?? path.join(process.cwd(), ".env.local");
const SCOPES = "openid email profile https://www.googleapis.com/auth/drive.appdata";
const KEYS = {
  web: "VITE_GOOGLE_WEB_CLIENT_ID",
  deviceId: "VITE_GOOGLE_DEVICE_CLIENT_ID",
  deviceSecret: "VITE_GOOGLE_DEVICE_CLIENT_SECRET",
};
const CLIENT_ID_RE = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
const SECRET_RE = /^GOCSPX-[A-Za-z0-9_-]{20,}$/;

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
};

// ---- .env.local read/write (other lines and comments are kept as-is) ----

function readEnv() {
  if (!existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function writeEnv(values) {
  const lines = existsSync(ENV_FILE)
    ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/)
    : ["# Notebloom local settings — this file is never committed (.gitignore).", ""];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const i = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeFileSync(ENV_FILE, lines.join("\n").replace(/\n*$/, "\n"));
}

const mask = (s) => (s ? `${s.slice(0, 10)}…${s.slice(-4)}` : "(none)");

// ---- Opening the browser ----

function openUrl(url) {
  console.log(`   ${c.dim("→")} ${url}`);
  if (process.env.NO_BROWSER) return;
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

// ---- Verifying against Google ----

/** Starts a device-code sign-in to confirm the client ID, its type and the scopes (creates nothing). */
async function verifyDeviceClient(clientId) {
  try {
    const res = await fetch("https://oauth2.googleapis.com/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, scope: SCOPES }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.user_code) return { ok: true, message: "Google recognizes this client (app sign-in will work)." };
    const hints = {
      invalid_client: "Google can't find this client ID. Check that you copied it exactly.",
      unauthorized_client: "This client doesn't support device sign-in. Make sure its type is 'TVs and Limited Input devices'.",
      invalid_scope: "The requested scopes were rejected. Add the drive.appdata scope under 'Data access' on the consent screen.",
      disabled_client: "This client is disabled. Check its status in the console.",
    };
    return { ok: false, message: hints[data.error] ?? `Google responded: ${data.error ?? res.status} ${data.error_description ?? ""}` };
  } catch {
    return { ok: null, message: "Can't reach the internet, so the Google check was skipped." };
  }
}

function report(label, result) {
  const mark = result.ok === true ? c.ok("✓") : result.ok === false ? c.err("✗") : c.warn("!");
  console.log(`   ${mark} ${label}: ${result.message}`);
}

function checkFormats(env) {
  const id = env[KEYS.deviceId];
  const secret = env[KEYS.deviceSecret];
  const web = env[KEYS.web];
  const badId = "Invalid format (expected …apps.googleusercontent.com)";
  return [
    ["App client ID", !id ? { ok: null, message: "empty (desktop/mobile sign-in won't work)" } : CLIENT_ID_RE.test(id) ? { ok: true, message: "format OK" } : { ok: false, message: badId }],
    ["App client secret", !secret ? { ok: id ? false : null, message: "empty" } : SECRET_RE.test(secret) ? { ok: true, message: "format OK" } : { ok: null, message: "Doesn't match the usual format (GOCSPX-…). Older clients can look like this." }],
    ["Web client ID", !web ? { ok: null, message: "empty (web sign-in won't work; fine if you only use the apps)" } : CLIENT_ID_RE.test(web) ? { ok: true, message: "format OK" } : { ok: false, message: badId }],
  ];
}

// ---- --check: inspect saved values ----

async function runCheck() {
  console.log(c.bold(`\nNotebloom Google setup check  ${c.dim(ENV_FILE)}\n`));
  if (!existsSync(ENV_FILE)) {
    console.log(c.err("   No .env.local found. Run `npm run setup:google` first.\n"));
    process.exit(1);
  }
  const env = readEnv();
  const results = checkFormats(env);
  if (env[KEYS.deviceId] && CLIENT_ID_RE.test(env[KEYS.deviceId])) {
    results.push(["Google check (app client)", await verifyDeviceClient(env[KEYS.deviceId])]);
  }
  results.forEach(([label, r]) => report(label, r));
  console.log();
  process.exit(results.some(([, r]) => r.ok === false) ? 1 : 0);
}

// ---- Interactive setup ----

async function runSetup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q) => (await rl.question(q)).trim();
  const pause = () => ask(c.dim("   Press Enter when done ↵ "));
  const askValue = async (label, re, { optional = false, softFormat = false } = {}) => {
    for (;;) {
      const v = await ask(`   ${label}${optional ? c.dim(" (Enter to skip)") : ""}: `);
      if (!v) {
        if (optional) return undefined;
        console.log(c.warn("   Please enter a value."));
        continue;
      }
      if (re.test(v)) return v;
      if (softFormat) {
        const yes = await ask(c.warn("   This doesn't match the expected format. Save it anyway? (y/N) "));
        if (/^y/i.test(yes)) return v;
        continue;
      }
      console.log(c.err("   Invalid format. Please copy it from the console again."));
    }
  };

  console.log(`
${c.bold("Notebloom · Google Drive setup helper")}

This registers Notebloom as ${c.bold("your own app")} on Google Cloud and saves the issued values to .env.local.
It takes about 10 minutes and is free (no billing account needed). Google Cloud console pages will open in your browser one by one.
${c.dim("If you use an official Notebloom release, you don't need any of this.")}
`);

  const existing = readEnv();
  if (Object.values(KEYS).some((k) => existing[k])) {
    console.log(c.warn(`Existing settings found (${ENV_FILE}). They will be replaced with the values you enter.\n`));
  }

  // 1. Project
  console.log(c.bold("[1/5] Create a project"));
  console.log("   Create a new project (e.g. 'notebloom'), or reuse one you already have.");
  openUrl("https://console.cloud.google.com/projectcreate");
  const projectId = await ask(`   Project ID ${c.dim("(shown in the project picker at the top of the console; Enter if unsure)")}: `);
  const q = projectId ? `?project=${encodeURIComponent(projectId)}` : "";

  // 2. Drive API
  console.log(c.bold("\n[2/5] Enable the Google Drive API"));
  console.log("   Click 'Enable' on the page that opens.");
  openUrl(`https://console.cloud.google.com/apis/library/drive.googleapis.com${q}`);
  await pause();

  // 3. Consent screen
  console.log(c.bold("\n[3/5] OAuth consent screen (Google Auth Platform)"));
  console.log(`   - App name: ${c.bold("Notebloom")}`);
  console.log(`   - User support email: shown on the sign-in screen, so a ${c.bold("separate Gmail address")} is recommended.`);
  console.log("   - Audience: External");
  console.log(`   - Data access (scopes): add ${c.bold(".../auth/drive.appdata")}, openid, email, profile`);
  console.log(`   - Publishing status: ${c.bold("Publish to production")} ${c.dim("(in Testing, only test users can sign in and sign-ins expire every 7 days)")}`);
  openUrl(`https://console.cloud.google.com/apis/credentials/consent${q}`);
  await pause();

  // 4. Clients
  console.log(c.bold("\n[4/5] Create OAuth clients"));
  openUrl(`https://console.cloud.google.com/apis/credentials${q}`);
  console.log(`\n   ${c.bold("(a) For the desktop & mobile apps")} — 'Create client' → type ${c.bold("TVs and Limited Input devices")}`);
  const deviceId = await askValue("Client ID", CLIENT_ID_RE);
  const deviceSecret = await askValue("Client secret", SECRET_RE, { softFormat: true });
  console.log(c.dim("   Checking with Google…"));
  const verified = await verifyDeviceClient(deviceId);
  report("Google check", verified);
  if (verified.ok === false) {
    const keep = await ask(c.warn("   Save anyway? (y/N) "));
    if (!/^y/i.test(keep)) {
      console.log("\n   Nothing was saved. Fix it in the console and run this again.\n");
      rl.close();
      process.exit(1);
    }
  }

  console.log(`\n   ${c.bold("(b) For the web version")} ${c.dim("(only needed if you use it in a browser)")} — type ${c.bold("Web application")},`);
  console.log(`       and add ${c.bold("http://localhost:5173")} (and your deployed URL) under 'Authorized JavaScript origins'`);
  const webId = await askValue("Web client ID", CLIENT_ID_RE, { optional: true });

  // 5. Save
  console.log(c.bold("\n[5/5] Save"));
  writeEnv({ [KEYS.deviceId]: deviceId, [KEYS.deviceSecret]: deviceSecret, [KEYS.web]: webId });
  rl.close();
  console.log(`   ${c.ok("✓")} Saved to ${ENV_FILE} ${c.dim("(never committed)")}`);
  console.log(`     app client ID ${mask(deviceId)} · secret ${mask(deviceSecret)} · web client ID ${mask(webId)}`);
  console.log(`
${c.bold("Next steps")}
   Run the app:   npm run desktop:dev    (Android: npm run android:dev)
   Run on web:    npm run dev
   Check again:   npm run setup:google -- --check
`);
}

if (process.argv.includes("--check")) await runCheck();
else await runSetup();
