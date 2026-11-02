import * as Y from "yjs";
import { BlockNoteEditor, type Block } from "@blocknote/core";
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { acquireDoc, noteDocName } from "../store/docs";
import { createPage, indexReady, readPages, updatePage } from "../store/notes";
import { syncEngine } from "../sync/engine";
import type { Page } from "../types";

/**
 * AI 도구(MCP 서버)의 요청을 처리한다 (요청은 bridge.ts 가 받아 넘긴다).
 * 앱의 노트 저장소를 그대로 쓰므로 AI 가 바꾼 내용은 화면에 바로 보이고, 평소처럼 Google Drive 에 동기화된다.
 * 본문은 Markdown 으로 주고받는다. 영구 삭제는 제공하지 않는다 (휴지통 이동만 가능).
 */

const FRAGMENT = "blocknote";
/** AI 가 만든 변경의 origin. 동기화 origin 이 아니므로 로컬 편집으로 취급되어 업로드된다. */
const AI_ORIGIN = Symbol("ai-tool");

const createEditor = () => BlockNoteEditor.create();
let editor: ReturnType<typeof createEditor> | null = null;
/** Markdown 변환용 (화면에 붙이지 않는 에디터) */
const getEditor = () => (editor ??= createEditor());

export interface PageInfo extends Page {
  /** 최상위부터 이 노트까지의 제목 */
  path: string[];
  /** 휴지통에 있거나 휴지통에 있는 노트 안에 있음 */
  inTrash: boolean;
  depth: number;
}

const displayTitle = (p: Page) => p.title.trim() || "Untitled";

/** 사이드바 순서(깊이 우선)의 노트 목록과 트리 정보 */
function describe(pages: Page[]) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const children = new Map<string | null, Page[]>();
  for (const p of pages) {
    const parent = p.parentId && byId.has(p.parentId) ? p.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), p]);
  }
  for (const list of children.values()) list.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

  const info = new Map<string, PageInfo>();
  const ordered: PageInfo[] = [];
  const visit = (p: Page, path: string[], hidden: boolean, depth: number) => {
    if (info.has(p.id)) return; // 계층이 꼬여 순환하는 경우 대비
    const entry: PageInfo = { ...p, path: [...path, displayTitle(p)], inTrash: hidden || p.archived, depth };
    info.set(p.id, entry);
    ordered.push(entry);
    for (const c of children.get(p.id) ?? []) visit(c, entry.path, entry.inTrash, depth + 1);
  };
  for (const p of children.get(null) ?? []) visit(p, [], false, 0);
  for (const p of pages) visit(p, [], false, 0); // 순환으로만 닿는 페이지는 최상위에
  return { ordered, info, children };
}

function requirePage(info: Map<string, PageInfo>, id: string) {
  const page = info.get(id);
  if (!page) throw new Error(`No note with id "${id}". Use list_notes or search_notes to find note ids.`);
  return page;
}

// ---- 본문 -------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 노트 본문을 열어 fn 을 실행한다. */
async function withNote<T>(id: string, fn: (fragment: Y.XmlFragment, doc: Y.Doc) => T, { fetchRemote = true } = {}): Promise<T> {
  const lease = acquireDoc(noteDocName(id));
  try {
    await lease.ready;
    const fragment = lease.doc.getXmlFragment(FRAGMENT);
    // 다른 기기에서 만든 노트라 아직 본문이 없으면 Drive 에서 먼저 받아온다 (최대 3초, 노트 화면과 같음).
    if (fetchRemote && fragment.length === 0 && syncEngine.connected) {
      await Promise.race([syncEngine.sync(), sleep(3000)]);
    }
    return fn(fragment, lease.doc);
  } finally {
    lease.release();
  }
}

const isEmptyParagraph = (b: Block) => b.type === "paragraph" && !(Array.isArray(b.content) && b.content.length) && !b.children.length;

function trimTrailingEmpty(blocks: Block[]) {
  const out = [...blocks];
  while (out.length && isEmptyParagraph(out[out.length - 1])) out.pop();
  return out;
}

const toMarkdown = (blocks: Block[]) => getEditor().blocksToMarkdownLossy(blocks);
const parseMarkdown = (markdown: string): Block[] => (markdown.trim() ? getEditor().tryParseMarkdownToBlocks(markdown) : []);

function writeBlocks(doc: Y.Doc, fragment: Y.XmlFragment, blocks: Block[]) {
  // 기존 내용과의 차이만 반영한다 (열려 있는 에디터에도 그대로 보인다).
  doc.transact(() => blocksToYXmlFragment(getEditor(), blocks, fragment), AI_ORIGIN);
}

/** 검색용 일반 텍스트 */
function fragmentText(fragment: Y.XmlFragment) {
  const lines: string[] = [];
  const walk = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText) => {
    if (node instanceof Y.XmlText) {
      const text = (node.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === "string" ? d.insert : "")).join("");
      if (text) lines.push(text);
    } else {
      for (const child of node.toArray()) walk(child as Y.XmlElement | Y.XmlText);
    }
  };
  walk(fragment);
  return lines.join("\n");
}

// ---- 요청 처리 ---------------------------------------------------------------

function listNotes(includeTrashed: boolean) {
  return describe(readPages()).ordered.filter((p) => includeTrashed || !p.inTrash);
}

async function readNote(id: string) {
  const { info, children } = describe(readPages());
  const page = requirePage(info, id);
  const markdown = await withNote(id, (fragment) => {
    const blocks = trimTrailingEmpty(yXmlFragmentToBlocks(getEditor(), fragment));
    return blocks.length ? toMarkdown(blocks).trim() : "";
  });
  const kids = (children.get(id) ?? []).map((c) => info.get(c.id)!).filter((c) => !c.inTrash || page.inTrash);
  return { ...page, children: kids, markdown };
}

