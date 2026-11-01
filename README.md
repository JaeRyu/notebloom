# Notebloom

Notion 스타일의 **개인 노트 앱**입니다. 하나의 코드베이스로 Windows, macOS, Linux, Android, iOS, 웹에서 실행되며,
노트는 **내 Google Drive** 에 저장되어 같은 Google 계정으로 로그인한 모든 기기와 자동 동기화됩니다.
별도 서버가 없고 Firebase 도 쓰지 않습니다.

## 주요 기능

- **블록 에디터**: `/` 슬래시 명령, 제목/목록/체크리스트/표/코드/인용 블록, 블록 드래그, 마크다운 단축키 (한국어 UI)
- **노트 계층**: 무제한 하위 페이지, 사이드바에서 드래그 앤 드롭으로 이동, 브레드크럼
- **로컬 우선**: 모든 노트는 먼저 기기(IndexedDB)에 저장 → 로그인 없이도, 오프라인에서도 동작
- **Google Drive 동기화**: 편집 후 약 1.5초 뒤 업로드, 다른 기기는 5초 간격으로 변경을 감지해 반영
- **충돌 없는 병합**: 두 기기에서 오프라인으로 같은 문단을 고쳐도 다시 연결되면 양쪽 편집이 모두 합쳐짐 (Yjs CRDT)
- **휴지통**(복원 / 모든 기기에서 영구 삭제), **빠른 검색** `Ctrl/Cmd + K`, 다크 모드, 모바일 레이아웃

## 동작 방식

```
 기기 A (Windows 앱)          기기 B (Android 앱)          기기 C (웹)
 ┌──────────────────┐        ┌──────────────────┐
 │ 에디터 ↔ Yjs 문서 │        │ 에디터 ↔ Yjs 문서 │        ...
 │   ↕ IndexedDB    │        │   ↕ IndexedDB    │
 └────────┬─────────┘        └────────┬─────────┘
          │  업로드/다운로드 (Drive REST API)  │
          └───────────────┬───────────────────┘
              내 Google Drive · 앱 전용 숨김 폴더 (appDataFolder)
                index.yjs              페이지 목록·제목·계층
                note-{id}.yjs          노트 본문 (노트마다 하나)
```

- 앱은 `drive.appdata` 권한만 요청합니다. 이 앱이 만든 숨김 폴더에만 접근하며, Drive 의 다른 파일은 볼 수 없습니다.
- 동기화 = 원격 파일 다운로드 → 로컬 문서에 병합 → 로컬에만 있는 내용이 있으면 업로드.
  Yjs 는 병합 순서와 무관하게 같은 결과를 내고 중복 병합에도 안전해서, 두 기기가 동시에 업로드해 한쪽이 덮어써져도
  다음 확인 때 차이를 발견하고 다시 올려 결국 모든 편집이 합쳐집니다.
- 다른 기기의 변경은 Drive **changes API** 로 확인하므로, 바뀐 게 없으면 요청이 매우 가볍습니다.

핵심 코드: [src/sync/engine.ts](src/sync/engine.ts) (동기화), [src/sync/drive.ts](src/sync/drive.ts) (Drive API),
[src/sync/auth.ts](src/sync/auth.ts) (Google 로그인), [src/store/docs.ts](src/store/docs.ts) (로컬 저장)

## 빠르게 실행해 보기 (Google 계정 없이)

모의 Google 서버로 로그인·동기화를 시험할 수 있습니다. 필요: Node.js 20+

```bash
npm install
```

터미널 1 (모의 Google Drive):

```bash
npm run mock-drive
```

터미널 2 (앱):

```bash
npm run dev:mock
```

- <http://localhost:5173> 와 <http://127.0.0.1:5173> 은 저장소가 따로라서 **서로 다른 기기**처럼 동작합니다. 둘 다 열고 각각 연결해 보세요.
- 연결하면 기기 코드가 표시됩니다. <http://127.0.0.1:8787/device> 에서 그 코드를 입력해 승인하세요.
- 모의 서버를 껐다 켜면 오프라인 → 재연결 상황을 재현할 수 있습니다 (데이터는 `.mock-drive.json` 에 유지).

## Google Drive 연결 설정 (실제 사용)

모두 무료이며 결제 계정이 필요 없습니다. <https://console.cloud.google.com> 에서:

1. **프로젝트 만들기**
2. **API 및 서비스 → 라이브러리** 에서 `Google Drive API` 사용 설정
3. **API 및 서비스 → OAuth 동의 화면**
   - 사용자 유형 `외부`, 앱 이름/이메일 입력
   - 범위 추가: `.../auth/drive.appdata`, `openid`, `email`, `profile`
   - 테스트 사용자에 본인 Gmail 추가
   - 참고: 게시 상태가 `테스트`이면 Google 정책상 앱 로그인(갱신 토큰)이 7일마다 만료됩니다. 계속 쓰려면 `프로덕션으로 게시`하세요.
     `drive.appdata` 는 Google 이 권장하는 좁은 범위라 심사 부담이 적은 편이며, 정확한 요구 사항은 콘솔에 표시됩니다.
