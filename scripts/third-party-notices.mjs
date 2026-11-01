// 앱에 함께 배포되는 오픈소스 패키지의 라이선스 고지를 public/THIRD_PARTY_NOTICES.txt 로 모은다.
// `npm run build` 때 자동 실행되어 웹/데스크톱/모바일 빌드에 포함된다.
//   npm run notices

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const outFile = path.join(root, "public", "THIRD_PARTY_NOTICES.txt");

function productionDirs() {
  let out;
  try {
    out = execSync("npm ls --omit=dev --all --parseable", { cwd: root, maxBuffer: 1 << 26 }).toString();
  } catch (e) {
    out = e.stdout?.toString() ?? ""; // 피어 의존성 경고가 있어도 목록은 나온다
  }
  return [...new Set(out.split(/\r?\n/).filter(Boolean).slice(1))];
}

function licenseTexts(dir) {
  return readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice)/i.test(f))
    .sort()
    .map((f) => readFileSync(path.join(dir, f), "utf8").trim());
}

const packages = new Map();
for (const dir of productionDirs()) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const key = `${pkg.name}@${pkg.version}`;
    if (packages.has(key)) continue;
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    packages.set(key, {
      key,
      license: typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "UNKNOWN"),
      repo: repo?.replace(/^git\+/, "").replace(/\.git$/, ""),
      texts: licenseTexts(dir),
    });
  } catch {
    /* package.json 이 없는 경로는 건너뛴다 */
  }
}

// npm 패키지가 아닌 출처
const extras = [
  {
    key: "Lucide icons (일부 UI 아이콘의 SVG 경로, src/components/ui.tsx)",
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

const entries = [...[...packages.values()].sort((a, b) => a.key.localeCompare(b.key)), ...extras];
const sep = "\n" + "=".repeat(78) + "\n";
const header = `Notebloom 은 아래의 오픈소스 소프트웨어를 포함하고 있습니다.
This application includes the following third-party open source software.

MPL-2.0 로 배포되는 구성 요소(BlockNote 등)는 수정하지 않고 사용했으며,
해당 소스 코드는 각 항목의 저장소 주소에서 받을 수 있습니다.
Source code for MPL-2.0 components is available at the repository URLs below.
`;

const body = entries
  .map(
    (e) =>
      `${e.key}\nLicense: ${e.license}${e.repo ? `\nSource: ${e.repo}` : ""}\n\n${
        e.texts.length ? e.texts.join("\n\n---\n\n") : `(패키지에 라이선스 파일이 없음 / license file not included: ${e.license})`
      }`,
  )
  .join(sep);

writeFileSync(outFile, header + sep + body + "\n");
console.log(`THIRD_PARTY_NOTICES.txt: ${entries.length} entries`);
