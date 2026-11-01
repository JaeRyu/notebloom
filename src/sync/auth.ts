import { useSyncExternalStore } from "react";
import { httpFetch, isTauri, storageGet, storageSet } from "../platform";
import type { Account } from "../types";
import { AuthError, GOOGLE_API, usingMockGoogle } from "./drive";

/**
 * Google 로그인 (OAuth 2.0). 요청 권한은 Drive 의 '앱 전용 숨김 폴더'(drive.appdata) 뿐이라
 * 사용자의 다른 Drive 파일에는 접근하지 않는다.
 *
 * - 웹 브라우저: Google Identity Services 팝업 (액세스 토큰 1시간, 만료되면 '다시 연결' 필요)
 * - 앱(Windows/macOS/Android/iOS): 기기 코드 방식. 화면의 코드를 브라우저에서 한 번 입력하면
 *   갱신 토큰으로 계속 로그인이 유지된다. 네이티브 플러그인 없이 모든 플랫폼에서 같은 코드로 동작한다.
 */

const env = import.meta.env;
const MOCK = env.VITE_MOCK_GOOGLE_URL as string | undefined;
const OAUTH = MOCK ?? "https://oauth2.googleapis.com";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const SCOPES = `openid email profile ${DRIVE_SCOPE}`;

export const authFlow: "web" | "device" = isTauri || usingMockGoogle ? "device" : "web";

interface StoredAuth {
  account: Account;
  accessToken?: string;
  expiresAt?: number;
  refreshToken?: string;
}

export interface DevicePrompt {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
}

export interface AuthState {
  account: Account | null;
  /** 웹에서 토큰이 만료되어 사용자가 다시 연결해야 함 */
  needsReconnect: boolean;
  /** 기기 코드 로그인 진행 중일 때 화면에 보여줄 코드 */
  device: DevicePrompt | null;
}

const KEY = "notebloom:auth";
let stored: StoredAuth | null = storageGet<StoredAuth | null>(KEY, null);
let state: AuthState = { account: stored?.account ?? null, needsReconnect: false, device: null };
const listeners = new Set<() => void>();

