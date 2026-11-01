import { useSyncExternalStore } from "react";
import * as Y from "yjs";
import { storageGet, storageSet } from "../platform";
import { acquireDoc, clearAllLocalDocs, deleteLocalDoc, INDEX_DOC, noteDocName, onLocalChange, pageIdOf, SYNC_ORIGIN } from "../store/docs";
import { onPagesDeleted, readPages } from "../store/notes";
import type { Account } from "../types";
import { getAccessToken, getAuthState, signIn, signOut } from "./auth";
import { AuthError, DriveClient, NotFoundError, type RemoteFile } from "./drive";

/**
 * Google Drive 동기화 엔진.
 *
 * 1. 로컬 편집이 생기면 해당 문서를 dirty 로 표시하고 잠시 후(1.5초) 동기화한다.
 * 2. 앱이 화면에 보이는 동안 5초마다 Drive 변경 목록(changes API)을 확인해 다른 기기의 저장을 감지한다.
 * 3. 문서 동기화 = 원격 파일 다운로드 → 로컬 Yjs 문서에 병합 → 로컬에만 있는 내용이 있으면 업로드.
 *    Yjs(CRDT)라서 병합 순서와 무관하게 결과가 같고, 같은 내용을 여러 번 병합해도 안전하다.
 *    두 기기가 동시에 업로드해 한쪽이 덮어써져도, 덮어써진 기기가 다음 확인 때 차이를 발견하고 다시 올리므로
 *    결국 모든 기기의 편집이 합쳐진다.
 */

const POLL_MS = 5_000;
const DEBOUNCE_MS = 1_500;
const CONCURRENCY = 4;

export type SyncPhase = "local" | "idle" | "syncing" | "offline" | "error" | "reconnect";

export interface SyncStatus {
  phase: SyncPhase;
  lastSyncedAt: number | null;
  error: string | null;
  /** 아직 업로드되지 않은 문서 수 */
  pending: number;
}

interface SyncMeta {
  pageToken?: string;
  /** 문서 이름 → 마지막으로 병합/업로드한 Drive 파일 버전 */
  files: Record<string, { id: string; version: string }>;
}

const fileNameOf = (docName: string) => `${docName}.yjs`;
const docNameOf = (fileName: string) => (fileName.endsWith(".yjs") ? fileName.slice(0, -4) : null);
const metaKey = (email: string) => `notebloom:sync:${email}`;
const DIRTY_KEY = "notebloom:dirty";
const PENDING_DELETES_KEY = "notebloom:pendingDeletes";
const LINKED_KEY = "notebloom:linkedAccount";

/** 서버에 닿지 못한 경우(브라우저 fetch / Tauri HTTP 플러그인의 네트워크 오류) */
const isNetworkError = (message: string) => /failed to fetch|networkerror|load failed|error sending request|connect/i.test(message);

class SyncEngine {
  private drive: DriveClient | null = null;
  private email: string | null = null;
  private meta: SyncMeta = { files: {} };
  private dirty = new Set<string>(storageGet<string[]>(DIRTY_KEY, []));
  private pendingDeletes = new Set<string>(storageGet<string[]>(PENDING_DELETES_KEY, []));
  /** 이번 확인에서 바뀐 것으로 보이는 원격 파일 (문서 이름 → 파일, 같은 이름이 여럿이면 배열) */
  private remoteChanged = new Map<string, RemoteFile[]>();
  /** 다른 기기에서 삭제된 것으로 보이는 문서 */
  private remoteRemoved = new Set<string>();
  /** 문서별 로컬 편집 횟수 (업로드 도중 새 편집이 생겼는지 판별) */
  private generation = new Map<string, number>();
  private running: Promise<void> | null = null;
  private rerun = false;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  private status: SyncStatus = { phase: "local", lastSyncedAt: null, error: null, pending: this.dirty.size };
  private listeners = new Set<() => void>();

