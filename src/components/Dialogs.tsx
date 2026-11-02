import { useMemo, useState } from "react";
import { setAiBridgeEnabled, useAiBridge } from "../ai/bridge";
import { ancestorsOf, navigate, pageTitle, type PageTree } from "../hooks";
import { openExternal } from "../platform";
import { deletePageForever, updatePage } from "../store/notes";
import { authFlow, cancelSignIn, useAuth } from "../sync/auth";
import { usingMockGoogle } from "../sync/drive";
import { connectGoogle, disconnectGoogle, reconnectGoogle, syncEngine, useSyncStatus } from "../sync/engine";
import type { Page } from "../types";
import { askChoice, askConfirm, Avatar, Icon, Modal, timeAgo } from "./ui";

// ---------------------------------------------------------------------------
// Google Drive 연결 / 동기화 상태
// ---------------------------------------------------------------------------

export function AccountDialog({ onClose }: { onClose: () => void }) {
  const { account, device, needsReconnect } = useAuth();
  const sync = useSyncStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = () =>
    run(() =>
      connectGoogle((oldEmail, newEmail) =>
        askChoice(
          `이 기기의 노트는 ${oldEmail} 계정과 동기화되던 것입니다. ${newEmail} 계정의 노트와 합칠까요, 아니면 이 기기의 노트를 지우고 새 계정의 노트만 받을까요?`,
          [
            { value: "erase", label: "기기 노트 지우기", kind: "danger" },
            { value: "merge", label: "합치기", kind: "primary" },
          ],
        ),
      ),
    );

  const disconnect = async () => {
    const ok = await askConfirm("Google Drive 동기화를 끊을까요? 이 기기의 노트는 그대로 남고, Drive 의 데이터도 지워지지 않습니다.", {
      confirmLabel: "연결 해제",
    });
    if (ok) disconnectGoogle();
  };

  if (device) {
    return (
      // 브라우저에서 코드를 입력하고 돌아와 창을 클릭할 때 로그인이 취소되지 않도록 바깥 클릭으로는 닫지 않는다.
      <Modal title="Google 계정 연결" onClose={cancelSignIn} width={440} dismissible={false}>
        <div className="dialog-body device-login">
          <p>
            브라우저에서 <b>{device.verificationUrl.replace(/^https?:\/\//, "")}</b> 에 접속해 아래 코드를 입력하세요.
          </p>
          <div className="device-code">{device.userCode}</div>
          <div className="confirm-actions">
            <button className="btn" onClick={() => navigator.clipboard?.writeText(device.userCode)}>
              코드 복사
            </button>
            <button
              className="btn primary"
              onClick={() => {
                navigator.clipboard?.writeText(device.userCode).catch(() => {});
                openExternal(device.verificationUrl);
              }}
            >
              브라우저 열기
            </button>
          </div>
          <p className="muted small">승인이 끝나면 자동으로 동기화가 시작됩니다.</p>
          <button className="link-btn" onClick={cancelSignIn}>
            취소
          </button>
        </div>
      </Modal>
    );
  }

  const phaseText: Record<typeof sync.phase, string> = {
    local: "연결 안 됨",
    idle: sync.pending ? `업로드 대기 ${sync.pending}개` : "최신 상태",
    syncing: "동기화 중…",
    offline: "오프라인 · 연결되면 자동으로 동기화합니다",
    error: "오류",
    reconnect: "Google 연결이 만료되었습니다",
  };

  return (
    <Modal title="Google Drive 동기화" onClose={onClose} width={460}>
      <div className="dialog-body">
        {!account ? (
          <>
            <p>
              Google 계정을 연결하면 노트가 내 <b>Google Drive 의 'Notebloom' 폴더</b>에 저장되고, 같은 계정으로 로그인한 다른
              기기(Windows · Mac · Android 등)와 자동으로 동기화됩니다.
            </p>
            <ul className="bullets muted small">
              <li>이 앱이 만든 파일에만 접근하며, Drive 의 다른 파일은 볼 수 없습니다.</li>
              <li>'Notebloom' 폴더 안의 파일은 앱이 관리하니 직접 수정하거나 지우지 마세요.</li>
              <li>연결 전에 쓴 노트도 그대로 올라갑니다.</li>
              <li>오프라인에서도 계속 쓸 수 있고, 연결되면 자동으로 합쳐집니다.</li>
            </ul>
            <button className="btn primary block" disabled={busy} onClick={connect}>
              {busy ? "연결 중…" : "Google 계정으로 연결"}
            </button>
            {usingMockGoogle && <div className="emu-badge">모의 Google 서버 모드 (개발용)</div>}
            {authFlow === "device" && !usingMockGoogle && (
              <p className="muted small">앱에서는 브라우저에 코드를 한 번 입력하는 방식으로 로그인합니다.</p>
            )}
          </>
        ) : (
          <>
            <div className="account-row">
              <Avatar name={account.name} picture={account.picture} size={36} />
              <div>
                <div className="me-name">{account.name}</div>
                <div className="muted small">{account.email}</div>
              </div>
            </div>
            <div className="sync-detail">
              <div>
                <span className="muted">상태</span> {phaseText[sync.phase]}
              </div>
              <div>
                <span className="muted">마지막 동기화</span> {sync.lastSyncedAt ? timeAgo(sync.lastSyncedAt) : "—"}
              </div>
              {sync.error && sync.phase !== "idle" && <div className="form-error">{sync.error}</div>}
            </div>
            <div className="confirm-actions">
              <button className="btn" onClick={disconnect}>
                연결 해제
              </button>
              {needsReconnect || sync.phase === "reconnect" ? (
                <button className="btn primary" disabled={busy} onClick={() => run(reconnectGoogle)}>
                  다시 연결
                </button>
              ) : (
                <button className="btn primary" disabled={busy || sync.phase === "syncing"} onClick={() => syncEngine.sync()}>
                  <Icon name="refresh" size={14} /> 지금 동기화
                </button>
              )}
            </div>
          </>
        )}
        {error && <div className="form-error">{error}</div>}
        <AiToolsSection />
      </div>
    </Modal>
  );
}

/** AI 도구(MCP) 연결 허용 여부. 데스크톱 앱에서만 보인다. */
function AiToolsSection() {
  const ai = useAiBridge();
  if (!ai.available) return null;
  return (
    <section className="ai-tools">
      <h3>AI 도구 연결 (MCP)</h3>
      <label className="toggle-row">
        <input type="checkbox" checked={ai.enabled} onChange={(e) => setAiBridgeEnabled(e.target.checked)} />
        <span>이 컴퓨터의 AI 도구(Claude, Cursor 등)가 Notebloom MCP 서버로 노트를 읽고 쓸 수 있게 허용</span>
      </label>
      <p className="muted small">
        AI 가 바꾼 내용은 바로 화면에 보이고 다른 기기와 동기화됩니다. 노트를 영구 삭제할 수는 없습니다. 연결 방법은 저장소의
        mcp/README.md 를 참고하세요.
      </p>
      {ai.error && <div className="form-error">{ai.error}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 휴지통
// ---------------------------------------------------------------------------

export function TrashDialog({ pages, onClose }: { pages: Page[]; onClose: () => void }) {
  const trashed = pages.filter((p) => p.archived).sort((a, b) => b.updatedAt - a.updatedAt);

  const remove = async (p: Page) => {
    const ok = await askConfirm(`'${pageTitle(p)}' 페이지와 모든 하위 페이지를 영구 삭제할까요? 모든 기기에서 지워집니다.`, {
      confirmLabel: "영구 삭제",
      danger: true,
    });
    if (ok) await deletePageForever(p.id, pages);
  };

  return (
    <Modal title="휴지통" onClose={onClose} width={520}>
      <div className="dialog-body">
        {trashed.length === 0 ? (
          <p className="muted">휴지통이 비어 있습니다.</p>
        ) : (
          <ul className="trash-list">
            {trashed.map((p) => (
              <li key={p.id}>
                <a
                  onClick={() => {
                    navigate(p.id);
                    onClose();
                  }}
                >
                  <span className="tree-icon">{p.icon || <Icon name="page" size={15} />}</span>
                  {pageTitle(p)}
                  <span className="muted small"> · {timeAgo(p.updatedAt)}</span>
                </a>
                <button className="icon-btn" title="복원" onClick={() => updatePage(p.id, { archived: false })}>
                  <Icon name="restore" />
                </button>
                <button className="icon-btn danger" title="영구 삭제" onClick={() => remove(p)}>
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 빠른 검색 (Ctrl/Cmd + K)
// ---------------------------------------------------------------------------

export function QuickSearch({ pages, tree, onClose }: { pages: Page[]; tree: PageTree; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);

  const results = useMemo(() => {
    const visible = pages.filter((p) => !tree.hidden.has(p.id));
    const term = q.trim().toLowerCase();
    const list = term
      ? visible.filter((p) => pageTitle(p).toLowerCase().includes(term))
      : [...visible].sort((a, b) => b.updatedAt - a.updatedAt);
    return list.slice(0, 30);
  }, [q, pages, tree]);

  const open = (p: Page | undefined) => {
    if (!p) return;
    navigate(p.id);
    onClose();
  };

  return (
    <Modal onClose={onClose} width={560} className="search-modal">
      <div className="search-input">
        <Icon name="search" />
        <input
          autoFocus
          placeholder="노트 제목 검색"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              open(results[cursor]);
            }
          }}
        />
      </div>
      <div className="search-results">
        {!q && results.length > 0 && <div className="search-label">최근 수정</div>}
        {results.map((p, i) => {
          const path = ancestorsOf(p.id, tree).slice(0, -1).map(pageTitle).join(" / ");
          return (
            <button
              key={p.id}
              className={`search-item ${i === cursor ? "active" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => open(p)}
            >
              <span className="tree-icon">{p.icon || <Icon name="page" size={15} />}</span>
              <span className="search-title">{pageTitle(p)}</span>
              {path && <span className="search-path">{path}</span>}
            </button>
          );
        })}
        {results.length === 0 && <div className="search-empty">일치하는 노트가 없습니다.</div>}
      </div>
    </Modal>
  );
}
