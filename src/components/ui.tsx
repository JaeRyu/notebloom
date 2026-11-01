import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSyncStatus } from "../sync/engine";

// 일부 아이콘 경로는 Lucide(ISC) / Feather(MIT) 아이콘을 바탕으로 했다. 고지는 THIRD_PARTY_NOTICES 에 포함된다.
const ICONS = {
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35",
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z",
  plus: "M12 5v14M5 12h14",
  trash: "M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6",
  chevron: "m9 18 6-6-6-6",
  menu: "M3 6h18M3 12h18M3 18h18",
  page: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6",
  close: "M18 6 6 18M6 6l12 12",
  restore: "M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5",
  check: "M20 6 9 17l-5-5",
  cloud: "M17.5 19H7a5 5 0 1 1 1.6-9.74A6 6 0 0 1 20 12a3.5 3.5 0 0 1-2.5 7Z",
  cloudOff: "m2 2 20 20M5.8 5.8A7 7 0 0 0 6 20h11m3.7-1.7A4.5 4.5 0 0 0 17.5 10h-1.3A7 7 0 0 0 9 5.2",
  refresh: "M21 12a9 9 0 0 1-15.5 6.2L3 16m0 5v-5h5M3 12a9 9 0 0 1 15.5-6.2L21 8m0-5v5h-5",
  device: "M4 4h16v12H4zM8 20h8M12 16v4",
  alert: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export function Modal({
  title,
  onClose,
  children,
  width = 480,
  className = "",
}: {
  title?: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  className?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={`modal ${className}`}
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        {title && (
          <div className="modal-header">
            <h2>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="닫기">
              <Icon name="close" />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

const EMOJIS =
  "📄 📘 📗 📕 📒 📓 📝 📌 📎 📊 📈 🗂️ 🗓️ ✅ ☑️ 💡 🚀 🎯 🔥 ⭐ 🏠 🏢 💼 🧪 🛠️ ⚙️ 🔒 🔑 🧭 🗺️ 🌱 🌍 🎨 🎵 📷 🍀 💬 📣 🤝 👋 ❤️ 🐛 📦 🧩 🏷️ 🧠".split(
    " ",
  );

export function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  return (
    <div className="emoji-picker" ref={ref}>
      <div className="emoji-grid">
        {EMOJIS.map((e) => (
          <button key={e} onClick={() => onPick(e)}>
            {e}
          </button>
        ))}
      </div>
      <button className="link-btn" onClick={() => onPick("")}>
        아이콘 제거
      </button>
    </div>
  );
}

/** 상단 바의 저장/동기화 상태 */
export function SyncIndicator({ onClick }: { onClick: () => void }) {
  const { phase, pending, error } = useSyncStatus();
  const view: Record<typeof phase, { cls: string; icon: IconName; text: string; title: string }> = {
    local: { cls: "", icon: "device", text: "이 기기에 저장됨", title: "Google Drive 를 연결하면 다른 기기와 동기화됩니다." },
    idle: {
      cls: "sync-ok",
      icon: pending ? "refresh" : "check",
      text: pending ? "동기화 대기" : "동기화됨",
      title: "Google Drive 와 동기화되었습니다.",
    },
    syncing: { cls: "", icon: "refresh", text: "동기화 중…", title: "Google Drive 와 동기화하는 중입니다." },
    offline: {
      cls: "sync-warn",
      icon: "cloudOff",
      text: "오프라인",
      title: "편집 내용은 기기에 저장되며, 연결되면 자동으로 동기화됩니다.",
    },
    error: { cls: "sync-error", icon: "alert", text: "동기화 오류", title: error ?? "" },
    reconnect: { cls: "sync-error", icon: "alert", text: "다시 연결 필요", title: "Google 연결이 만료되었습니다." },
  };
  const v = view[phase];
  return (
    <button className={`sync ${v.cls}`} title={v.title} onClick={onClick}>
      <Icon name={v.icon} size={14} />
      <span>{v.text}</span>
    </button>
  );
}

export function TopBar({
  onToggleSidebar,
  onSyncClick,
  children,
  actions,
}: {
  onToggleSidebar?: () => void;
  onSyncClick: () => void;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="topbar">
      {onToggleSidebar && (
        <button className="icon-btn" onClick={onToggleSidebar} aria-label="사이드바 열기/닫기">
          <Icon name="menu" />
        </button>
      )}
      <div className="crumbs">{children}</div>
      <div className="topbar-actions">
        <SyncIndicator onClick={onSyncClick} />
        {actions}
      </div>
    </header>
  );
}

export function Avatar({ name, picture, size = 22 }: { name: string; picture?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (picture && !broken) {
    return (
      <img
        className="avatar"
        src={picture}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.5 }} title={name}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

// ---- 선택 대화상자: 일부 WebView(Tauri 모바일 등)는 window.confirm 을 지원하지 않아 직접 구현 ----

interface Choice<T extends string> {
  value: T;
  label: string;
  kind?: "primary" | "danger";
}

interface ChoiceRequest {
  message: string;
  choices: Choice<string>[];
  resolve: (value: string | null) => void;
}

let showChoice: ((req: ChoiceRequest) => void) | null = null;

/** 여러 선택지 중 하나를 고르게 한다. 닫거나 '취소'하면 null */
export function askChoice<T extends string>(message: string, choices: Choice<T>[]): Promise<T | null> {
  return new Promise((resolve) => {
    if (!showChoice) return resolve(null);
    showChoice({ message, choices, resolve: resolve as (v: string | null) => void });
  });
}

export async function askConfirm(message: string, opts: { confirmLabel?: string; danger?: boolean } = {}) {
  const r = await askChoice(message, [
    { value: "ok", label: opts.confirmLabel ?? "확인", kind: opts.danger ? "danger" : "primary" },
  ]);
  return r === "ok";
}

export function ChoiceHost() {
  const [req, setReq] = useState<ChoiceRequest | null>(null);
  useEffect(() => {
    showChoice = setReq;
    return () => {
      showChoice = null;
    };
  }, []);
  if (!req) return null;
  const done = (v: string | null) => {
    req.resolve(v);
    setReq(null);
  };
  return (
    <Modal onClose={() => done(null)} width={440}>
      <div className="confirm">
        <p>{req.message}</p>
        <div className="confirm-actions">
          <button className="btn" onClick={() => done(null)}>
            취소
          </button>
          {req.choices.map((c, i) => (
            <button
              key={c.value}
              className={`btn ${c.kind ?? ""}`}
              onClick={() => done(c.value)}
              autoFocus={i === req.choices.length - 1}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

const rtf = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });

export function timeAgo(ms: number | null | undefined) {
  if (!ms) return "방금";
  const sec = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(sec);
  if (abs < 60) return "방금";
  if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(sec / 86400), "day");
  return new Date(ms).toLocaleDateString("ko-KR");
}