4. **API 및 서비스 → 사용자 인증 정보 → OAuth 클라이언트 ID 만들기** 를 두 번:
   - `웹 애플리케이션` — 승인된 JavaScript 원본에 `http://localhost:5173` (와 웹 배포 주소) 추가 → 웹용
   - `TV 및 입력 제한 기기` — 데스크톱/모바일 앱용 (클라이언트 ID + 보안 비밀)
5. `.env.example` 을 `.env.local` 로 복사하고 위 값 입력
6. 실행:

```bash
npm run dev
```

로그인 방식:
- **웹**: Google 로그인 팝업. 브라우저 정책상 갱신 토큰이 없어서 1시간 뒤 "다시 연결"을 눌러야 합니다.
- **앱**(Windows·macOS·Android·iOS): 화면에 표시된 코드를 브라우저에서 한 번 입력하면 이후 자동으로 로그인이 유지됩니다.
  네이티브 플러그인 없이 모든 플랫폼에서 같은 방식으로 동작합니다.

## 데스크톱 / 모바일 앱 빌드 (Tauri 2)

사전 준비: [Tauri 사전 요구 사항](https://v2.tauri.app/start/prerequisites/) — Rust(`rustup`), Windows는 WebView2(기본 설치)와 MSVC 빌드 도구,
macOS는 Xcode, Android는 Android Studio + SDK/NDK (`ANDROID_HOME`, `NDK_HOME` 환경 변수).

| 플랫폼 | 개발 실행 | 배포용 빌드 |
| --- | --- | --- |
| Windows / macOS / Linux | `npm run desktop:dev` | `npm run desktop:build` (각 OS에서 빌드) |
| Android | `npm run android:init` 후 `npm run android:dev` | `npm run android:build` |
| iOS (macOS 필요) | `npm run ios:init` 후 `npm run ios:dev` | `npx tauri ios build` |

- 앱 식별자 [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) 의 `identifier`(`io.github.jaeryu.notebloom`)는 Android 패키지 이름이 되며 나중에 바꾸기 어렵습니다. GitHub 아이디가 다르면 `npm run android:init` 전에 고치세요.
- 앱의 네트워크 허용 목록은 [src-tauri/capabilities/default.json](src-tauri/capabilities/default.json) 에 있습니다 (Google 로그인/Drive API 주소만 허용).
  앱(Tauri)에서 모의 서버로 시험하려면 개발 중에만 `{ "url": "http://127.0.0.1:8787/*" }` 를 임시로 추가하세요.

## 프로젝트 구조

```
src/
  store/docs.ts        Yjs 문서 + IndexedDB 저장 (문서 공유/해제)
  store/notes.ts       페이지 목록(index 문서): 생성/수정/휴지통/영구 삭제
  sync/auth.ts         Google 로그인 (웹 팝업 / 앱 기기 코드), 토큰 갱신
  sync/drive.ts        Google Drive REST API (appDataFolder, changes, 업로드)
  sync/engine.ts       동기화 엔진 (변경 감지, 병합, 업로드, 삭제 전파, 계정 전환)
  components/          Sidebar, PageView, Editor, Home, Dialogs, ui
  platform.ts          웹/앱(Tauri) 차이 처리 (HTTP, 외부 링크)
scripts/mock-drive.mjs 개발용 모의 Google 서버
src-tauri/             Tauri 2 네이티브 셸
```

## 알려진 제약 / 다음 단계

- 이미지·파일 첨부 없음 (Drive 에 별도 파일로 올리는 방식으로 추가 가능)
- 검색은 노트 제목만 대상
- 앱의 로그인 토큰은 앱 저장소(localStorage)에 보관 → OS 키체인 저장으로 강화 가능
- 같은 브라우저의 여러 탭에서 같은 노트를 동시에 열면 탭끼리는 실시간 반영되지 않음 (Drive 를 거쳐 몇 초 뒤 반영)
- 노트 버전 기록, 내보내기(Markdown/PDF), 템플릿

## 라이선스

[MIT](LICENSE)

에디터로 쓰는 [BlockNote](https://github.com/TypeCellOS/BlockNote) 의 핵심 패키지는 MPL-2.0 입니다. npm 패키지를 그대로 쓰는 것은 문제없지만,
BlockNote 소스 파일 자체를 수정해 배포하면 그 파일은 MPL-2.0 으로 공개해야 합니다. (`@blocknote/xl-*` 패키지는 GPL/상용 라이선스이니 추가 시 주의)

배포용 빌드(`npm run build`, `npm run desktop:build` 등)에는 사용한 오픈소스 패키지의 라이선스 원문이
`THIRD_PARTY_NOTICES.txt` 로 자동 포함됩니다 ([scripts/third-party-notices.mjs](scripts/third-party-notices.mjs)).
데스크톱/모바일 앱을 배포할 때는 Rust 크레이트(Tauri 등) 고지도 함께 넣어야 하므로 `cargo about` 같은 도구로 추가하세요.