async function searchNotes(query: string, limit: number, includeTrashed: boolean) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const notes = listNotes(includeTrashed);
  const results: (PageInfo & { titleMatch: boolean; snippet: string })[] = [];
  for (const page of notes) {
    const titleMatch = page.title.toLowerCase().includes(q);
    const text = await withNote(page.id, fragmentText, { fetchRemote: false });
    const at = text.toLowerCase().indexOf(q);
    if (!titleMatch && at < 0) continue;
    let snippet = "";
    if (at >= 0) {
      const start = Math.max(0, at - 60);
      const end = Math.min(text.length, at + q.length + 60);
      snippet = `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
    }
    results.push({ ...page, titleMatch, snippet });
  }
  return results.sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch) || b.updatedAt - a.updatedAt).slice(0, limit);
}

async function createNote(title: string, markdown: string, parentId: string | null, icon: string) {
  if (parentId) requirePage(describe(readPages()).info, parentId);
  const blocks = parseMarkdown(markdown);
  const id = createPage(parentId, title);
  if (icon) updatePage(id, { icon });
  if (blocks.length) await withNote(id, (fragment, doc) => writeBlocks(doc, fragment, blocks), { fetchRemote: false });
  return { id };
}

async function editContent(id: string, edit: (fragment: Y.XmlFragment, doc: Y.Doc) => void) {
  requirePage(describe(readPages()).info, id);
  await withNote(id, edit);
  updatePage(id); // '최근 수정' 갱신
  return {};
}

/** 끝에 덧붙인다. 기존 블록은 그대로 둔다. */
function appendToNote(id: string, markdown: string) {
  const blocks = parseMarkdown(markdown);
  if (!blocks.length) throw new Error("Nothing to append: the Markdown is empty.");
  return editContent(id, (fragment, doc) => {
    const existing = trimTrailingEmpty(yXmlFragmentToBlocks(getEditor(), fragment));
    writeBlocks(doc, fragment, [...existing, ...blocks]);
  });
}

/**
 * 본문을 통째로 바꾼다. Markdown 이 같은 기존 블록은 그대로 재사용해서
 * Markdown 으로 표현되지 않는 서식(글자 색 등)과 블록 id 를 유지한다.
 */
function replaceNoteContent(id: string, markdown: string) {
  const blocks = parseMarkdown(markdown);
  return editContent(id, (fragment, doc) => {
    const pool = new Map<string, Block[]>();
    for (const block of yXmlFragmentToBlocks(getEditor(), fragment)) {
      const md = toMarkdown([block]);
      pool.set(md, [...(pool.get(md) ?? []), block]);
    }
    writeBlocks(doc, fragment, blocks.map((block) => pool.get(toMarkdown([block]))?.shift() ?? block));
  });
}

interface NotePatch {
  title?: string;
  icon?: string;
  parentId?: string | null;
  archived?: boolean;
}

function updateNote(id: string, patch: NotePatch) {
  const { info } = describe(readPages());
  const page = requirePage(info, id);
  if (patch.parentId) {
    requirePage(info, patch.parentId);
    for (let cur: string | null = patch.parentId; cur; cur = info.get(cur)?.parentId ?? null) {
      if (cur === id) throw new Error("A note can't be moved under itself or one of its sub-notes.");
    }
  }
  const changes: NotePatch & { order?: number } = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  // 다른 노트로 옮기면 그 노트의 맨 끝에 놓는다.
  if (patch.parentId !== undefined && patch.parentId !== page.parentId) changes.order = Date.now();
  updatePage(id, changes);
  return describe(readPages()).info.get(id)!;
}

// ---- 입력 검사 ---------------------------------------------------------------

type Params = Record<string, unknown>;

function str(params: Params, key: string): string {
  const v = params[key];
  if (typeof v !== "string") throw new Error(`"${key}" must be a string.`);
  return v;
}
const optStr = (params: Params, key: string) => (params[key] === undefined ? undefined : str(params, key));
const flag = (params: Params, key: string) => params[key] === true;
function optParent(params: Params) {
  const v = params.parentId;
  if (v === undefined || v === null || typeof v === "string") return v;
  throw new Error('"parentId" must be a string or null.');
}

export async function handle(method: string, params: Params = {}): Promise<unknown> {
  await indexReady;
  switch (method) {
    case "status":
      return { notes: listNotes(false).length, sync: syncEngine.getStatus().phase };
    case "listNotes":
      return listNotes(flag(params, "includeTrashed"));
    case "searchNotes": {
      const limit = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 100) : 20;
      return searchNotes(str(params, "query"), limit, flag(params, "includeTrashed"));
    }
    case "readNote":
      return readNote(str(params, "id"));
    case "createNote":
      return createNote(str(params, "title"), optStr(params, "markdown") ?? "", optParent(params) ?? null, optStr(params, "icon") ?? "");
    case "appendToNote":
      return appendToNote(str(params, "id"), str(params, "markdown"));
    case "replaceNoteContent":
      return replaceNoteContent(str(params, "id"), str(params, "markdown"));
    case "updateNote":
      return updateNote(str(params, "id"), {
        title: optStr(params, "title"),
        icon: optStr(params, "icon"),
        parentId: optParent(params),
        archived: typeof params.archived === "boolean" ? params.archived : undefined,
      });
    default:
      throw new Error(`Unknown method "${method}".`);
  }
}
