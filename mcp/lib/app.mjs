// Connection to the Notebloom desktop app running on this computer.
// The app listens on a random 127.0.0.1 port and writes the port and a per-launch access token to
// ai-bridge.json in its data folder (see src-tauri/src/ai_bridge.rs and src/ai/ in the repo).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const APP_ID = "io.github.jaeryu.notebloom";

/** The app's data folder (Tauri's app_data_dir for the app identifier). */
export function appDataDir() {
  if (process.env.NOTEBLOOM_APP_DATA_DIR) return process.env.NOTEBLOOM_APP_DATA_DIR;
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), APP_ID);
  if (process.platform === "darwin") return path.join(homedir(), "Library", "Application Support", APP_ID);
  return path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"), APP_ID);
}

const bridgeFile = () => path.join(appDataDir(), "ai-bridge.json");
/** Where the installed app is (written by release builds), so it can be started when needed. */
const launchFile = () => path.join(appDataDir(), "ai-launch.json");

const NOT_RUNNING =
  "Notebloom isn't running. Ask the user to open the Notebloom desktop app (with 'AI 도구 연결' turned on in its " +
  "Google Drive dialog), then try again.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Connection info of the running app, or null. */
function runningApp() {
  const info = readJson(bridgeFile());
  return info?.port && info?.token && isAlive(info.pid) ? info : null;
}

export function installedApp() {
  const exe = readJson(launchFile())?.exe;
  return exe && existsSync(exe) ? exe : null;
}

async function post(info, method, params) {
  const res = await fetch(`http://127.0.0.1:${info.port}/rpc`, {
    method: "POST",
    headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Notebloom sent an unexpected response (HTTP ${res.status}).`);
  if (!data.ok) throw new Error(data.error ?? `Notebloom error (HTTP ${res.status})`);
  return data.result;
}

/** Starts the installed app and waits until it accepts requests. */
async function launchApp(staleToken) {
  const exe = installedApp();
  if (!exe || process.env.NOTEBLOOM_NO_LAUNCH) throw new Error(NOT_RUNNING);
  console.error(`[notebloom] starting ${exe}`);
  spawn(exe, [], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(500);
    const info = runningApp();
    if (info && info.token !== staleToken) return info;
  }
  throw new Error("Started Notebloom, but it didn't accept connections within 30 seconds. Check that 'AI 도구 연결' is turned on in the app.");
}

let launching = null;

/** Calls a method in the app (src/ai/notes-api.ts), starting the app first if it isn't running. */
export async function callApp(method, params = {}) {
  let info = runningApp();
  if (info) {
    try {
      return await post(info, method, params);
    } catch (e) {
      // fetch() throws a TypeError when nothing is listening (the app was closed or crashed).
      if (!(e instanceof TypeError)) throw e;
    }
  }
  launching ??= launchApp(info?.token).finally(() => (launching = null));
  return post(await launching, method, params);
}

/** For the `status` command: the running app's status, without starting it. */
export async function appStatus() {
  const info = runningApp();
  if (!info) return null;
  try {
    return { version: info.version, ...(await post(info, "status", {})) };
  } catch (e) {
    if (e instanceof TypeError) return null;
    throw e;
  }
}
