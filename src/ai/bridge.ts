import { useSyncExternalStore } from "react";
import { isTauri, storageGet, storageSet } from "../platform";
import { indexReady } from "../store/notes";

/**
 * AI 도구 연결 (MCP). 데스크톱 앱에서만 동작한다.
 * 네이티브 쪽(src-tauri/src/ai_bridge.rs)이 이 컴퓨터의 MCP 서버로부터 받은 요청을 이벤트로 넘겨주면
 * notes-api.ts 로 처리해 결과를 돌려준다. 설정에서 끌 수 있다.
 */

export interface AiBridgeState {
  /** 이 플랫폼에서 쓸 수 있는지 (데스크톱 앱) */
  available: boolean;
  enabled: boolean;
  error: string | null;
}

const KEY = "notebloom:aiBridge";
let state: AiBridgeState = { available: false, enabled: storageGet<boolean>(KEY, true), error: null };
const listeners = new Set<() => void>();

function setState(patch: Partial<AiBridgeState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useAiBridge() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

interface BridgeRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

async function apply(enabled: boolean) {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("ai_bridge_set_enabled", { enabled });
    setState({ available: true, enabled, error: null });
  } catch (e) {
    const message = String(e);
    // 모바일 앱에서는 지원하지 않는다.
    setState(message === "unsupported" ? { available: false } : { available: true, error: message });
  }
}

let started: Promise<void> | null = null;

/** 앱 시작 시 한 번 호출 */
export function startAiBridge() {
  if (!isTauri) return;
  started ??= (async () => {
    const [{ listen }, { invoke }] = await Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/api/core")]);
    await listen<BridgeRequest>("ai-bridge-request", async ({ payload }) => {
      let response: unknown;
      try {
        const { handle } = await import("./notes-api");
        response = { ok: true, result: await handle(payload.method, payload.params ?? {}) };
      } catch (e) {
        response = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      await invoke("ai_bridge_respond", { id: payload.id, response });
    });
    // 노트 목록을 다 불러온 뒤에 연결을 연다.
    await indexReady;
    await apply(state.enabled);
  })();
}

export async function setAiBridgeEnabled(enabled: boolean) {
  storageSet(KEY, enabled);
  await apply(enabled);
}
