import { useEffect, useState, type DragEvent } from "react";
import { ancestorsOf, navigate, pageTitle, type PageTree } from "../hooks";
import { storageGet, storageSet } from "../platform";
import { collectSubtree, createPage, updatePage } from "../store/notes";
import { useAuth } from "../sync/auth";
import { useSyncStatus } from "../sync/engine";
import type { Page } from "../types";
import { Avatar, Icon } from "./ui";

const DRAG_TYPE = "application/x-notebloom-page";
const EXPANDED_KEY = "notebloom:expanded";

export function Sidebar({
  pages,
  tree,
  activePageId,
  onSearch,
  onTrash,
  onAccount,
  onNavigate,
}: {
  pages: Page[];
  tree: PageTree;
  activePageId?: string;
  onSearch: () => void;
  onTrash: () => void;
  onAccount: () => void;
  onNavigate: () => void;
}) {
  const { account } = useAuth();
  const sync = useSyncStatus();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(storageGet<string[]>(EXPANDED_KEY, [])));
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const saveExpanded = (next: Set<string>) => {
    setExpanded(next);
    storageSet(EXPANDED_KEY, [...next]);
  };

  // 현재 페이지의 상위 페이지들을 펼쳐서 위치가 보이게 한다.
  useEffect(() => {
    if (!activePageId) return;
    const chain = ancestorsOf(activePageId, tree).slice(0, -1);
    if (chain.every((p) => expanded.has(p.id))) return;
    const next = new Set(expanded);
    chain.forEach((p) => next.add(p.id));
    saveExpanded(next);
  }, [activePageId, tree]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string, open?: boolean) => {
    const next = new Set(expanded);
    if (open ?? !next.has(id)) next.add(id);
    else next.delete(id);
    saveExpanded(next);
  };

  const go = (pid?: string) => {
    navigate(pid);
    onNavigate();
  };

  const addPage = (parentId: string | null) => {
    const id = createPage(parentId);
    if (parentId) toggle(parentId, true);
    go(id);
  };

  const archive = (page: Page) => {
    updatePage(page.id, { archived: true });
    if (activePageId && collectSubtree(page.id, pages).includes(activePageId)) go();
  };

  // ---- 드래그 앤 드롭으로 페이지 계층 이동 ----
  const onDragStart = (e: DragEvent, id: string) => {
    e.dataTransfer.setData(DRAG_TYPE, id);
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (e: DragEvent, target: string) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(target);
  };
  const onDrop = (e: DragEvent, targetId: string | null) => {
    e.preventDefault();
    setDropTarget(null);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    if (!id || id === targetId) return;
    // 자기 자신의 하위 페이지 안으로는 옮길 수 없다.
    if (targetId && collectSubtree(id, pages).includes(targetId)) return;
    if (tree.byId.get(id)?.parentId === targetId) return;
    updatePage(id, { parentId: targetId, order: Date.now() });
    if (targetId) toggle(targetId, true);
  };

  const renderItem = (page: Page, depth: number) => {
    const kids = (tree.children.get(page.id) ?? []).filter((p) => !p.archived);
    const open = expanded.has(page.id);
    return (
      <div key={page.id}>
        <div
          className={`tree-row ${page.id === activePageId ? "active" : ""} ${dropTarget === page.id ? "drop" : ""}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable
          onDragStart={(e) => onDragStart(e, page.id)}
          onDragOver={(e) => onDragOver(e, page.id)}
          onDragLeave={() => setDropTarget((t) => (t === page.id ? null : t))}
          onDrop={(e) => onDrop(e, page.id)}
          onClick={() => go(page.id)}
        >
          <button
            className={`twisty ${open ? "open" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              toggle(page.id);
            }}
            aria-label={open ? "접기" : "펼치기"}
          >
            <Icon name="chevron" size={12} />
          </button>
          <span className="tree-icon">{page.icon || <Icon name="page" size={15} />}</span>
          <span className="tree-title">{pageTitle(page)}</span>
          <span className="row-actions">
            <button
              title="휴지통으로 이동"
              onClick={(e) => {
                e.stopPropagation();
                archive(page);
              }}
            >
              <Icon name="trash" size={14} />
            </button>
            <button
              title="하위 페이지 추가"
              onClick={(e) => {
                e.stopPropagation();
                addPage(page.id);
              }}
            >
              <Icon name="plus" size={14} />
            </button>
          </span>
        </div>
        {open &&
          (kids.length ? (
            kids.map((k) => renderItem(k, depth + 1))
          ) : (
            <div className="tree-empty" style={{ paddingLeft: 32 + depth * 14 }}>
              하위 페이지 없음
            </div>
          ))}
      </div>
    );
  };

  const roots = (tree.children.get(null) ?? []).filter((p) => !p.archived);
  const syncLabel: Record<typeof sync.phase, string> = {
    local: "",
    idle: "동기화됨",
    syncing: "동기화 중…",
    offline: "오프라인",
    error: "동기화 오류",
    reconnect: "다시 연결 필요",
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/icon.svg" alt="" width={22} height={22} />
        <span>Notebloom</span>
      </div>

      <nav className="side-nav">
        <button onClick={onSearch}>
          <Icon name="search" /> 검색 <kbd>Ctrl K</kbd>
        </button>
        <button onClick={() => go()}>
          <Icon name="home" /> 홈
        </button>
      </nav>

      <div className="side-section">
        <div
          className={`side-section-title ${dropTarget === "__root" ? "drop" : ""}`}
          onDragOver={(e) => onDragOver(e, "__root")}
          onDragLeave={() => setDropTarget((t) => (t === "__root" ? null : t))}
          onDrop={(e) => onDrop(e, null)}
          title="여기로 끌어다 놓으면 최상위 페이지가 됩니다"
        >
          <span>노트</span>
          <button className="icon-btn" title="새 노트" onClick={() => addPage(null)}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        <div className="tree">
          {roots.map((p) => renderItem(p, 0))}
          {roots.length === 0 && (
            <button className="tree-add" onClick={() => addPage(null)}>
              <Icon name="plus" size={14} /> 첫 노트 만들기
            </button>
          )}
        </div>
      </div>

      <div className="side-footer">
        <button onClick={onTrash}>
          <Icon name="trash" /> 휴지통
        </button>
        {account ? (
          <button className="me" onClick={onAccount}>
            <Avatar name={account.name} picture={account.picture} />
            <div className="me-text">
              <div className="me-name">{account.name}</div>
              <div className={`me-email ${sync.phase === "error" || sync.phase === "reconnect" ? "warn" : ""}`}>
                Google Drive · {syncLabel[sync.phase]}
              </div>
            </div>
          </button>
        ) : (
          <button className="connect-btn" onClick={onAccount}>
            <Icon name="cloud" /> Google Drive 연결
          </button>
        )}
      </div>
    </aside>
  );
}
