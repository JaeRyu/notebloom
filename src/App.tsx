import { useEffect, useState } from "react";
import { useIsMobile, usePages, usePageTree, useRoute, WIDE_LAYOUT_MIN_WIDTH } from "./hooks";
import { resumeSync } from "./sync/engine";
import { startAiBridge } from "./ai/bridge";
import { AccountDialog, QuickSearch, TrashDialog } from "./components/Dialogs";
import { Home } from "./components/Home";
import { PageView } from "./components/PageView";
import { Sidebar } from "./components/Sidebar";
import { ChoiceHost } from "./components/ui";

type DialogKind = "search" | "trash" | "account" | null;

export default function App() {
  const pages = usePages();
  const tree = usePageTree(pages);
  const route = useRoute();
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= WIDE_LAYOUT_MIN_WIDTH);
  const [dialog, setDialog] = useState<DialogKind>(null);

  // 이전에 Google 계정을 연결했다면 동기화를 이어간다.
  useEffect(() => resumeSync(), []);

  // 데스크톱 앱이면 AI 도구(MCP 서버)의 연결을 받는다.
  useEffect(() => startAiBridge(), []);

  // 화면이 휴대폰 폭으로 줄면 사이드바를 닫고(드로어), 넓어지면 다시 연다.
  useEffect(() => setSidebarOpen(!isMobile), [isMobile]);

  // 단축키: Ctrl/Cmd+K 검색, Ctrl/Cmd+\ 사이드바
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog((d) => (d === "search" ? null : "search"));
      } else if (e.key === "\\") {
        e.preventDefault();
        setSidebarOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleSidebar = isMobile || !sidebarOpen ? () => setSidebarOpen((o) => !o) : undefined;
  const openAccount = () => setDialog("account");
  const closeDialog = () => setDialog(null);

  return (
    <div className={`app ${isMobile ? "mobile" : ""}`}>
      {sidebarOpen && (
        <Sidebar
          pages={pages ?? []}
          tree={tree}
          activePageId={route.pid}
          onSearch={() => setDialog("search")}
          onTrash={() => setDialog("trash")}
          onAccount={openAccount}
          onNavigate={() => isMobile && setSidebarOpen(false)}
        />
      )}
      {isMobile && sidebarOpen && <div className="backdrop" onClick={() => setSidebarOpen(false)} />}

      <main className="main">
        {route.pid ? (
          <PageView
            key={route.pid}
            pageId={route.pid}
            pages={pages}
            tree={tree}
            onToggleSidebar={toggleSidebar}
            onSyncClick={openAccount}
          />
        ) : (
          <Home pages={pages} tree={tree} onToggleSidebar={toggleSidebar} onSyncClick={openAccount} />
        )}
      </main>

      {dialog === "search" && <QuickSearch pages={pages ?? []} tree={tree} onClose={closeDialog} />}
      {dialog === "trash" && <TrashDialog pages={pages ?? []} onClose={closeDialog} />}
      {dialog === "account" && <AccountDialog onClose={closeDialog} />}
      <ChoiceHost />
    </div>
  );
}
