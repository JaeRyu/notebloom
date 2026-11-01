// 개발용 모의 Google 서버: 앱이 쓰는 Drive API(v3) 일부와 OAuth 기기 코드 로그인을 흉내 낸다.
// Google 계정 없이 여러 기기(브라우저 창) 사이의 동기화를 시험할 수 있다.
//
//   npm run mock-drive          → http://127.0.0.1:8787
//   GET  /device                → 기기 코드 승인 페이지
//   GET  /debug/files           → 저장된 파일 목록
//   POST /debug/expire-tokens   → 모든 액세스 토큰 만료 (토큰 갱신 시험)
//
// 데이터는 .mock-drive.json 에 저장되어 서버를 재시작해도 유지된다.

import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_FILE = process.env.MOCK_DRIVE_FILE ?? ".mock-drive.json";
const ACCOUNT = { email: "me@example.com", name: "테스트 사용자" };

const db = existsSync(DATA_FILE)
  ? JSON.parse(readFileSync(DATA_FILE, "utf8"))
  : { files: {}, log: [], accessTokens: [], refreshTokens: [] };
const devices = new Map(); // device_code -> { userCode, approved }

const save = () => writeFileSync(DATA_FILE, JSON.stringify(db));
const id = () => randomBytes(12).toString("hex");
const meta = (f) => ({ id: f.id, name: f.name, version: String(f.version) });
const logChange = (fileId, removed) => db.log.push({ fileId, removed });

// 개발용 앱 주소에서 온 요청만 허용한다 (다른 웹사이트가 이 서버를 조작하지 못하게).
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  BASE, // /device 승인 페이지 자신
  "tauri://localhost",
  "http://tauri.localhost",
]);

