import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { BlockNoteEditor } from "@blocknote/core";
import { ancestorsOf, navigate, pageTitle, useColorScheme, type PageTree } from "../hooks";
import { acquireDoc, noteDocName, onLocalChange } from "../store/docs";
import { createPage, deletePageForever, updatePage } from "../store/notes";
import { syncEngine } from "../sync/engine";
import type { Page } from "../types";
import { Editor } from "./Editor";
import { askConfirm, EmojiPicker, Icon, timeAgo, TopBar } from "./ui";

/** 노트 본문 Y.Doc. 기기에 저장된 내용을 불러온 뒤 반환한다. */
function useNoteDoc(pid: string) {
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  useEffect(() => {
    const lease = acquireDoc(noteDocName(pid));
    let cancelled = false;
    (async () => {
      await lease.ready;
      // 다른 기기에서 만든 노트라 아직 본문이 없으면 Drive 에서 먼저 받아온다 (최대 3초).
      if (lease.doc.getXmlFragment("blocknote").length === 0 && syncEngine.connected) {
        await Promise.race([syncEngine.sync(), new Promise((r) => setTimeout(r, 3000))]);
      }
      if (!cancelled) setDoc(lease.doc);
    })();
    return () => {
      cancelled = true;
      lease.release();
    };
  }, [pid]);
  return doc;
}

function TitleInput({
  value,
  autoFocus,
  readOnly,
  onChange,
  onEnter,
}: {
  value: string;
  autoFocus: boolean;
  readOnly: boolean;
  onChange: (v: string) => void;
  onEnter: () => void;
}) {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const ref = useRef<HTMLTextAreaElement>(null);

  // 다른 기기에서 바뀐 제목은 내가 입력 중이 아닐 때만 반영
  useEffect(() => {
    if (!focused.current) setLocal(value);
  }, [value]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, [local]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const commit = (v: string) => {
    clearTimeout(timer.current);
    if (v !== value) onChange(v);
  };

  return (
    <textarea
      ref={ref}
      className="page-title"
      rows={1}
      placeholder="제목 없음"
      value={local}
      readOnly={readOnly}
      autoFocus={autoFocus}
      enterKeyHint="next"
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        commit(local);
      }}
      onChange={(e) => {
        const v = e.target.value.replace(/\n/g, "");
        setLocal(v);
        clearTimeout(timer.current);
        // 모바일 키보드는 Enter 를 keydown 대신 줄바꿈 입력으로 보내는 경우가 있어 여기서도 본문으로 넘긴다.
        if (e.target.value.includes("\n")) {
          commit(v);
          onEnter();
          return;
        }
        timer.current = setTimeout(() => onChange(v), 400);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          commit(local);
          onEnter();
        }
      }}
    />
  );
}

export function PageView({
  pageId,
  pages,
  tree,
  onToggleSidebar,
  onSyncClick,
}: {
  pageId: string;
  pages: Page[] | null;
  tree: PageTree;
  onToggleSidebar?: () => void;
  onSyncClick: () => void;
}) {
  const page = tree.byId.get(pageId);
  const scheme = useColorScheme();
  const [picking, setPicking] = useState(false);
  const editorRef = useRef<BlockNoteEditor<any, any, any> | null>(null);
  const doc = useNoteDoc(pageId);

  // 본문을 편집하면 '최근 수정' 시각을 갱신 (10초에 한 번)
  useEffect(() => {
    const name = noteDocName(pageId);
    let last = 0;
    return onLocalChange((changed) => {
      if (changed !== name || Date.now() - last < 10_000) return;
      last = Date.now();
      updatePage(pageId);
    });
  }, [pageId]);

  const onEditorReady = useCallback((ed: BlockNoteEditor<any, any, any>) => {
    editorRef.current = ed;
  }, []);

  if (!page) {
    return (
      <>
        <TopBar onToggleSidebar={onToggleSidebar} onSyncClick={onSyncClick} />
        <div className="empty-state">{pages === null ? "불러오는 중…" : "페이지를 찾을 수 없습니다. 삭제되었을 수 있습니다."}</div>
      </>
    );
  }

  const inTrash = tree.hidden.has(page.id);
  const crumbs = ancestorsOf(page.id, tree);
  const children = (tree.children.get(page.id) ?? []).filter((p) => !p.archived);

  const moveToTrash = () => {
    updatePage(page.id, { archived: true });
    navigate(page.parentId && !tree.hidden.has(page.parentId) ? page.parentId : undefined);
  };

  const deleteForever = async () => {
    const ok = await askConfirm(`'${pageTitle(page)}' 페이지와 모든 하위 페이지를 영구 삭제할까요? 모든 기기에서 지워지며 되돌릴 수 없습니다.`, {
      confirmLabel: "영구 삭제",
      danger: true,
    });
    if (!ok) return;
    navigate();
    await deletePageForever(page.id, pages ?? []);
  };

  return (
    <>
      <TopBar
        onToggleSidebar={onToggleSidebar}
        onSyncClick={onSyncClick}
        actions={
          !inTrash && (
            <>
              <button className="icon-btn" title="하위 페이지 추가" onClick={() => navigate(createPage(page.id))}>
                <Icon name="plus" />
              </button>
              <button className="icon-btn" title="휴지통으로 이동" onClick={moveToTrash}>
                <Icon name="trash" />
              </button>
            </>
          )
        }
      >
        {crumbs.map((p, i) => (
          <span key={p.id} className="crumb-wrap">
            {i > 0 && <span className="crumb-sep">/</span>}
            <a className={`crumb ${p.id === page.id ? "current" : ""}`} onClick={() => navigate(p.id)}>
              {p.icon && <span className="crumb-icon">{p.icon}</span>}
              {pageTitle(p)}
            </a>
          </span>
        ))}
      </TopBar>

      <div className="page-scroll">
        {inTrash && (
          <div className="trash-banner">
            {page.archived ? (
              <>
                <span>이 페이지는 휴지통에 있습니다.</span>
                <button className="btn small" onClick={() => updatePage(page.id, { archived: false })}>
                  복원
                </button>
                <button className="btn small" onClick={deleteForever}>
                  영구 삭제
                </button>
              </>
            ) : (
              <span>상위 페이지가 휴지통에 있어 읽기 전용입니다.</span>
            )}
          </div>
        )}

        <div className="page-header">
          <div className="page-icon-row">
            <button className={`page-icon ${page.icon ? "" : "empty"}`} onClick={() => !inTrash && setPicking(true)}>
              {page.icon || "아이콘 추가"}
            </button>
            {picking && (
              <EmojiPicker
                onClose={() => setPicking(false)}
                onPick={(icon) => {
                  setPicking(false);
                  updatePage(page.id, { icon });
                }}
              />
            )}
          </div>
          <TitleInput
            value={page.title}
            autoFocus={page.title === "" && !inTrash}
            readOnly={inTrash}
            onChange={(title) => updatePage(page.id, { title })}
            onEnter={() => editorRef.current?.focus()}
          />
          <div className="page-meta">{timeAgo(page.updatedAt)} 수정</div>
        </div>

        <div className="editor-wrap">
          {doc ? (
            <Editor doc={doc} theme={scheme} editable={!inTrash} onReady={onEditorReady} />
          ) : (
            <div className="editor-loading">본문을 불러오는 중…</div>
          )}
        </div>

        {children.length > 0 && (
          <div className="child-pages">
            <h3>하위 페이지</h3>
            {children.map((c) => (
              <a key={c.id} className="child-page" onClick={() => navigate(c.id)}>
                <span className="child-icon">{c.icon || <Icon name="page" />}</span>
                {pageTitle(c)}
              </a>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