  constructor() {
    onLocalChange((name) => this.markDirty(name));
    onPagesDeleted((names) => this.queueDeletes(names));
    window.addEventListener("online", () => this.syncSoon(0));
    window.addEventListener("offline", () => this.drive && this.setStatus({ phase: "offline" }));
    window.addEventListener("focus", () => this.syncSoon(0));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.syncSoon(0);
    });
  }

  // ---- 상태 -------------------------------------------------------------

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getStatus = () => this.status;

  private setStatus(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch, pending: this.dirty.size };
    this.listeners.forEach((l) => l());
  }

  get connected() {
    return this.drive !== null;
  }

  // ---- 시작 / 중지 ------------------------------------------------------

  start(account: Account) {
    this.email = account.email;
    this.meta = storageGet<SyncMeta>(metaKey(account.email), { files: {} });
    this.drive = new DriveClient(getAccessToken);
    // 이 계정과 처음 동기화하면 기기의 모든 노트를 올린다.
    if (!this.meta.pageToken) this.markAllDirty();
    this.setStatus({ phase: "idle", error: null });
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") this.sync();
    }, POLL_MS);
    this.syncSoon(0);
  }

  stop() {
    this.drive = null;
    this.email = null;
    clearInterval(this.pollTimer);
    clearTimeout(this.debounceTimer);
    this.setStatus({ phase: "local", error: null });
  }

  // ---- 변경 추적 --------------------------------------------------------

  private markDirty(name: string) {
    this.generation.set(name, (this.generation.get(name) ?? 0) + 1);
    if (!this.dirty.has(name)) {
      this.dirty.add(name);
      this.persistDirty();
    }
    this.setStatus({});
    this.syncSoon(DEBOUNCE_MS);
  }

  private markAllDirty() {
    this.dirty.add(INDEX_DOC);
    readPages().forEach((p) => this.dirty.add(noteDocName(p.id)));
    this.persistDirty();
  }

  private queueDeletes(names: string[]) {
    names.forEach((n) => {
      this.pendingDeletes.add(n);
      this.dirty.delete(n);
    });
    this.persistDirty();
    this.syncSoon(0);
  }

  private persistDirty() {
    storageSet(DIRTY_KEY, [...this.dirty]);
    storageSet(PENDING_DELETES_KEY, [...this.pendingDeletes]);
  }

  private persistMeta() {
    if (this.email) storageSet(metaKey(this.email), this.meta);
  }

  // ---- 동기화 -----------------------------------------------------------

  syncSoon(delay: number) {
    if (!this.drive) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.sync(), delay);
  }

  /** 동기화 1회 실행. 이미 실행 중이면 끝난 뒤 한 번 더 실행하고, 그 완료를 기다린다. */
  sync(): Promise<void> {
    if (!this.drive) return Promise.resolve();
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.runLoop().finally(() => (this.running = null));
    return this.running;
  }

  private async runLoop() {
    if (!navigator.onLine) {
      this.setStatus({ phase: "offline" });
      return;
    }
    this.setStatus({ phase: "syncing" });
    try {
      do {
        this.rerun = false;
        await this.syncOnce();
      } while (this.rerun && this.drive);
      this.setStatus({ phase: this.drive ? "idle" : "local", lastSyncedAt: Date.now(), error: null });
    } catch (e) {
      console.warn("[sync]", e);
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof AuthError || getAuthState().needsReconnect) this.setStatus({ phase: "reconnect", error: message });
      else if (!navigator.onLine || isNetworkError(message)) this.setStatus({ phase: "offline", error: null });
      else this.setStatus({ phase: "error", error: message });
    }
  }

  private async syncOnce() {
    const drive = this.drive;
    if (!drive) return;

    const newToken = await this.pullRemoteChanges(drive);

    const names = new Set<string>(this.dirty);
    for (const [name, files] of this.remoteChanged) {
      const known = this.meta.files[name];
      if (files.length > 1 || files[0].id !== known?.id || files[0].version !== known.version) names.add(name);
      else this.remoteChanged.delete(name); // 내가 올린 버전 그대로
    }

    // 1) 페이지 목록을 먼저 맞춰야 새 페이지와 삭제된 페이지를 알 수 있다.
    if (names.delete(INDEX_DOC)) await this.syncDoc(drive, INDEX_DOC);

    // 2) 목록에서 사라진 페이지(다른 기기에서 영구 삭제)는 이 기기에서도 지우고 다시 올리지 않는다.
    const live = new Set(readPages().map((p) => noteDocName(p.id)));
    for (const name of this.remoteRemoved) {
      delete this.meta.files[name];
      if (live.has(name)) names.add(name); // 아직 목록에 있으면 다시 올린다.
      else await deleteLocalDoc(name);
    }
    this.remoteRemoved.clear();
    for (const name of names) {
      if (pageIdOf(name) && !live.has(name)) {
        names.delete(name);
        this.dirty.delete(name);
        this.remoteChanged.delete(name);
      }
    }

    // 3) 이 기기에서 영구 삭제한 페이지의 Drive 파일 삭제 (목록 업로드 뒤에 해야 다른 기기가 되살리지 않는다)
    await this.processDeletes(drive);

    // 4) 나머지 노트 본문
    const queue = [...names];
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (let name = queue.shift(); name; name = queue.shift()) {
          if (this.drive !== drive) return;
          await this.syncDoc(drive, name);
        }
      }),
    );

    // 이번 변경분을 모두 반영한 뒤에만 다음 확인 위치를 저장한다 (중간에 실패하면 다음에 다시 받는다).
    this.meta.pageToken = newToken;
    this.persistMeta();
  }

  /** Drive 에서 바뀐 파일 목록을 가져와 remoteChanged/remoteRemoved 에 쌓고, 다음 확인 위치(토큰)를 반환한다. */
  private async pullRemoteChanges(drive: DriveClient): Promise<string> {
    const add = (f: RemoteFile) => {
      const name = docNameOf(f.name);
      if (!name) return;
      const list = (this.remoteChanged.get(name) ?? []).filter((x) => x.id !== f.id);
      this.remoteChanged.set(name, [...list, f]);
    };

    if (!this.meta.pageToken) {
      // 처음: 시작 토큰을 먼저 받고 전체 목록을 읽는다 (목록을 읽는 사이의 변경은 다음 확인 때 잡힌다).
      const token = await drive.startPageToken();
      (await drive.listAll()).forEach(add);
      return token;
    }
    const { changes, newToken } = await drive.changes(this.meta.pageToken);
    const idToName = new Map(Object.entries(this.meta.files).map(([n, f]) => [f.id, n]));
    for (const c of changes) {
      if (c.removed || c.file?.trashed) {
        const name = idToName.get(c.fileId);
        if (name) this.remoteRemoved.add(name);
        for (const [n, files] of this.remoteChanged) {
          const rest = files.filter((f) => f.id !== c.fileId);
          if (rest.length) this.remoteChanged.set(n, rest);
          else this.remoteChanged.delete(n);
        }
      } else if (c.file) {
        add(c.file);
      }
    }
    return newToken;
  }

  private async processDeletes(drive: DriveClient) {
    for (const name of [...this.pendingDeletes]) {
      const ids = new Set<string>();
      const known = this.meta.files[name];
      if (known) ids.add(known.id);
      this.remoteChanged.get(name)?.forEach((f) => ids.add(f.id));
      for (const id of ids) await drive.remove(id);
      delete this.meta.files[name];
      this.remoteChanged.delete(name);
      this.pendingDeletes.delete(name);
    }
    this.persistDirty();
    this.persistMeta();
  }

  private async syncDoc(drive: DriveClient, name: string) {
    const lease = acquireDoc(name);
    try {
      await lease.ready;
      const doc = lease.doc;
      const known = this.meta.files[name];
      const changed = this.remoteChanged.get(name) ?? [];
      this.remoteChanged.delete(name);

      // 같은 이름 파일이 여러 개면(두 기기가 처음에 동시에 만든 경우) 모두 병합하고 하나만 남긴다.
      const [primary, ...extras] = [...changed].sort((a, b) => (a.id === known?.id ? -1 : b.id === known?.id ? 1 : a.id.localeCompare(b.id)));
      let target: { id: string; version: string } | null = primary ?? known ?? null;
      let needsUpload = this.dirty.has(name) || !target;

      for (const f of changed) {
        if (f.id === known?.id && f.version === known.version) continue;
        const bytes = await drive.download(f.id);
        const remoteDoc = new Y.Doc();
        Y.applyUpdate(remoteDoc, bytes);
        Y.applyUpdate(doc, bytes, SYNC_ORIGIN);
        if (f === primary) {
          // 원격본에 없는 내용(로컬 편집, 덮어써진 편집)이 남아 있으면 다시 올려야 한다.
          needsUpload = !Y.equalSnapshots(Y.snapshot(remoteDoc), Y.snapshot(doc));
          this.meta.files[name] = { id: f.id, version: f.version };
        }
        remoteDoc.destroy();
      }
      if (extras.length) needsUpload = true;

      if (needsUpload) {
        const gen = this.generation.get(name) ?? 0;
        const bytes = Y.encodeStateAsUpdate(doc);
        let saved: RemoteFile;
        try {
          saved = target ? await drive.update(target.id, bytes) : await drive.create(fileNameOf(name), bytes);
        } catch (e) {
          if (!(e instanceof NotFoundError) || !target) throw e;
          target = null; // 원격 파일이 사라졌으면 새로 만든다.
          saved = await drive.create(fileNameOf(name), bytes);
        }
        this.meta.files[name] = { id: saved.id, version: saved.version };
        for (const f of extras) await drive.remove(f.id);
        if ((this.generation.get(name) ?? 0) === gen) this.dirty.delete(name);
      } else {
        this.dirty.delete(name);
      }
      this.persistDirty();
      this.persistMeta();
      this.setStatus({});
    } finally {
      lease.release();
    }
  }
}

