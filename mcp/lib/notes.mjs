// Notebloom notes on Google Drive: the page index and note contents as Yjs documents.
// Mirrors the app's data model (src/store/notes.ts, src/store/docs.ts, src/sync/engine.ts):
//
//   index.yjs      Y.Map "pages": pageId → Y.Map { title, icon, parentId, order, archived, createdAt, updatedAt }
//   note-{id}.yjs  note content in the Y.XmlFragment "blocknote" (BlockNote editor format)
//
// Every write merges the latest file from Drive first and uploads the merged state, so edits made in the
// app are kept. Yjs merges are order-independent, so this is safe while the app is open.

import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { drive, NotFoundError } from "./google.mjs";

const INDEX = "index";
const FRAGMENT = "blocknote";
const noteDocName = (id) => `note-${id}`;
const fileNameOf = (name) => `${name}.yjs`;
const docNameOf = (fileName) => (fileName.endsWith(".yjs") ? fileName.slice(0, -4) : null);

/**
 * If the app uploads at the same moment as we do, its upload can replace ours on Drive (the app only
 * re-uploads what *it* has). So after each upload we check back a few times and upload again if our
 * changes are missing from the file.
 */
const VERIFY_DELAYS = [4_000, 15_000, 45_000];

// ---- BlockNote (Markdown conversion) -----------------------------------------

let editorPromise = null;
function getEditor() {
  // Loaded lazily: it pulls in jsdom and the editor, which takes a moment.
  editorPromise ??= Promise.all([import("@blocknote/server-util"), import("@blocknote/server-util/dom")]).then(
    ([{ ServerBlockNoteEditor }, { getDocument }]) => ServerBlockNoteEditor.create({}, getDocument()),
  );
  return editorPromise;
}

const isEmptyParagraph = (b) => b.type === "paragraph" && !(b.content?.length > 0) && !(b.children?.length > 0);

function trimTrailingEmpty(blocks) {
  const out = [...blocks];
  while (out.length && isEmptyParagraph(out.at(-1))) out.pop();
  return out;
}

async function fragmentToMarkdown(fragment) {
  const editor = await getEditor();
  const blocks = trimTrailingEmpty(editor.yXmlFragmentToBlocks(fragment));
  return blocks.length ? (await editor.blocksToMarkdownLossy(blocks)).trim() : "";
}

async function parseMarkdown(markdown) {
  const editor = await getEditor();
  return markdown.trim() ? editor.tryParseMarkdownToBlocks(markdown) : [];
}

/**
 * Replaces the content with `newBlocks`, but keeps every existing block whose Markdown is unchanged as it
 * is (its id and any formatting Markdown can't express, such as text colors). The fragment is updated with a
 * minimal diff, so unchanged parts are untouched in the CRDT too.
 */
async function replaceBlocks(fragment, newBlocks) {
  const editor = await getEditor();
  const pool = new Map();
  for (const block of editor.yXmlFragmentToBlocks(fragment)) {
    const md = await editor.blocksToMarkdownLossy([block]);
    pool.set(md, [...(pool.get(md) ?? []), block]);
  }
  const merged = [];
  for (const block of newBlocks) {
    const md = await editor.blocksToMarkdownLossy([block]);
    merged.push(pool.get(md)?.shift() ?? block);
  }
  editor.blocksToYXmlFragment(merged, fragment);
}

async function appendBlocks(fragment, newBlocks) {
  const editor = await getEditor();
  const existing = trimTrailingEmpty(editor.yXmlFragmentToBlocks(fragment));
  editor.blocksToYXmlFragment([...existing, ...newBlocks], fragment);
}

/** Plain text of a note, for search. */
function fragmentText(fragment) {
  const lines = [];
  const walk = (node) => {
    if (node instanceof Y.XmlText) {
      const text = node
        .toDelta()
        .map((d) => (typeof d.insert === "string" ? d.insert : ""))
        .join("");
      if (text) lines.push(text);
    } else {
      for (const child of node.toArray()) walk(child);
    }
  };
  walk(fragment);
  return lines.join("\n");
}

// ---- Drive files → Yjs documents ---------------------------------------------

/** Downloaded file contents by file id (reused while the Drive version is unchanged). */
const cache = new Map();

async function download(file) {
  const hit = cache.get(file.id);
  if (hit?.version === file.version) return hit.bytes;
  const bytes = await drive.download(file.id);
  cache.set(file.id, { version: file.version, bytes });
  return bytes;
}

/** Drive files by document name. Normally one each; duplicates (rare) are all merged when read. */
async function listFiles() {
  const byName = new Map();
  for (const f of await drive.listDocs()) {
    const name = docNameOf(f.name);
    if (name) byName.set(name, [...(byName.get(name) ?? []), f]);
  }
  for (const files of byName.values()) files.sort((a, b) => a.id.localeCompare(b.id));
  return byName;
}

