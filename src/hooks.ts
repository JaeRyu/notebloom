import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { indexReady, readPages, subscribePages } from "./store/notes";
import type { Page } from "./types";

/** 전체 페이지 목록 (로컬 index 문서, 다른 기기 변경도 동기화되면 자동 반영). 불러오기 전에는 null */
export function usePages(): Page[] | null {
  const [pages, setPages] = useState<Page[] | null>(null);
  useEffect(() => {
    let alive = true;
    indexReady.then(() => alive && setPages(readPages()));
    const unsub = subscribePages((p) => alive && setPages(p));
    return () => {
      alive = false;
      unsub();
    };
  }, []);
  return pages;
}

export interface PageTree {
  byId: Map<string, Page>;
  children: Map<string | null, Page[]>;
  /** 자신 또는 조상이 휴지통에 있는 페이지 */
  hidden: Set<string>;
}

export function usePageTree(pages: Page[] | null): PageTree {
  return useMemo(() => {
    const byId = new Map<string, Page>();
    for (const p of pages ?? []) byId.set(p.id, p);

    // 부모가 없거나, 두 기기에서 동시에 옮겨 순환이 생긴 페이지는 최상위로 올린다.
    const parentOf = (p: Page) => (p.parentId && byId.has(p.parentId) ? p.parentId : null);
    const reachable = new Set<string>();
    const childMap = new Map<string | null, Page[]>();
    for (const p of pages ?? []) {
      const parent = parentOf(p);
      childMap.set(parent, [...(childMap.get(parent) ?? []), p]);
    }
    const walk = (id: string | null) => {
      for (const c of childMap.get(id) ?? []) {
        if (reachable.has(c.id)) continue;
        reachable.add(c.id);
        walk(c.id);
      }
    };
    walk(null);
    for (const p of pages ?? []) {
      if (reachable.has(p.id)) continue;
      const parent = parentOf(p);
      childMap.set(parent, (childMap.get(parent) ?? []).filter((x) => x.id !== p.id));
      childMap.set(null, [...(childMap.get(null) ?? []), p]);
      reachable.add(p.id);
      walk(p.id);
    }
    for (const list of childMap.values()) list.sort((a, b) => a.order - b.order);

    const hidden = new Set<string>();
    const visit = (parent: string | null, parentHidden: boolean, seen: Set<string>) => {
      for (const p of childMap.get(parent) ?? []) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const h = parentHidden || p.archived;
        if (h) hidden.add(p.id);
        visit(p.id, h, seen);
      }
    };
    visit(null, false, new Set());
    return { byId, children: childMap, hidden };
  }, [pages]);
}

/** 루트부터 pid 까지의 경로 */
export function ancestorsOf(pid: string, tree: PageTree): Page[] {
  const out: Page[] = [];
  const seen = new Set<string>();
  let cur = tree.byId.get(pid);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? tree.byId.get(cur.parentId) : undefined;
  }
  return out;
}

// ---- 해시 라우팅: #/p/{pageId} (Tauri 에서도 동작) ----

function subscribeHash(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useRoute() {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  return useMemo(() => ({ pid: hash.match(/^#\/p\/([^/]+)/)?.[1] }), [hash]);
}

export function navigate(pid?: string) {
  location.hash = pid ? `#/p/${pid}` : "#/";
}

// ---- 기타 ----

function subscribeScheme(cb: () => void) {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export function useColorScheme(): "light" | "dark" {
  return useSyncExternalStore(subscribeScheme, () =>
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
}

function subscribeResize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

export function useIsMobile() {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth < 768);
}

export function pageTitle(p: Page | undefined) {
  return p?.title.trim() || "제목 없음";
}
