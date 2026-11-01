import * as Y from "yjs";
import type { Page } from "../types";
import { acquireDoc, deleteLocalDoc, INDEX_DOC, noteDocName } from "./docs";

/**
 * 페이지 목록(index 문서).  pages: Y.Map<pageId, Y.Map<필드>>
 * 필드별로 Y.Map 을 쓰므로, 두 기기에서 제목과 아이콘을 동시에 바꿔도 둘 다 유지된다.
 */

const index = acquireDoc(INDEX_DOC);
export const indexReady = index.ready;
const pagesMap = () => index.doc.getMap<Y.Map<unknown>>("pages");

function toPage(id: string, m: Y.Map<unknown>): Page {
  return {
    id,
    title: (m.get("title") as string) ?? "",
    icon: (m.get("icon") as string) ?? "",
    parentId: (m.get("parentId") as string | null) ?? null,
    order: (m.get("order") as number) ?? 0,
    archived: Boolean(m.get("archived")),
    createdAt: (m.get("createdAt") as number) ?? 0,
    updatedAt: (m.get("updatedAt") as number) ?? 0,
  };
}

export function readPages(): Page[] {
  const out: Page[] = [];
  pagesMap().forEach((m, id) => {
    if (m instanceof Y.Map) out.push(toPage(id, m));
  });
  return out;
}

export function subscribePages(cb: (pages: Page[]) => void) {
  const map = pagesMap();
  const handler = () => cb(readPages());
  map.observeDeep(handler);
  return () => map.unobserveDeep(handler);
}

function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

export function createPage(parentId: string | null, title = "") {
  const id = newId();
  const now = Date.now();
  index.doc.transact(() => {
    const m = new Y.Map<unknown>();
    pagesMap().set(id, m);
    m.set("title", title);
    m.set("icon", "");
    m.set("parentId", parentId);
    m.set("order", now);
    m.set("archived", false);
    m.set("createdAt", now);
    m.set("updatedAt", now);
  });
  return id;
}

type PagePatch = Partial<Pick<Page, "title" | "icon" | "parentId" | "order" | "archived">>;

/** 메타데이터 변경. patch 가 비어 있으면 '최근 수정' 시각만 갱신한다. */
export function updatePage(id: string, patch: PagePatch = {}) {
  const m = pagesMap().get(id);
  if (!(m instanceof Y.Map)) return;
  index.doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (m.get(k) !== v) m.set(k, v);
    }
    m.set("updatedAt", Date.now());
  });
}

/** id 와 그 하위 페이지 id 전부 */
export function collectSubtree(id: string, pages: Page[]): string[] {
  const children = new Map<string, string[]>();
  for (const p of pages) {
    if (!p.parentId) continue;
    children.set(p.parentId, [...(children.get(p.parentId) ?? []), p.id]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    stack.push(...(children.get(cur) ?? []));
  }
  return out;
}

const deletedListeners = new Set<(docNames: string[]) => void>();

/** 페이지가 영구 삭제되면 호출 (동기화 엔진이 Drive 파일을 지우는 데 사용) */
export function onPagesDeleted(cb: (docNames: string[]) => void) {
  deletedListeners.add(cb);
  return () => {
    deletedListeners.delete(cb);
  };
}

/** 페이지와 모든 하위 페이지를 이 기기와 Drive 에서 영구 삭제 */
export async function deletePageForever(id: string, pages: Page[]) {
  const ids = collectSubtree(id, pages);
  index.doc.transact(() => ids.forEach((pid) => pagesMap().delete(pid)));
  const names = ids.map(noteDocName);
  deletedListeners.forEach((l) => l(names));
  await Promise.all(names.map(deleteLocalDoc));
}