function setState(patch: Partial<AuthState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function save(next: StoredAuth | null) {
  stored = next;
  storageSet(KEY, next ?? undefined);
  setState({ account: next?.account ?? null, needsReconnect: false });
}

export function useAuth() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

export function getAuthState() {
  return state;
}

async function postForm<T>(url: string, body: Record<string, string>): Promise<{ ok: boolean; data: T }> {
  const res = await httpFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return { ok: res.ok, data: (await res.json()) as T };
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

async function fetchAccount(accessToken: string): Promise<Account> {
  const res = await httpFetch(`${GOOGLE_API}/oauth2/v3/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Google 계정 정보를 가져오지 못했습니다.");
  const info = (await res.json()) as { email: string; name?: string; picture?: string };
  return { email: info.email, name: info.name || info.email.split("@")[0], picture: info.picture };
}

// ---------------------------------------------------------------------------
// 액세스 토큰
// ---------------------------------------------------------------------------

let refreshing: Promise<string> | null = null;

/** 유효한 액세스 토큰. 만료됐으면 갱신 토큰으로 새로 받는다. */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  if (!stored) throw new AuthError("로그인되어 있지 않습니다.");
  if (!forceRefresh && stored.accessToken && (stored.expiresAt ?? 0) > Date.now() + 60_000) {
    return stored.accessToken;
  }
  if (!stored.refreshToken) {
    // 웹 방식은 갱신 토큰이 없으므로 사용자가 버튼을 눌러 다시 연결해야 한다.
    setState({ needsReconnect: true });
    throw new AuthError("Google 연결이 만료되었습니다.");
  }
  refreshing ??= (async () => {
    try {
      const { ok, data } = await postForm<TokenResponse>(`${OAUTH}/token`, {
        client_id: env.VITE_GOOGLE_DEVICE_CLIENT_ID ?? "mock",
        client_secret: env.VITE_GOOGLE_DEVICE_CLIENT_SECRET ?? "mock",
        refresh_token: stored!.refreshToken!,
        grant_type: "refresh_token",
      });
      if (!ok || !data.access_token) {
        setState({ needsReconnect: true });
        throw new AuthError(data.error_description || "Google 연결이 만료되었습니다.");
      }
      save({ ...stored!, accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
      return data.access_token;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ---------------------------------------------------------------------------
// 로그인 / 로그아웃
// ---------------------------------------------------------------------------

let cancelDevice: (() => void) | null = null;

/** 대화형 로그인. 성공하면 계정 정보를 반환한다. */
export async function signIn(): Promise<Account> {
  const result = authFlow === "web" ? await signInWeb() : await signInDevice();
  const account = await fetchAccount(result.accessToken);
  save({ account, ...result });
  return account;
}

export function cancelSignIn() {
  cancelDevice?.();
}

export function signOut() {
  const token = stored?.refreshToken ?? stored?.accessToken;
  if (token && !MOCK) {
    // 권한 철회는 실패해도 무시 (로컬 토큰은 어쨌든 지운다)
    postForm(`${OAUTH}/revoke`, { token }).catch(() => {});
  }
  save(null);
}

// ---- 기기 코드 방식 (앱) -----------------------------------------------------

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
  error?: string;
}

async function signInDevice() {
  const clientId = env.VITE_GOOGLE_DEVICE_CLIENT_ID ?? (MOCK ? "mock" : "");
  const clientSecret = env.VITE_GOOGLE_DEVICE_CLIENT_SECRET ?? (MOCK ? "mock" : "");
  if (!clientId) throw new Error("VITE_GOOGLE_DEVICE_CLIENT_ID 가 설정되지 않았습니다. README 를 참고하세요.");

  const { ok, data: code } = await postForm<DeviceCodeResponse>(`${OAUTH}/device/code`, {
    client_id: clientId,
    scope: SCOPES,
  });
  if (!ok) throw new Error(`로그인을 시작하지 못했습니다 (${code.error ?? "unknown"}).`);

  const expiresAt = Date.now() + code.expires_in * 1000;
  setState({ device: { userCode: code.user_code, verificationUrl: code.verification_url, expiresAt } });

  let cancelled = false;
  cancelDevice = () => (cancelled = true);
  let interval = code.interval * 1000;
  try {
    while (Date.now() < expiresAt) {
      await new Promise((r) => setTimeout(r, interval));
      if (cancelled) throw new Error("로그인을 취소했습니다.");
      const { data } = await postForm<TokenResponse>(`${OAUTH}/token`, {
        client_id: clientId,
        client_secret: clientSecret,
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (data.access_token) {
        return {
          accessToken: data.access_token,
          expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
          refreshToken: data.refresh_token,
        };
      }
      if (data.error === "authorization_pending") continue;
      if (data.error === "slow_down") {
        interval += 5000;
        continue;
      }
      if (data.error === "access_denied") throw new Error("Google 에서 접근을 거부했습니다.");
      throw new Error(data.error_description || data.error || "로그인에 실패했습니다.");
    }
    throw new Error("코드 입력 시간이 지났습니다. 다시 시도하세요.");
  } finally {
    cancelDevice = null;
    setState({ device: null });
  }
}

// ---- Google Identity Services (웹) ------------------------------------------

interface GisTokenResponse {
  access_token: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

interface GisTokenClient {
  requestAccessToken(opts?: { prompt?: string; login_hint?: string }): void;
}

interface GisOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (resp: GisTokenResponse) => void;
    error_callback?: (err: { type: string; message?: string }) => void;
  }): GisTokenClient;
  hasGrantedAllScopes(resp: GisTokenResponse, ...scopes: string[]): boolean;
}

declare global {
  interface Window {
    google?: { accounts: { oauth2: GisOAuth2 } };
  }
}

let gisLoading: Promise<GisOAuth2> | null = null;

function loadGis(): Promise<GisOAuth2> {
  gisLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve(window.google!.accounts.oauth2);
    s.onerror = () => {
      gisLoading = null;
      reject(new Error("Google 로그인 스크립트를 불러오지 못했습니다."));
    };
    document.head.appendChild(s);
  });
  return gisLoading;
}

async function signInWeb() {
  const clientId = env.VITE_GOOGLE_WEB_CLIENT_ID;
  if (!clientId) throw new Error("VITE_GOOGLE_WEB_CLIENT_ID 가 설정되지 않았습니다. README 를 참고하세요.");
  const oauth2 = await loadGis();
  const resp = await new Promise<GisTokenResponse>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r)),
      error_callback: (err) => reject(new Error(err.type === "popup_closed" ? "로그인 창이 닫혔습니다." : err.message)),
    });
    client.requestAccessToken({ prompt: stored ? "" : "consent", login_hint: stored?.account.email });
  });
  if (!oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
    throw new Error("Google Drive 앱 데이터 접근 권한을 허용해야 동기화할 수 있습니다.");
  }
  return { accessToken: resp.access_token, expiresAt: Date.now() + resp.expires_in * 1000, refreshToken: undefined };
}
