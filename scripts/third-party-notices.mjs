// Collects the license notices of the open source components shipped with the app
// (npm packages + Rust crates) into public/THIRD_PARTY_NOTICES.txt. Runs automatically on
// `npm run build`, so the file is included in the web, desktop and mobile builds.
//   npm run notices
// Components that share an identical license text are grouped so the text appears only once.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const spdx = createRequire(import.meta.url)("spdx-license-list/full");
const root = process.cwd();
const outFile = path.join(root, "public", "THIRD_PARTY_NOTICES.txt");

function licenseTexts(dir) {
  return readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice)/i.test(f))
    .sort()
    .map((f) => readFileSync(path.join(dir, f), "utf8").trim());
}

/**
 * For components that don't ship a license file: attach the standard SPDX text of the declared license.
 * With a choice ("A OR B") MIT is used if offered, otherwise the first one; "A AND B" includes all.
 */
function standardTexts(expr, holder) {
  const ids = expr.split(/\s+OR\s+|\s+AND\s+|\s*\/\s*|[()]/).map((s) => s.trim()).filter(Boolean);
  const chosen = /\bAND\b/.test(expr) ? ids : [ids.includes("MIT") ? "MIT" : ids[0]];
  return chosen.map((id) => {
    const text = spdx[id]?.licenseText;
    if (!text) return `(${id}: https://spdx.org/licenses/${id}.html)`;
    return `[${id} — standard SPDX text (the package ships no license file)]\n\n${text
      .replace(/<year>\s*<(copyright holders|owner)>/g, holder)
      .trim()}`;
  });
}

const cleanRepo = (url) => url?.replace(/^git\+/, "").replace(/\.git$/, "");

// ---- npm packages (production dependencies) ----

function npmComponents() {
  let out;
  try {
    out = execSync("npm ls --omit=dev --all --parseable", { cwd: root, maxBuffer: 1 << 26 }).toString();
  } catch (e) {
    out = e.stdout?.toString() ?? ""; // the list is still printed even with peer-dependency warnings
  }
  const list = new Map();
  for (const dir of new Set(out.split(/\r?\n/).filter(Boolean).slice(1))) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      const id = `${pkg.name}@${pkg.version}`;
      if (list.has(id)) continue;
      list.set(id, {
        id: `npm: ${id}`,
        license: typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "UNKNOWN"),
        repo: cleanRepo(typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url),
        texts: licenseTexts(dir),
        holder: typeof pkg.author === "string" ? pkg.author : (pkg.author?.name ?? `${pkg.name} contributors`),
      });
    } catch {
      /* skip paths without a package.json */
    }
  }
  return [...list.values()];
}

// ---- Rust crates (normal dependencies linked into the Tauri app; build-only dependencies excluded) ----

function rustComponents() {
  const manifest = path.join(root, "src-tauri", "Cargo.toml");
  if (!existsSync(manifest)) return [];
  let meta;
  try {
    meta = JSON.parse(
      execSync(`cargo metadata --format-version 1 --locked --manifest-path "${manifest}"`, {
        cwd: root,
        maxBuffer: 1 << 28,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString(),
    );
  } catch {
    console.warn("Can't run `cargo metadata`; skipping Rust crate notices (is Rust installed / Cargo.lock present?).");
    return [];
  }
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
  // Includes dependencies for every target platform (Windows/macOS/Linux/Android/iOS), so slightly broader than any single build.
  const seen = new Set();
  const stack = [meta.resolve.root];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id)?.deps ?? []) {
      if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
    }
  }
  seen.delete(meta.resolve.root);
  return [...seen].map((id) => {
    const p = pkgs.get(id);
    const dir = path.dirname(p.manifest_path);
    const texts = licenseTexts(dir);
    if (!texts.length && p.license_file) texts.push(readFileSync(path.join(dir, p.license_file), "utf8").trim());
    const holder = p.authors?.length ? p.authors.map((a) => a.replace(/\s*<[^>]*>/, "")).join(", ") : `${p.name} contributors`;
    return { id: `crate: ${p.name}@${p.version}`, license: p.license ?? "UNKNOWN", repo: p.repository, texts, holder };
  });
}

// ---- Sources that aren't npm packages or crates ----

const extras = [
  {
    id: "Lucide icons (SVG paths of some UI icons, src/components/ui.tsx)",
    license: "ISC",
    repo: "https://github.com/lucide-icons/lucide",
    texts: [
      `ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
    ],
  },
];

// ---- Output: group components with identical license texts ----

const npm = npmComponents();
const crates = rustComponents();
const all = [...npm, ...crates, ...extras].sort((a, b) => a.id.localeCompare(b.id));

const groups = new Map();
for (const c of all) {
  const texts = c.texts.length ? c.texts : standardTexts(c.license, c.holder ?? "the authors");
  const body = texts.join("\n\n---\n\n");
  const key = createHash("sha1").update(body).digest("hex");
  if (!groups.has(key)) groups.set(key, { body, members: [] });
  groups.get(key).members.push(c);
}

const sep = "\n" + "=".repeat(78) + "\n";
const header = `Notebloom includes the following third-party open source software.

Components distributed under MPL-2.0 (such as BlockNote) are used unmodified;
their source code is available at the Source URLs listed below.

npm packages: ${npm.length}, Rust crates: ${crates.length}, other: ${extras.length}
`;

const body = [...groups.values()]
  .map(
    (g) =>
      g.members.map((m) => `${m.id}\n  License: ${m.license}${m.repo ? `\n  Source: ${m.repo}` : ""}`).join("\n") +
      "\n\n" +
      g.body,
  )
  .join(sep);

writeFileSync(outFile, header + sep + body + "\n");
console.log(`THIRD_PARTY_NOTICES.txt: npm ${npm.length}, crates ${crates.length}, other ${extras.length} (${groups.size} unique license texts)`);