async function loadDoc(files) {
  const doc = new Y.Doc();
  for (const f of files) Y.applyUpdate(doc, await download(f));
  return doc;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** One write at a time per document (tools may be called in parallel). */
const locks = new Map();
function withLock(name, fn) {
  const run = (locks.get(name) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(name, tail);
  tail.then(() => locks.get(name) === tail && locks.delete(name));
  return run;
}

async function upload(name, doc, target) {
  const bytes = Y.encodeStateAsUpdate(doc);
  let saved;
  try {
    saved = target ? await drive.update(target.id, bytes) : await drive.create(fileNameOf(name), bytes);
  } catch (e) {
    if (!(e instanceof NotFoundError) || !target) throw e;
    saved = await drive.create(fileNameOf(name), bytes); // the file was deleted meanwhile
  }
  cache.set(saved.id, { version: saved.version, bytes });
  scheduleVerify(name, bytes);
}

/** Loads the latest version of a document, applies `mutate`, and uploads it if anything changed. */
function editDoc(name, mutate) {
  return withLock(name, async () => {
    const files = (await listFiles()).get(name) ?? [];
    const doc = await loadDoc(files);
    try {
      const before = Y.snapshot(doc);
      const result = await mutate(doc);
      if (files.length !== 1 || !Y.equalSnapshots(before, Y.snapshot(doc))) await upload(name, doc, files[0]);
      return result;
    } finally {
      doc.destroy();
    }
  });
}

const verifying = new Map();

function scheduleVerify(name, bytes) {
  verifying.get(name)?.timers.forEach(clearTimeout);
  const entry = { timers: [] };
  entry.timers = VERIFY_DELAYS.map((ms, i) =>
    setTimeout(async () => {
      try {
        await verify(name, bytes);
      } catch (e) {
        console.error(`[notebloom] could not re-check ${name}: ${e.message}`);
      } finally {
        if (i === VERIFY_DELAYS.length - 1 && verifying.get(name) === entry) verifying.delete(name);
      }
    }, ms),
  );
  verifying.set(name, entry);
}

/** Uploads again if the file on Drive no longer contains everything we uploaded. */
function verify(name, bytes) {
  return withLock(name, async () => {
    const files = (await listFiles()).get(name) ?? [];
    const doc = await loadDoc(files);
    try {
      const before = Y.snapshot(doc);
      Y.applyUpdate(doc, bytes);
      if (!files.length || !Y.equalSnapshots(before, Y.snapshot(doc))) {
        console.error(`[notebloom] ${name} was overwritten by another device; uploading the merged version again`);
        await upload(name, doc, files[0]);
      }
    } finally {
      doc.destroy();
    }
  });
}

/** Re-checks still waiting to run (the process should stay alive for them). */
export const pendingChecks = () => verifying.size;

// ---- Pages (index) -----------------------------------------------------------

const pagesMap = (doc) => doc.getMap("pages");

function toPage(id, m) {
  return {
    id,
    title: m.get("title") ?? "",
    icon: m.get("icon") ?? "",
    parentId: m.get("parentId") ?? null,
    order: m.get("order") ?? 0,
    archived: Boolean(m.get("archived")),
    createdAt: m.get("createdAt") ?? 0,
    updatedAt: m.get("updatedAt") ?? 0,
  };
}

function readPagesFrom(doc) {
  const pages = [];
  pagesMap(doc).forEach((m, id) => {
    if (m instanceof Y.Map) pages.push(toPage(id, m));
  });
  return pages;
}

async function readPages(files) {
  const doc = await loadDoc((files ?? (await listFiles())).get(INDEX) ?? []);
  try {
    return readPagesFrom(doc);
  } finally {
    doc.destroy();
  }
}

/** Page list with the tree information the tools need. */
function describe(pages) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const children = new Map();
  for (const p of pages) {
    const parent = p.parentId && byId.has(p.parentId) ? p.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), p]);
  }
  for (const list of children.values()) list.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

  // Depth-first, in sidebar order. A page inside a trashed page counts as trashed, like in the app.
  const info = new Map();
  const ordered = [];
  const visit = (p, path, hidden, depth) => {
    if (info.has(p.id)) return; // guards against a broken (cyclic) hierarchy
    const entry = { ...p, path: [...path, displayTitle(p)], inTrash: hidden || p.archived, depth };
    info.set(p.id, entry);
    ordered.push(entry);
    for (const c of children.get(p.id) ?? []) visit(c, entry.path, entry.inTrash, depth + 1);
  };
  for (const p of children.get(null) ?? []) visit(p, [], false, 0);
  // Pages only reachable through a cycle: list them at the top level.
  for (const p of pages) visit(p, [], false, 0);
  return { ordered, info, children };
}

export const displayTitle = (p) => p.title.trim() || "Untitled";