export const syncEngine = new SyncEngine();

export function useSyncStatus() {
  return useSyncExternalStore(syncEngine.subscribe, syncEngine.getStatus);
}

// ---------------------------------------------------------------------------
// Google Drive 연결 / 해제
// ---------------------------------------------------------------------------

export type AccountSwitchChoice = "merge" | "erase" | null;

/**
 * Google 로그인 후 동기화를 시작한다.
 * 이 기기가 전에 다른 계정과 연결돼 있었다면 기존 노트를 합칠지, 지울지 묻는다.
 */
export async function connectGoogle(confirmSwitch: (oldEmail: string, newEmail: string) => Promise<AccountSwitchChoice>) {
  const account = await signIn();
  const linked = storageGet<string | null>(LINKED_KEY, null);
  if (linked && linked !== account.email) {
    const choice = await confirmSwitch(linked, account.email);
    if (choice === null) {
      signOut();
      return;
    }
    if (choice === "erase") {
      await clearAllLocalDocs([INDEX_DOC, ...readPages().map((p) => noteDocName(p.id))]);
      storageSet(DIRTY_KEY, undefined);
      storageSet(PENDING_DELETES_KEY, undefined);
      storageSet(LINKED_KEY, account.email);
      location.reload();
      return;
    }
  }
  storageSet(LINKED_KEY, account.email);
  syncEngine.start(account);
}

/** 웹에서 토큰이 만료됐을 때 다시 로그인 */
export async function reconnectGoogle() {
  const account = await signIn();
  syncEngine.start(account);
}

/** 동기화를 끊는다. 이 기기의 노트는 그대로 남는다. */
export function disconnectGoogle() {
  syncEngine.stop();
  signOut();
}

/** 앱 시작 시 이전 로그인이 있으면 동기화를 이어간다. */
export function resumeSync() {
  const { account } = getAuthState();
  if (account) syncEngine.start(account);
}
