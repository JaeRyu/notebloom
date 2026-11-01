import "@blocknote/mantine/style.css";
import { useEffect, useMemo } from "react";
import type * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { ko } from "@blocknote/core/locales";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";

/**
 * Notion 스타일 블록 에디터 (슬래시 명령 `/`, 드래그 핸들, 마크다운 단축키, 표, 체크리스트 등).
 * 내용은 Yjs 문서에 바로 기록되고, 그 문서가 IndexedDB 와 Google Drive 에 동기화된다.
 */
export function Editor({
  doc,
  theme,
  editable,
  onReady,
}: {
  doc: Y.Doc;
  theme: "light" | "dark";
  editable: boolean;
  onReady?: (editor: BlockNoteEditor<any, any, any>) => void;
}) {
  const awareness = useMemo(() => new Awareness(doc), [doc]);
  useEffect(() => () => awareness.destroy(), [awareness]);

  const editor = useCreateBlockNote(
    withCollaboration({
      dictionary: ko,
      collaboration: {
        provider: { awareness },
        fragment: doc.getXmlFragment("blocknote"),
        user: { name: "나", color: "#2f6fde" },
      },
    }),
    [doc, awareness],
  );

  useEffect(() => onReady?.(editor), [editor, onReady]);

  return <BlockNoteView editor={editor} theme={theme} editable={editable} />;
}
