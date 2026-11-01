// 앱에 함께 배포되는 오픈소스 구성 요소(npm 패키지 + Rust 크레이트)의 라이선스 고지를
// public/THIRD_PARTY_NOTICES.txt 로 모은다. `npm run build` 때 자동 실행되어 웹/데스크톱/모바일 빌드에 포함된다.
//   npm run notices
// 같은 라이선스 원문을 쓰는 구성 요소는 묶어서 원문을 한 번만 싣는다.

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
 * 라이선스 파일을 패키지에 넣지 않은 구성 요소용: 선언된 SPDX 라이선스의 표준 원문을 붙인다.
 * "A OR B" 처럼 고를 수 있으면 MIT 를, 없으면 첫 번째를 적용하고, "A AND B" 는 모두 싣는다.
 */
function standardTexts(expr, holder) {
  const ids = expr.split(/\s+OR\s+|\s+AND\s+|\s*\/\s*|[()]/).map((s) => s.trim()).filter(Boolean);
  const chosen = /\bAND\b/.test(expr) ? ids : [ids.includes("MIT") ? "MIT" : ids[0]];
  return chosen.map((id) => {
    const text = spdx[id]?.licenseText;
    if (!text) return `(${id}: https://spdx.org/licenses/${id}.html)`;
    return `[${id} — 패키지에 라이선스 파일이 없어 SPDX 표준 원문을 첨부 / standard SPDX text]\n\n${text
      .replace(/<year>\s*<(copyright holders|owner)>/g, holder)
      .trim()}`;
  });
}

const cleanRepo = (url) => url?.replace(/^git\+/, "").replace(/\.git$/, "");

// ---- npm 패키지 (프로덕션 의존성) ----

function npmComponents() {
  let out;
  try {
    out = execSync("npm ls --omit=dev --all --parseable", { cwd: root, maxBuffer: 1 << 26 }).toString();
  } catch (e) {
    out = e.stdout?.toString() ?? ""; // 피어 의존성 경고가 있어도 목록은 나온다
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
      /* package.json 이 없는 경로는 건너뛴다 */
    }
  }
  return [...list.values()];
}

// ---- Rust 크레이트 (Tauri 앱에 링크되는 일반 의존성, 빌드 전용 의존성 제외) ----

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
    console.warn("cargo metadata 를 실행할 수 없어 Rust 크레이트 고지를 건너뜁니다 (Rust 설치 / Cargo.lock 확인).");
    return [];
  }
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
  // 모든 대상 플랫폼(Windows/macOS/Linux/Android/iOS)의 의존성을 포함하므로 실제보다 조금 넓다.
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
    const holder = p.authors?.length ? p.authors.map((a) => a.replace(/s*<[^>]*>/, "")).join(", ") : `${p.name} contributors`;
    return { id: `crate: ${p.name}@${p.version}`, license: p.license ?? "UNKNOWN", repo: p.repository, texts, holder };
  });
}

// ---- npm/crates 에 없는 출처 ----

const extras = [
  {
    id: "Lucide icons (일부 UI 아이콘의 SVG 경로, src/components/ui.tsx)",
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

// ---- 출력: 같은 원문끼리 묶기 ----

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
const header = `Notebloom 은 아래의 오픈소스 소프트웨어를 포함하고 있습니다.
This application includes the following third-party open source software.

MPL-2.0 로 배포되는 구성 요소(BlockNote 등)는 수정하지 않고 사용했으며,
해당 소스 코드는 각 항목의 Source 주소에서 받을 수 있습니다.
Source code for MPL-2.0 components is available at the Source URLs below.

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
