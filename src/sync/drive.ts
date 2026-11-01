import { httpFetch } from "../platform";

/**
 * Google Drive REST API(v3) 클라이언트. 사용자의 Drive 에 'Notebloom' 폴더를 만들고
 * 문서마다 파일 하나(`{문서이름}.yjs`)를 저장한다. 권한은 drive.file 이라 이 앱이 만든 파일에만 접근한다.
 * 파일은 appProperties 표시로 찾으므로, 사용자가 폴더 이름을 바꾸거나 파일을 옮겨도 계속 동기화된다.
 */

const MOCK = import.meta.env.VITE_MOCK_GOOGLE_URL as string | undefined;
export const usingMockGoogle = Boolean(MOCK);
export const GOOGLE_API = MOCK ?? "https://www.googleapis.com";
const DRIVE = `${GOOGLE_API}/drive/v3`;
const UPLOAD = `${GOOGLE_API}/upload/drive/v3`;
const FILE_FIELDS = "id,name,version";
const FOLDER_NAME = "Notebloom";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** 이 앱이 만든 파일을 찾는 표시 (appProperties.notebloom) */
const MARK = "notebloom";
const markQuery = (value: "folder" | "doc") => `appProperties has { key='${MARK}' and value='${value}' } and trashed = false`;

export interface RemoteFile {
  id: string;
  name: string;
  version: string;
}

export interface RemoteChange {
  fileId: string;
  removed: boolean;
  file?: RemoteFile & { trashed?: boolean };
}

export class AuthError extends Error {}
export class NotFoundError extends Error {}

export class DriveClient {
  private folderId: Promise<string> | null = null;

  constructor(private getToken: (forceRefresh?: boolean) => Promise<string>) {}

  private async request(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const token = await this.getToken(retried);
    const res = await httpFetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      if (!retried) return this.request(url, init, true); // 토큰 갱신 후 한 번 더
      throw new AuthError("Google 인증이 만료되었습니다.");
    }
    if (res.status === 404) throw new NotFoundError(url);
    if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`);
    return res;
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    return (await this.request(url, init)).json() as Promise<T>;
  }

  async listAll(): Promise<RemoteFile[]> {
    const files: RemoteFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        spaces: "drive",
        q: markQuery("doc"),
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: "1000",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await this.json<{ files: RemoteFile[]; nextPageToken?: string }>(`${DRIVE}/files?${params}`);
      files.push(...data.files);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return files;
  }

  async startPageToken(): Promise<string> {
    const data = await this.json<{ startPageToken: string }>(`${DRIVE}/changes/startPageToken`);
    return data.startPageToken;
  }

  /** pageToken 이후 바뀐 파일 목록 (다른 기기의 저장 감지용, 변경이 없으면 응답이 아주 작다) */
  async changes(pageToken: string): Promise<{ changes: RemoteChange[]; newToken: string }> {
    const changes: RemoteChange[] = [];
    let token = pageToken;
    for (;;) {
      const params = new URLSearchParams({
        pageToken: token,
        spaces: "drive",
        pageSize: "1000",
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS},trashed))`,
      });
      const data = await this.json<{ changes: RemoteChange[]; nextPageToken?: string; newStartPageToken?: string }>(
        `${DRIVE}/changes?${params}`,
      );
      changes.push(...data.changes);
      if (data.newStartPageToken) return { changes, newToken: data.newStartPageToken };
      token = data.nextPageToken!;
    }
  }

  async download(id: string): Promise<Uint8Array> {
    const res = await this.request(`${DRIVE}/files/${id}?alt=media`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** 노트를 저장할 'Notebloom' 폴더 id (없으면 만든다). 두 기기가 동시에 만들었으면 먼저 만든 쪽을 쓴다. */
  private ensureFolder(): Promise<string> {
    this.folderId ??= (async () => {
      const params = new URLSearchParams({ spaces: "drive", q: markQuery("folder"), fields: "files(id,createdTime)" });
      const { files } = await this.json<{ files: { id: string; createdTime?: string }[] }>(`${DRIVE}/files?${params}`);
      if (files.length) return [...files].sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? ""))[0].id;
      const folder = await this.json<{ id: string }>(`${DRIVE}/files?fields=id`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({
          name: FOLDER_NAME,
          mimeType: FOLDER_MIME,
          appProperties: { [MARK]: "folder" },
          description: "Notebloom 노트 동기화 데이터입니다. 앱이 관리하므로 안의 파일을 직접 수정하거나 지우지 마세요.",
        }),
      });
      return folder.id;
    })().catch((e) => {
      this.folderId = null; // 다음에 다시 시도
      throw e;
    });
    return this.folderId;
  }

  async create(name: string, data: Uint8Array): Promise<RemoteFile> {
    try {
      return await this.createIn(await this.ensureFolder(), name, data);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      this.folderId = null; // 사용자가 폴더를 지웠으면 새로 만들어 다시 올린다.
      return this.createIn(await this.ensureFolder(), name, data);
    }
  }

  private async createIn(folderId: string, name: string, data: Uint8Array): Promise<RemoteFile> {
    const boundary = `notebloom${Math.random().toString(36).slice(2)}`;
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name, parents: [folderId], appProperties: { [MARK]: "doc" } }) +
        `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + data.length + tail.length);
    body.set(head, 0);
    body.set(data, head.length);
    body.set(tail, head.length + data.length);
    return this.json<RemoteFile>(`${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  async update(id: string, data: Uint8Array): Promise<RemoteFile> {
    return this.json<RemoteFile>(`${UPLOAD}/files/${id}?uploadType=media&fields=${FILE_FIELDS}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/octet-stream" },
      body: data as Uint8Array<ArrayBuffer>,
    });
  }

  async remove(id: string) {
    try {
      await this.request(`${DRIVE}/files/${id}`, { method: "DELETE" });
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }
}
