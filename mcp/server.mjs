#!/usr/bin/env node
// Notebloom MCP server: lets AI tools (Claude, Cursor, …) read and edit your notes through the Notebloom
// desktop app running on this computer.
//
//   node server.mjs          run the MCP server over stdio (what AI tools launch)
//   node server.mjs status   check the connection to the app

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appDataDir, appStatus, callApp, installedApp } from "./lib/app.mjs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// ---- Formatting --------------------------------------------------------------

const date = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "unknown");
const displayTitle = (p) => p.title.trim() || "Untitled";
const label = (p) => `${p.icon ? `${p.icon} ` : ""}${displayTitle(p)}`;
const trashTag = (p) => (p.inTrash ? " (in trash)" : "");

function outline(notes) {
  if (!notes.length) return "No notes yet.";
  return notes.map((p) => `${"  ".repeat(p.depth)}- ${label(p)}  [id: ${p.id}]${trashTag(p)}`).join("\n");
}

// ---- MCP server --------------------------------------------------------------

const INSTRUCTIONS = `Notebloom is the user's personal note app. Notes are pages in a tree (a note can have sub-notes).
These tools work through the Notebloom app on this computer: changes appear in the app immediately and sync to the
user's other devices through their Google Drive.
- Find notes with list_notes or search_notes; the other tools take the note id they return.
- Note content is read and written as Markdown. Notes can hold formatting Markdown can't express (e.g. text colors);
  replace_note_content keeps that formatting for every block whose text you leave unchanged.
- Prefer append_to_note for adding to a note. Use replace_note_content to edit or rewrite: read the note first and send
  the complete new content.
- Deleting is not possible here: move_note_to_trash moves a note (and its sub-notes) to the trash, where the user can
  restore it or delete it for good in the app.`;

