import * as Y from "yjs";
import { clearDocument, IndexeddbPersistence } from "y-indexeddb";

/**
 * 모든 데이터는 Yjs 문서(CRDT)로 저장된다.
 *   "index"       페이지 목록/계층/제목 (사이드바)
 *   "note-{id}"   페이지 본문
 * 각 문서는 기기의 IndexedDB 에 즉시 저장되므로 오프라인에서도 동작하고,
 * 동기화 엔진이 같은 문서를 Google Drive 의 파일과 병합한다.
 */

export const INDEX_DOC = "index";
export const noteDocName = (pageId: string) => `note-${pageId}`;
export const pageIdOf = (docName: string) => (docName.startsWith("note-") ? docName.slice(5) : null);

/** Drive 에서 받아 병합한 변경임을 표시하는 origin (로컬 변경으로 취급하지 않음) */
export const SYNC_ORIGIN = Symbol("drive-sync");

const DB_PREFIX = "notebloom-";

interface Entry {
  doc: Y.Doc;
  persistence: IndexeddbPersistence;
  ready: Promise<void>;
  refs: number;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

export interface DocLease {
  doc: Y.Doc;
  /** IndexedDB 에서 저장된 내용을 다 불러오면 resolve */
  ready: Promise<void>;
  release: () => void;
}

const entries = new Map<string, Entry>();
const localChangeListeners = new Set<(docName: string) => void>();

/** 사용자가 직접 편집한 변경(동기화/로드 제외)이 생길 때마다 호출 */
export function onLocalChange(cb: (docName: string) => void) {
  localChangeListeners.add(cb);
  return () => {
    localChangeListeners.delete(cb);
  };
}

/**
 * 문서를 열어 사용한다. 같은 문서는 하나의 Y.Doc 인스턴스를 공유한다(에디터와 동기화 엔진이 동시에 써도 안전).
 * 다 쓰면 release() 를 호출해야 한다.
 */
export function acquireDoc(name: string): DocLease {
  let entry = entries.get(name);
  if (!entry) {
    const doc = new Y.Doc();
    const persistence = new IndexeddbPersistence(DB_PREFIX + name, doc);
    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin === SYNC_ORIGIN || origin === persistence) return;
      localChangeListeners.forEach((l) => l(name));
    });
    entry = { doc, persistence, ready: persistence.whenSynced.then(() => undefined), refs: 0 };
    entries.set(name, entry);
  }
  const e = entry;
  e.refs++;
  clearTimeout(e.releaseTimer);

  let released = false;
  return {
    doc: e.doc,
    ready: e.ready,
    release: () => {
      if (released) return;
      released = true;
      e.refs--;
      if (e.refs > 0 || name === INDEX_DOC) return;
      // 금방 다시 열 수 있으니 잠시 뒤에 닫는다.
      e.releaseTimer = setTimeout(() => {
        if (e.refs > 0) return;
        entries.delete(name);
        e.persistence.destroy();
        e.doc.destroy();
      }, 10_000);
    },
  };
}

/** 이 기기에서 문서를 지운다 (영구 삭제 시) */
export async function deleteLocalDoc(name: string) {
  const entry = entries.get(name);
  if (entry) {
    entries.delete(name);
    clearTimeout(entry.releaseTimer);
    await entry.persistence.clearData();
    entry.doc.destroy();
  } else {
    await clearDocument(DB_PREFIX + name);
  }
}

/** 이 기기의 모든 노트 데이터를 지운다 (다른 Google 계정으로 바꿀 때) */
export async function clearAllLocalDocs(knownNames: string[]) {
  const names = new Set(knownNames.map((n) => DB_PREFIX + n));
  try {
    for (const db of await indexedDB.databases()) {
      if (db.name?.startsWith(DB_PREFIX)) names.add(db.name);
    }
  } catch {
    /* databases() 를 지원하지 않는 환경이면 아는 문서만 지운다 */
  }
  for (const e of entries.values()) e.persistence.destroy();
  entries.clear();
  await Promise.all([...names].map((n) => clearDocument(n)));
}
