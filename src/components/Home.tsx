import { navigate, pageTitle, type PageTree } from "../hooks";
import { createPage } from "../store/notes";
import { useAuth } from "../sync/auth";
import type { Page } from "../types";
import { Icon, timeAgo, TopBar } from "./ui";

/** 홈: 최근 수정한 노트 */
export function Home({
  pages,
  tree,
  onToggleSidebar,
  onSyncClick,
}: {
  pages: Page[] | null;
  tree: PageTree;
  onToggleSidebar?: () => void;
  onSyncClick: () => void;
}) {
  const { account } = useAuth();
  const recent = (pages ?? [])
    .filter((p) => !tree.hidden.has(p.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12);

  return (
    <>
      <TopBar onToggleSidebar={onToggleSidebar} onSyncClick={onSyncClick}>
        <span className="crumb current">홈</span>
      </TopBar>
      <div className="page-scroll">
        <div className="home">
          <h1 className="home-title">{account ? `${account.name}님의 노트` : "내 노트"}</h1>

          {!account && (
            <div className="connect-banner">
              <Icon name="cloud" size={20} />
              <div>
                <b>Google Drive 를 연결해 다른 기기와 동기화하세요.</b>
                <div className="muted small">지금은 이 기기에만 저장됩니다. 연결해도 기존 노트는 그대로 유지됩니다.</div>
              </div>
              <button className="btn primary small" onClick={onSyncClick}>
                연결
              </button>
            </div>
          )}

          <button className="btn primary" onClick={() => navigate(createPage(null))}>
            <Icon name="plus" size={14} /> 새 노트
          </button>

          <h3 className="home-section">최근 수정한 노트</h3>
          {pages === null ? (
            <p className="muted">불러오는 중…</p>
          ) : recent.length === 0 ? (
            <p className="muted">아직 노트가 없습니다. 새 노트를 만들어 보세요.</p>
          ) : (
            <div className="card-grid">
              {recent.map((p) => (
                <a key={p.id} className="page-card" onClick={() => navigate(p.id)}>
                  <span className="page-card-icon">{p.icon || <Icon name="page" size={22} />}</span>
                  <span className="page-card-title">{pageTitle(p)}</span>
                  <span className="muted small">{timeAgo(p.updatedAt)}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