function requirePage(info, id) {
  const page = info.get(id);
  if (!page) throw new Error(`No note with id "${id}". Use list_notes or search_notes to find note ids.`);
  return page;
}

function newId() {
  return randomUUID().replace(/-/g, "").slice(0, 20);
}

// ---- Public API (used by the MCP tools) --------------------------------------

export async function listNotes({ includeTrashed = false } = {}) {
  const { ordered } = describe(await readPages());
  return ordered.filter((p) => includeTrashed || !p.inTrash);
}

export async function readNote(id) {
  const files = await listFiles();
  const { info, children } = describe(await readPages(files));
  const page = requirePage(info, id);
  const doc = await loadDoc(files.get(noteDocName(id)) ?? []);
  try {
    return {
      ...page,
      children: (children.get(id) ?? []).map((c) => info.get(c.id)).filter((c) => !c.inTrash || page.inTrash),
      markdown: await fragmentToMarkdown(doc.getXmlFragment(FRAGMENT)),
    };
  } finally {
    doc.destroy();
  }
}

export async function searchNotes(query, { limit = 20, includeTrashed = false } = {}) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const files = await listFiles();
  const notes = describe(await readPages(files)).ordered.filter((p) => includeTrashed || !p.inTrash);
  const results = await mapLimit(notes, 6, async (page) => {
    const titleMatch = page.title.toLowerCase().includes(q);
    const noteFiles = files.get(noteDocName(page.id)) ?? [];
    let text = "";
    if (noteFiles.length) {
      const doc = await loadDoc(noteFiles);
      text = fragmentText(doc.getXmlFragment(FRAGMENT));
      doc.destroy();
    }
    const at = text.toLowerCase().indexOf(q);
    if (!titleMatch && at < 0) return null;
    let snippet = "";
    if (at >= 0) {
      const start = Math.max(0, at - 60);
      const end = Math.min(text.length, at + q.length + 60);
      snippet = `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
    }
    return { ...page, titleMatch, snippet };
  });
  return results
    .filter(Boolean)
    .sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch) || b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

async function touch(id) {
  await editDoc(INDEX, (doc) => {
    const m = pagesMap(doc).get(id);
    if (m instanceof Y.Map) m.set("updatedAt", Date.now());
  });
}

export async function createNote({ title, markdown = "", parentId = null, icon = "" }) {
  if (parentId) requirePage(describe(await readPages()).info, parentId);
  const blocks = await parseMarkdown(markdown);
  const id = newId();

  // Content first, then the index entry, so the app never shows the new page without its content.
  await editDoc(noteDocName(id), async (doc) => {
    if (blocks.length) (await getEditor()).blocksToYXmlFragment(blocks, doc.getXmlFragment(FRAGMENT));
  });
  await editDoc(INDEX, (doc) => {
    const now = Date.now();
    doc.transact(() => {
      const m = new Y.Map();
      pagesMap(doc).set(id, m);
      m.set("title", title);
      m.set("icon", icon);
      m.set("parentId", parentId);
      m.set("order", now);
      m.set("archived", false);
      m.set("createdAt", now);
      m.set("updatedAt", now);
    });
  });
  return id;
}

async function editContent(id, edit) {
  requirePage(describe(await readPages()).info, id);
  await editDoc(noteDocName(id), (doc) => edit(doc.getXmlFragment(FRAGMENT)));
  await touch(id);
}

export async function appendToNote(id, markdown) {
  const blocks = await parseMarkdown(markdown);
  if (!blocks.length) throw new Error("Nothing to append: the Markdown is empty.");
  await editContent(id, (fragment) => appendBlocks(fragment, blocks));
}

export async function replaceNoteContent(id, markdown) {
  const blocks = await parseMarkdown(markdown);
  await editContent(id, (fragment) => replaceBlocks(fragment, blocks));
}

/** Title, icon, parent and trash state. Returns the updated page. */
export async function updateNote(id, patch) {
  return editDoc(INDEX, (doc) => {
    const pages = readPagesFrom(doc);
    const { info } = describe(pages);
    requirePage(info, id);
    if (patch.parentId !== undefined && patch.parentId !== null) {
      requirePage(info, patch.parentId);
      // A note can't move under itself or one of its own sub-notes.
      for (let cur = patch.parentId; cur; cur = info.get(cur)?.parentId ?? null) {
        if (cur === id) throw new Error("A note can't be moved under itself or one of its sub-notes.");
      }
    }
    const m = pagesMap(doc).get(id);
    doc.transact(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined && m.get(k) !== v) m.set(k, v);
      }
      // Moving to another parent puts the note at the end of that parent's list, like the app does.
      if (patch.parentId !== undefined && patch.parentId !== info.get(id).parentId) m.set("order", Date.now());
      m.set("updatedAt", Date.now());
    });
    return describe(readPagesFrom(doc)).info.get(id);
  });
}
