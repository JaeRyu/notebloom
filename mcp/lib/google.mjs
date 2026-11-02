// Google sign-in (OAuth device flow) and a small Drive client for the Notebloom MCP server.
// Uses the same OAuth client, scope, folder and file markers as the Notebloom app
// (src/sync/auth.ts, src/sync/drive.ts), so it sees exactly the notes the app syncs.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// ---- Configuration ----------------------------------------------------------

/** Mock Google server for development (`npm run mock-drive` in the repo). */
const MOCK = process.env.NOTEBLOOM_MOCK_GOOGLE_URL;
const GOOGLE_API = MOCK ?? "https://www.googleapis.com";
const OAUTH = MOCK ?? "https://oauth2.googleapis.com";
const DRIVE = `${GOOGLE_API}/drive/v3`;
const UPLOAD = `${GOOGLE_API}/upload/drive/v3`;
const SCOPES = "openid email profile https://www.googleapis.com/auth/drive.file";

const FILE_FIELDS = "id,name,version";
const FOLDER_NAME = "Notebloom";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const MARK = "notebloom";
const markQuery = (value) => `appProperties has { key='${MARK}' and value='${value}' } and trashed = false`;

function readDotEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * The OAuth client must be the same "TVs and Limited Input devices" client the app uses: with the
 * drive.file scope, Google only grants access to files created by the same Cloud project.
 * Taken from NOTEBLOOM_GOOGLE_CLIENT_ID / _SECRET, or from the repo's .env.local.
 */
function clientCredentials() {
  if (MOCK) return { client_id: "mock", client_secret: "mock" };
  const env = readDotEnv(path.join(repoRoot, ".env.local"));
  const id = process.env.NOTEBLOOM_GOOGLE_CLIENT_ID ?? env.VITE_GOOGLE_DEVICE_CLIENT_ID;
  const secret = process.env.NOTEBLOOM_GOOGLE_CLIENT_SECRET ?? env.VITE_GOOGLE_DEVICE_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "No Google OAuth client configured. Run `node scripts/setup-google.mjs` in the repo, " +
        "or set NOTEBLOOM_GOOGLE_CLIENT_ID and NOTEBLOOM_GOOGLE_CLIENT_SECRET.",
    );
  }
  return { client_id: id, client_secret: secret };
}

const tokenFile =
  process.env.NOTEBLOOM_MCP_TOKEN_FILE ??
  path.join(homedir(), ".notebloom", MOCK ? "mcp-token.mock.json" : "mcp-token.json");

// ---- Tokens -----------------------------------------------------------------

export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in to Google. Run `node mcp/server.mjs login` in the Notebloom repo first.");
  }
}

