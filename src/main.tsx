import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { isTauri, openExternal } from "./platform";
import "./styles.css";

// 앱(Tauri) 안에서는 노트의 외부 링크가 앱 화면을 덮어쓰지 않도록 시스템 브라우저로 연다.
if (isTauri) {
  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || !/^(https?:|mailto:|tel:)/.test(a.href)) return;
      e.preventDefault();
      openExternal(a.href);
    },
    true,
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
