# Notebloom MCP server

Lets AI tools such as **Claude** (Desktop and Code), **Cursor**, and any other [MCP](https://modelcontextprotocol.io) client
read and edit your Notebloom notes. Ask things like *"summarize my meeting notes from this week"*,
*"add these action items to my Project X note"* or *"organize my reading list under a new Books note"*.

It talks directly to the **Notebloom desktop app on your computer**: changes appear in the open app instantly and sync to
your other devices through Google Drive as usual. No extra sign-in is needed, and it works offline.

## Tools

| Tool | What it does |
| --- | --- |
| `list_notes` | All notes as an outline (sub-notes under their parent), with ids |
| `search_notes` | Notes whose title or content contains some text, with snippets |
| `read_note` | A note's title, location, sub-notes and content (Markdown) |
| `create_note` | New note with a title, optional Markdown content, parent note and emoji icon |
| `append_to_note` | Add Markdown to the end of a note (existing content untouched) |
| `replace_note_content` | Rewrite a note's content (blocks whose text is unchanged keep their formatting) |
| `update_note` | Rename, change the icon, or move a note (into another note or to the top level) |
| `move_note_to_trash` / `restore_note` | Trash a note (and its sub-notes) or bring it back |

There's deliberately no tool for deleting notes permanently: anything an AI removes stays in the app's trash.

## Setup

Requires Node.js 20+ and the Notebloom desktop app (Windows, macOS or Linux).

1. Install the server's dependencies (once):

   ```bash
   cd mcp
   ```

   ```bash
   npm install
   ```

2. Add it to your AI tool. Use the absolute path to `mcp/server.mjs` in your checkout.

   **Claude Code**

   ```bash
   claude mcp add notebloom --scope user -- node /path/to/notebloom/mcp/server.mjs
   ```

   **Claude Desktop**: Settings → Developer → Edit Config, then add to `claude_desktop_config.json` and restart Claude:

   ```json
   {
     "mcpServers": {
       "notebloom": {
         "command": "node",
         "args": ["C:\\path\\to\\notebloom\\mcp\\server.mjs"]
       }
     }
   }
   ```

   **Cursor**: the same `mcpServers` entry in `~/.cursor/mcp.json`.

   **Other clients**: run `node /path/to/notebloom/mcp/server.mjs` as a stdio MCP server.

3. Open Notebloom. Check the connection with `npm run status`.

If the app isn't running when the AI needs it, the server starts it (once an installed release build has been opened at least once,
so the server knows where it is). The connection can be turned off in the app: account/sync dialog → **AI 도구 연결 (MCP)**.

## How it works

```
 AI tool (Claude, Cursor…)
   │ MCP over stdio
 mcp/server.mjs ── HTTP on 127.0.0.1 (random port, access token) ──▶ Notebloom desktop app
                                                                      ├─ notes (Yjs, on this device)
                                                                      └─ sync engine ──▶ Google Drive ──▶ other devices
```

- On start, the app listens on a random `127.0.0.1` port and writes the port and a new random access token to
  `ai-bridge.json` in its data folder (`%APPDATA%\io.github.jaeryu.notebloom` on Windows,
  `~/Library/Application Support/io.github.jaeryu.notebloom` on macOS, `~/.local/share/io.github.jaeryu.notebloom` on Linux).
  The file is removed when the app quits or the connection is turned off.
- The native side ([src-tauri/src/ai_bridge.rs](../src-tauri/src/ai_bridge.rs)) hands each request to the app's frontend
  ([src/ai/](../src/ai)), which edits the same notes the editor shows. Edits are ordinary Yjs changes, so they merge with
  whatever you're typing and sync like your own edits.
- **Markdown in, Markdown out**, using the editor's own converter. Things Markdown can't express, such as text colors, are lost
  only in blocks the AI actually changes: `replace_note_content` keeps every block whose text is unchanged as it was.

## Security

- The app only accepts connections from this computer (`127.0.0.1`), only with the access token, and rejects requests that
  come from web pages (`Origin` header) or through other host names (DNS rebinding). The token changes every time the app starts,
  and the file holding it is readable only by your user account (on macOS/Linux it's created with mode 600; on Windows it's in your profile).
- Any AI tool you connect can read all your notes and change them (but not delete them permanently). Only connect tools you trust,
  and turn the connection off in the app when you don't want AI access.
- Note content goes to the AI provider as part of the conversation, like anything else you share with the AI.
- Text inside notes is just data to the AI, but a note copied from an untrusted source could contain instructions aimed at the AI
  (prompt injection). Most AI tools ask before running tools that change things; keep that confirmation on.

## Development

Run the desktop app in development (`npm run desktop:dev` in the repo root) and the server connects to it the same way.
To test against an isolated copy of the app data instead of your own notes, run the dev app in mock mode on port 5174:

```bash
npx tauri dev --config '{"build":{"devUrl":"http://127.0.0.1:5174","beforeDevCommand":"npm run dev:mock"}}'
```

| Environment variable | Purpose |
| --- | --- |
| `NOTEBLOOM_APP_DATA_DIR` | The app's data folder, if it isn't in the default location |
| `NOTEBLOOM_NO_LAUNCH` | Don't start the app automatically |