function loadTokens() {
  try {
    return JSON.parse(readFileSync(tokenFile, "utf8"));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  mkdirSync(path.dirname(tokenFile), { recursive: true });
  // The refresh token grants access to the user's Notebloom files, so keep it private to the user.
  writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function postForm(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}

let refreshing = null;

export async function getAccessToken(forceRefresh = false) {
  const tokens = loadTokens();
  if (!tokens?.refreshToken) throw new NotSignedInError();
  if (!forceRefresh && tokens.accessToken && tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
  refreshing ??= (async () => {
    try {
      const { ok, data } = await postForm(`${OAUTH}/token`, {
        ...clientCredentials(),
        refresh_token: tokens.refreshToken,
        grant_type: "refresh_token",
      });
      if (!ok || !data.access_token) throw new NotSignedInError();
      saveTokens({ ...tokens, accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
      return data.access_token;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export function signedInAccount() {
  return loadTokens()?.account ?? null;
}

async function fetchAccount(accessToken) {
  const res = await fetch(`${GOOGLE_API}/oauth2/v3/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Could not read the Google account (${res.status}).`);
  const info = await res.json();
  return { email: info.email, name: info.name || info.email };
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", '""', url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

/** Interactive sign-in for the CLI: shows a code to enter at google.com/device. */
export async function login(log = console.log) {
  const client = clientCredentials();
  const { ok, data: code } = await postForm(`${OAUTH}/device/code`, { client_id: client.client_id, scope: SCOPES });
  if (!ok) throw new Error(`Could not start sign-in: ${code.error ?? "unknown error"} ${code.error_description ?? ""}`);

  log(`\nOpen ${code.verification_url} and enter this code:\n\n    ${code.user_code}\n`);
  log("Waiting for you to approve in the browser…");
  if (!process.env.NO_BROWSER) openBrowser(code.verification_url);

  const expiresAt = Date.now() + code.expires_in * 1000;
  let interval = code.interval * 1000;
  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, interval));
    let data;
    try {
      ({ data } = await postForm(`${OAUTH}/token`, { ...client, device_code: code.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }));
    } catch {
      continue; // transient network error: keep waiting
    }
    if (data.access_token) {
      const account = await fetchAccount(data.access_token);
      saveTokens({
        account,
        accessToken: data.access_token,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
        refreshToken: data.refresh_token,
      });
      return account;
    }
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") {
      interval += 5000;
      continue;
    }
    if (data.error === "access_denied") throw new Error("Access was denied in the browser.");
    throw new Error(data.error_description || data.error || "Sign-in failed.");
  }
  throw new Error("The code expired. Run login again.");
}

export async function logout() {
  const tokens = loadTokens();
  if (tokens?.refreshToken && !MOCK) await postForm(`${OAUTH}/revoke`, { token: tokens.refreshToken }).catch(() => {});
  rmSync(tokenFile, { force: true });
}

export const tokenFilePath = tokenFile;

// ---- Drive ------------------------------------------------------------------

export class NotFoundError extends Error {}

async function request(url, init = {}, retried = false) {
  const token = await getAccessToken(retried);
  const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  if (res.status === 401 && !retried) return request(url, init, true);
  if (res.status === 404) throw new NotFoundError(url);
  if (res.status === 403 || res.status === 429) throw new Error(`Google Drive rate limit (${res.status}). Try again in a moment.`);
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`);
  return res;
}

const json = async (url, init) => (await request(url, init)).json();

export const drive = {
  /** All Notebloom note files (found by marker, wherever they are). */
  async listDocs() {
    const files = [];
    let pageToken;
    do {
      const params = new URLSearchParams({ spaces: "drive", q: markQuery("doc"), fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: "1000" });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await json(`${DRIVE}/files?${params}`);
      files.push(...data.files);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return files;
  },

  async startPageToken() {
    return (await json(`${DRIVE}/changes/startPageToken`)).startPageToken;
  },

  async changes(pageToken) {
    const changes = [];
    let token = pageToken;
    for (;;) {
      const params = new URLSearchParams({
        pageToken: token,
        spaces: "drive",
        pageSize: "1000",
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS},trashed))`,
      });
      const data = await json(`${DRIVE}/changes?${params}`);
      changes.push(...data.changes);
      if (data.newStartPageToken) return { changes, newToken: data.newStartPageToken };
      token = data.nextPageToken;
    }
  },

  async download(id) {
    return new Uint8Array(await (await request(`${DRIVE}/files/${id}?alt=media`)).arrayBuffer());
  },

  folderId: null,

  /** The Notebloom folder (created by the app, or here if it doesn't exist yet). */
  async ensureFolder() {
    this.folderId ??= (async () => {
      const params = new URLSearchParams({ spaces: "drive", q: markQuery("folder"), fields: "files(id,createdTime)" });
      const { files } = await json(`${DRIVE}/files?${params}`);
      if (files.length) return [...files].sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? ""))[0].id;
      const folder = await json(`${DRIVE}/files?fields=id`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME, appProperties: { [MARK]: "folder" } }),
      });
      return folder.id;
    })().catch((e) => {
      this.folderId = null;
      throw e;
    });
    return this.folderId;
  },

  async create(name, data) {
    const folderId = await this.ensureFolder();
    const boundary = `notebloom${Math.random().toString(36).slice(2)}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name, parents: [folderId], appProperties: { [MARK]: "doc" } }) +
        `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const body = Buffer.concat([head, Buffer.from(data), Buffer.from(`\r\n--${boundary}--`)]);
    return json(`${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
  },

  async update(id, data) {
    return json(`${UPLOAD}/files/${id}?uploadType=media&fields=${FILE_FIELDS}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from(data),
    });
  },
};