async function serve() {
  // stdout carries the MCP protocol, so nothing else may print to it.
  console.log = console.error;
  console.info = console.error;

  const server = new McpServer({ name: "notebloom", version }, { instructions: INSTRUCTIONS });

  const tool = (name, config, handler) =>
    server.registerTool(name, config, async (args) => {
      try {
        return { content: [{ type: "text", text: await handler(args) }] };
      } catch (e) {
        return { content: [{ type: "text", text: e.message || String(e) }], isError: true };
      }
    });

  const noteId = z.string().min(1).describe("Note id (from list_notes or search_notes)");
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  tool(
    "list_notes",
    {
      title: "List notes",
      description: "List all notes as an outline (sub-notes indented under their parent), with their ids.",
      inputSchema: { include_trashed: z.boolean().optional().describe("Also list notes in the trash (default false)") },
      annotations: readOnly,
    },
    async ({ include_trashed }) => {
      const notes = await callApp("listNotes", { includeTrashed: include_trashed });
      return `${notes.length} note${notes.length === 1 ? "" : "s"}:\n${outline(notes)}`;
    },
  );

  tool(
    "search_notes",
    {
      title: "Search notes",
      description: "Find notes whose title or content contains the text (case-insensitive). Returns ids and matching snippets.",
      inputSchema: {
        query: z.string().min(1).describe("Text to look for"),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum results (default 20)"),
        include_trashed: z.boolean().optional().describe("Also search notes in the trash (default false)"),
      },
      annotations: readOnly,
    },
    async ({ query, limit, include_trashed }) => {
      const results = await callApp("searchNotes", { query, limit, includeTrashed: include_trashed });
      if (!results.length) return `No notes match "${query}".`;
      return results
        .map((p) => `- ${label(p)}  [id: ${p.id}]${trashTag(p)}\n  in: ${p.path.join(" / ")}${p.snippet ? `\n  "${p.snippet}"` : ""}`)
        .join("\n");
    },
  );

  tool(
    "read_note",
    {
      title: "Read note",
      description: "Read a note: its title, location, sub-notes and content as Markdown.",
      inputSchema: { note_id: noteId },
      annotations: readOnly,
    },
    async ({ note_id }) => {
      const n = await callApp("readNote", { id: note_id });
      const lines = [
        `Title: ${label(n)}${trashTag(n)}`,
        `Id: ${n.id}`,
        `Location: ${n.path.join(" / ")}`,
        `Last edited: ${date(n.updatedAt)}`,
      ];
      if (n.children.length) lines.push(`Sub-notes: ${n.children.map((c) => `${label(c)} [id: ${c.id}]`).join(", ")}`);
      lines.push("", "Content (Markdown):", "", n.markdown || "(empty)");
      return lines.join("\n");
    },
  );

  tool(
    "create_note",
    {
      title: "Create note",
      description: "Create a new note, optionally with Markdown content and inside another note.",
      inputSchema: {
        title: z.string().describe("Note title"),
        markdown: z.string().optional().describe("Content in Markdown (headings, lists, checklists `- [ ]`, tables, code blocks, quotes, links)"),
        parent_id: z.string().optional().describe("Id of the note to create this one inside. Omit for a top-level note."),
        icon: z.string().optional().describe("An emoji shown before the title, e.g. 📒"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, markdown, parent_id, icon }) => {
      const { id } = await callApp("createNote", { title, markdown, parentId: parent_id ?? null, icon });
      return `Created note "${title.trim() || "Untitled"}" [id: ${id}].`;
    },
  );

  tool(
    "append_to_note",
    {
      title: "Append to note",
      description: "Add Markdown content to the end of a note. The existing content is left exactly as it is.",
      inputSchema: { note_id: noteId, markdown: z.string().min(1).describe("Content to add, in Markdown") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ note_id, markdown }) => {
      await callApp("appendToNote", { id: note_id, markdown });
      return "Appended.";
    },
  );

  tool(
    "replace_note_content",
    {
      title: "Replace note content",
      description:
        "Replace a note's entire content with new Markdown (use read_note first). Blocks whose text is unchanged keep " +
        "their formatting; changed or removed blocks are replaced.",
      inputSchema: { note_id: noteId, markdown: z.string().describe("The complete new content, in Markdown") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ note_id, markdown }) => {
      await callApp("replaceNoteContent", { id: note_id, markdown });
      return "Content replaced.";
    },
  );

  tool(
    "update_note",
    {
      title: "Rename or move note",
      description: "Change a note's title or icon, or move it inside another note (parent_id) or to the top level (parent_id: null).",
      inputSchema: {
        note_id: noteId,
        title: z.string().optional().describe("New title"),
        icon: z.string().optional().describe('New emoji icon ("" removes it)'),
        parent_id: z.string().nullable().optional().describe("Id of the new parent note, or null for the top level"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ note_id, title, icon, parent_id }) => {
      if (title === undefined && icon === undefined && parent_id === undefined) throw new Error("Nothing to change.");
      const p = await callApp("updateNote", { id: note_id, title, icon, parentId: parent_id });
      return `Updated: ${label(p)}  [id: ${p.id}], located at ${p.path.join(" / ")}${trashTag(p)}`;
    },
  );

  tool(
    "move_note_to_trash",
    {
      title: "Move note to trash",
      description: "Move a note and its sub-notes to the trash. The user can restore them in the app (or with restore_note).",
      inputSchema: { note_id: noteId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ note_id }) => {
      const p = await callApp("updateNote", { id: note_id, archived: true });
      return `Moved "${displayTitle(p)}" to the trash.`;
    },
  );

  tool(
    "restore_note",
    {
      title: "Restore note from trash",
      description: "Restore a note from the trash.",
      inputSchema: { note_id: noteId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ note_id }) => {
      const p = await callApp("updateNote", { id: note_id, archived: false });
      if (p.inTrash) {
        return `Restored "${displayTitle(p)}", but a note it's inside (${p.path.slice(0, -1).join(" / ")}) is still in the trash. Restore that one too, or move this note with update_note.`;
      }
      return `Restored "${displayTitle(p)}".`;
    },
  );

  await server.connect(new StdioServerTransport());
  console.error(`Notebloom MCP server ${version} running (app data folder: ${appDataDir()})`);
}

// ---- CLI -----------------------------------------------------------------------

async function status() {
  const app = await appStatus();
  if (app) {
    console.log(`Connected to Notebloom ${app.version}: ${app.notes} notes, sync: ${app.sync}.`);
    return;
  }
  const exe = installedApp();
  console.log("Notebloom isn't running (or 'AI 도구 연결' is turned off in the app).");
  console.log(exe ? `It will be started automatically when an AI tool needs it: ${exe}` : "Open the Notebloom desktop app to use it from AI tools.");
  process.exitCode = 1;
}

const commands = { serve, status };
const command = process.argv[2] ?? "serve";
if (!commands[command]) {
  console.error(`Unknown command "${command}". Use: status (or no argument to run the MCP server).`);
  process.exit(2);
}
try {
  await commands[command]();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
