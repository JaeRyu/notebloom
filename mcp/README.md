# Notebloom MCP server

Lets AI tools such as **Claude** (Desktop and Code), **Cursor**, and any other [MCP](https://modelcontextprotocol.io) client
read and edit your Notebloom notes. Ask things like *"summarize my meeting notes from this week"*,
*"add these action items to my Project X note"* or *"organize my reading list under a new Books note"*.

It works directly with the notes in your Google Drive, so changes show up in the Notebloom app on all your devices
within a few seconds, even while the app is open. The app doesn't need to be running.

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

Requires Node.js 20+ and a Notebloom checkout where Google Drive is already set up (`npm run setup:google`, see the main README).

1. Install and sign in (once):

   ```bash
   cd mcp
   ```

   ```bash
   npm install
   ```

   ```bash
   npm run login
   ```

   This shows a code to enter at google.com/device, just like the app. Sign in with the same Google account you use in Notebloom.
   Check it with `npm run status`.

2. Add the server to your AI tool. Use the absolute path to `mcp/server.mjs` in your checkout.

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

## How it works

- **Same data as the app.** The server reads and writes the app's own files in the `Notebloom` Drive folder
  (`index.yjs` for the page list, `note-{id}.yjs` per note) using the same Yjs document format and BlockNote content model.
- **Safe alongside the app.** Every change downloads the latest file, merges it, and uploads the merged result, so it never
  throws away edits made in the app. If a device uploads at the very same moment and replaces the server's upload,
  the server notices when it checks back (after about 4, 15 and 45 seconds) and uploads the merged version again.
- **Markdown in, Markdown out.** Notes are converted with BlockNote's own Markdown support. Things Markdown can't express,
  such as text colors, are lost only in blocks the AI actually changes: `replace_note_content` keeps every block whose text is unchanged as it was.
- **Same Google client and scope as the app.** It signs in with the "TVs and Limited Input devices" OAuth client from
  the repo's `.env.local` (or `NOTEBLOOM_GOOGLE_CLIENT_ID` / `NOTEBLOOM_GOOGLE_CLIENT_SECRET`) and asks only for `drive.file`.
  It must be the same Google Cloud project as the app you use, because `drive.file` only gives access to files created by that project.

## Security

- The sign-in is stored in `~/.notebloom/mcp-token.json` (readable only by your user on macOS/Linux). It grants access to
  your Notebloom files only, nothing else in your Drive. `npm run logout` deletes it and revokes the access at Google.
- Any AI tool you connect can read all your notes and change them (but not delete them permanently). Only connect tools you trust.
- Note content goes to the AI provider as part of the conversation, like anything else you share with the AI.
- Text inside notes is just data to the AI, but a note copied from an untrusted source could contain instructions aimed at the AI
  (prompt injection). Most AI tools ask before running tools that change things; keep that confirmation on.

## Development

Test against the mock Google server instead of your real Drive:

```bash
npm run mock-drive
```

(in the repo root), then in `mcp/`:

```bash
NOTEBLOOM_MOCK_GOOGLE_URL=http://127.0.0.1:8787 node server.mjs login
```

Approve the code at <http://127.0.0.1:8787/device>. Mock sign-ins are stored separately (`~/.notebloom/mcp-token.mock.json`).
Run the app with `npm run dev:mock` to watch changes arrive.

| Environment variable | Purpose |
| --- | --- |
| `NOTEBLOOM_GOOGLE_CLIENT_ID`, `NOTEBLOOM_GOOGLE_CLIENT_SECRET` | OAuth client (default: `VITE_GOOGLE_DEVICE_CLIENT_*` from the repo's `.env.local`) |
| `NOTEBLOOM_MCP_TOKEN_FILE` | Where to store the sign-in (default `~/.notebloom/mcp-token.json`) |
| `NOTEBLOOM_MOCK_GOOGLE_URL` | Use the mock Google server |
| `NO_BROWSER` | Don't open the browser during `login` |