function send(res, status, body, type = "application/json") {
  const origin = res.req.headers.origin;
  res.writeHead(status, {
    "Content-Type": type,
    ...(origin && ALLOWED_ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  });
  res.end(type === "application/json" && typeof body !== "string" ? JSON.stringify(body) : body);
}

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

const authorized = (req) => db.accessTokens.includes((req.headers.authorization ?? "").replace(/^Bearer /, ""));

function issueTokens(withRefresh) {
  const access = `mock-at-${id()}`;
  db.accessTokens.push(access);
  const out = { access_token: access, expires_in: 3600, token_type: "Bearer" };
  if (withRefresh) {
    out.refresh_token = `mock-rt-${id()}`;
    db.refreshTokens.push(out.refresh_token);
  }
  save();
  return out;
}

/** multipart/related 본문에서 (메타데이터 JSON, 파일 내용)을 꺼낸다 */
function parseMultipart(buf, contentType) {
  const boundary = Buffer.from(`--${/boundary=([^;]+)/.exec(contentType)[1]}`);
  const parts = [];
  let start = buf.indexOf(boundary) + boundary.length;
  for (;;) {
    const next = buf.indexOf(boundary, start);
    if (next < 0) break;
    const part = buf.subarray(start, next);
    const sep = part.indexOf("\r\n\r\n");
    parts.push(part.subarray(sep + 4, part.length - 2)); // 끝의 \r\n 제외
    start = next + boundary.length;
  }
  return { metadata: JSON.parse(parts[0].toString("utf8")), content: parts[1] };
}

const DEVICE_PAGE = (msg = "") => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>모의 Google 로그인</title>
<body style="font-family:system-ui;max-width:420px;margin:60px auto;padding:0 16px">
<h2>모의 Google 기기 로그인</h2><p>${msg || "앱에 표시된 코드를 입력하고 승인하세요."}</p>
<form method="post" action="/device"><input name="code" placeholder="ABCD-EFGH" style="font-size:20px;padding:8px;width:100%">
<button style="margin-top:12px;font-size:16px;padding:8px 16px">${ACCOUNT.email} 로 승인</button></form></body>`;

createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const path = url.pathname;
  // 허용되지 않은 웹사이트에서 보낸 요청(CSRF)은 거부. curl 등 Origin 이 없는 로컬 도구는 허용.
  if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) return send(res, 403, { error: "origin not allowed" });
  if (req.method === "OPTIONS") return send(res, 204, "");

  try {
    // ---- OAuth (기기 코드) ----
    if (req.method === "POST" && path === "/device/code") {
      const deviceCode = id();
      const userCode = `${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}`.toUpperCase();
      devices.set(deviceCode, { userCode, approved: false });
      return send(res, 200, { device_code: deviceCode, user_code: userCode, verification_url: `${BASE}/device`, expires_in: 600, interval: 1 });
    }
    if (path === "/device") {
      if (req.method === "GET") return send(res, 200, DEVICE_PAGE(), "text/html; charset=utf-8");
      const code = new URLSearchParams((await readBody(req)).toString()).get("code")?.trim().toUpperCase();
      const entry = [...devices.values()].find((d) => d.userCode === code);
      if (entry) entry.approved = true;
      return send(res, 200, DEVICE_PAGE(entry ? "승인했습니다. 앱으로 돌아가세요." : "코드를 찾을 수 없습니다."), "text/html; charset=utf-8");
    }
    if (req.method === "POST" && path === "/token") {
      const p = new URLSearchParams((await readBody(req)).toString());
      if (p.get("grant_type") === "refresh_token") {
        if (!db.refreshTokens.includes(p.get("refresh_token"))) return send(res, 400, { error: "invalid_grant" });
        return send(res, 200, issueTokens(false));
      }
      const d = devices.get(p.get("device_code"));
      if (!d) return send(res, 400, { error: "expired_token" });
      if (!d.approved) return send(res, 428, { error: "authorization_pending" });
      devices.delete(p.get("device_code"));
      return send(res, 200, issueTokens(true));
    }
    if (req.method === "POST" && path === "/revoke") return send(res, 200, {});

    // ---- 디버그 ----
    if (path === "/debug/files") {
      return send(res, 200, Object.values(db.files).map((f) => ({ ...meta(f), bytes: Buffer.from(f.data, "base64").length })));
    }
    if (req.method === "POST" && path === "/debug/expire-tokens") {
      db.accessTokens = [];
      save();
      return send(res, 200, { ok: true });
    }

    // ---- 여기부터는 인증 필요 ----
    if (!authorized(req)) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });

    if (path === "/oauth2/v3/userinfo") return send(res, 200, ACCOUNT);

    if (req.method === "GET" && path === "/drive/v3/files") {
      return send(res, 200, { files: Object.values(db.files).map(meta) });
    }
    if (req.method === "GET" && path === "/drive/v3/changes/startPageToken") {
      return send(res, 200, { startPageToken: String(db.log.length + 1) });
    }
    if (req.method === "GET" && path === "/drive/v3/changes") {
      const from = Number(url.searchParams.get("pageToken"));
      const latest = new Map();
      db.log.slice(from - 1).forEach((c) => latest.set(c.fileId, c));
      const changes = [...latest.values()].map((c) =>
        c.removed || !db.files[c.fileId] ? { fileId: c.fileId, removed: true } : { fileId: c.fileId, removed: false, file: meta(db.files[c.fileId]) },
      );
      return send(res, 200, { changes, newStartPageToken: String(db.log.length + 1) });
    }

    const fileMatch = /^\/(upload\/)?drive\/v3\/files(?:\/([^/]+))?$/.exec(path);
    if (fileMatch) {
      const [, upload, fileId] = fileMatch;
      const file = fileId && db.files[fileId];
      if (req.method === "POST" && upload) {
        const { metadata, content } = parseMultipart(await readBody(req), req.headers["content-type"]);
        const f = { id: id(), name: metadata.name, version: 1, data: content.toString("base64") };
        db.files[f.id] = f;
        logChange(f.id, false);
        save();
        return send(res, 200, meta(f));
      }
      if (!file) return send(res, 404, { error: { code: 404, message: "File not found" } });
      if (req.method === "GET" && url.searchParams.get("alt") === "media") {
        return send(res, 200, Buffer.from(file.data, "base64"), "application/octet-stream");
      }
      if (req.method === "PATCH" && upload) {
        file.data = (await readBody(req)).toString("base64");
        file.version++;
        logChange(file.id, false);
        save();
        return send(res, 200, meta(file));
      }
      if (req.method === "DELETE") {
        delete db.files[file.id];
        logChange(file.id, true);
        save();
        return send(res, 204, "");
      }
    }
    send(res, 404, { error: { code: 404, message: `Not found: ${req.method} ${path}` } });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: { code: 500, message: String(e) } });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`mock Google Drive listening on ${BASE}`));
