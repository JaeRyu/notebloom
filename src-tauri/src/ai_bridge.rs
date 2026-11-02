//! AI 도구 연결 (MCP).
//!
//! 이 컴퓨터의 AI 도구(Claude, Cursor 등)가 실행하는 Notebloom MCP 서버(저장소의 mcp/ 폴더)가
//! 실행 중인 앱과 직접 통신해 노트를 읽고 쓸 수 있게 한다.
//!
//! - 127.0.0.1 의 임의 포트에서 HTTP 요청을 받는다. 포트와 접속 토큰(앱을 켤 때마다 새로 만든다)은
//!   앱 데이터 폴더의 ai-bridge.json 에 적어 두며, 같은 사용자 계정으로 실행된 프로그램만 읽을 수 있다.
//! - 요청은 웹뷰(프런트엔드, src/ai/)로 넘겨 처리한다. 노트 데이터와 동기화 엔진이 거기에 있으므로
//!   AI 가 바꾼 내용은 화면에 바로 보이고 평소처럼 Google Drive 에 동기화된다.
//! - 웹 페이지가 보낸 요청(Origin 헤더)과 DNS 리바인딩(Host 헤더)은 거부하고, 토큰이 맞아야 처리한다.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tiny_http::{Header, Method, Request, Response, Server};

/// 실행 중인 앱의 접속 정보 (앱이 끝나면 지운다)
const INFO_FILE: &str = "ai-bridge.json";
/// 설치된 앱의 위치. MCP 서버가 앱이 꺼져 있을 때 실행하는 데 쓴다 (릴리스 빌드만 기록).
const LAUNCH_FILE: &str = "ai-launch.json";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_BODY: u64 = 8 * 1024 * 1024;

pub struct AiBridge(Arc<Inner>);

struct Inner {
    token: String,
    enabled: AtomicBool,
    port: Mutex<Option<u16>>,
    next_id: AtomicU64,
    /// 웹뷰의 응답을 기다리는 요청들
    pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
}

impl AiBridge {
    pub fn new() -> Self {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("no system random source");
        let token = bytes.iter().map(|b| format!("{b:02x}")).collect();
        Self(Arc::new(Inner {
            token,
            enabled: AtomicBool::new(false),
            port: Mutex::new(None),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
        }))
    }
}

/// 웹뷰가 요청을 처리할 준비가 되면 켜고, 사용자가 설정에서 끄면 끈다.
/// 처음 켤 때 서버를 시작하고, 켜져 있는 동안만 접속 정보 파일이 있다.
#[tauri::command]
pub fn ai_bridge_set_enabled(app: AppHandle, bridge: State<'_, AiBridge>, enabled: bool) -> Result<(), String> {
    if cfg!(mobile) {
        return Err("unsupported".into());
    }
    let inner = &bridge.0;
    if !enabled {
        inner.enabled.store(false, Ordering::SeqCst);
        remove_info(&app);
        return Ok(());
    }
    let port = {
        let mut port = inner.port.lock().unwrap();
        match *port {
            Some(p) => p,
            None => *port.insert(serve(app.clone(), inner.clone())?),
        }
    };
    inner.enabled.store(true, Ordering::SeqCst);
    let info = json!({
        "port": port,
        "token": inner.token,
        "pid": std::process::id(),
        "version": app.package_info().version.to_string(),
    });
    let path = data_file(&app, INFO_FILE).ok_or("no app data folder")?;
    write_private(&path, &info.to_string()).map_err(|e| e.to_string())
}

/// 웹뷰가 요청 `id` 의 처리 결과를 돌려준다.
#[tauri::command]
pub fn ai_bridge_respond(bridge: State<'_, AiBridge>, id: u64, response: Value) {
    if let Some(tx) = bridge.0.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(response);
    }
}

/// 앱 시작 시: 릴리스 빌드면 설치 위치를 기록한다.
pub fn remember_location(app: &AppHandle) {
    if cfg!(debug_assertions) || cfg!(mobile) {
        return; // 개발 빌드는 개발 서버 없이는 실행되지 않으므로 기록하지 않는다.
    }
    if let (Ok(exe), Some(path)) = (std::env::current_exe(), data_file(app, LAUNCH_FILE)) {
        let _ = write_private(&path, &json!({ "exe": exe }).to_string());
    }
}

/// 앱 종료 시
pub fn cleanup(app: &AppHandle) {
    remove_info(app);
}

fn serve(app: AppHandle, inner: Arc<Inner>) -> Result<u16, String> {
    let server = Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("no port")?;
    thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let (app, inner) = (app.clone(), inner.clone());
            thread::spawn(move || {
                let (status, body) = handle(&app, &inner, port, &mut request);
                let content_type = Header::from_bytes("Content-Type", "application/json").unwrap();
                let _ = request.respond(Response::from_string(body.to_string()).with_status_code(status).with_header(content_type));
            });
        }
    });
    Ok(port)
}

fn error(message: &str) -> Value {
    json!({ "ok": false, "error": message })
}

fn handle(app: &AppHandle, inner: &Inner, port: u16, request: &mut Request) -> (u16, Value) {
    let header = |name: &'static str| {
        request.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_owned())
    };
    // 브라우저는 다른 사이트로 보내는 요청에 항상 Origin 을 붙인다. 웹 페이지에서 온 요청은 받지 않는다.
    if header("Origin").is_some() {
        return (403, error("Requests from web pages are not allowed."));
    }
    // DNS 리바인딩(외부 도메인이 127.0.0.1 을 가리키게 하는 공격) 방지
    let host_ok = header("Host").is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"));
    let expected = format!("Bearer {}", inner.token);
    let auth_ok = header("Authorization").is_some_and(|v| constant_time_eq(v.as_bytes(), expected.as_bytes()));
    if !host_ok || !auth_ok {
        return (401, error("Not authorized."));
    }
    if *request.method() != Method::Post || request.url() != "/rpc" {
        return (404, error("Not found."));
    }
    if !inner.enabled.load(Ordering::SeqCst) {
        return (403, error("AI tool access is turned off in Notebloom (Google Drive dialog → AI tools)."));
    }

    let mut body = String::new();
    if request.as_reader().take(MAX_BODY).read_to_string(&mut body).is_err() {
        return (400, error("Could not read the request."));
    }
    let Ok(call) = serde_json::from_str::<Value>(&body) else {
        return (400, error("The request is not valid JSON."));
    };

    let id = inner.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    inner.pending.lock().unwrap().insert(id, tx);
    let payload = json!({ "id": id, "method": call["method"], "params": call["params"] });
    if app.emit_to("main", "ai-bridge-request", payload).is_err() {
        inner.pending.lock().unwrap().remove(&id);
        return (503, error("Notebloom's window is not available."));
    }
    match rx.recv_timeout(RESPONSE_TIMEOUT) {
        Ok(response) => (200, response),
        Err(_) => {
            inner.pending.lock().unwrap().remove(&id);
            (504, error("Notebloom didn't respond in time."))
        }
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn data_file(app: &AppHandle, name: &str) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(name))
}

/// 다른 사용자가 읽을 수 없게 쓰고, 읽는 쪽이 반쯤 쓴 파일을 보지 않도록 한 번에 바꿔 넣는다.
fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(&tmp)?.write_all(contents.as_bytes())?;
    fs::rename(&tmp, path)
}

/// 접속 정보 파일을 지운다. 앱을 여러 개 띄운 경우를 위해 이 프로세스가 쓴 파일일 때만 지운다.
fn remove_info(app: &AppHandle) {
    let Some(path) = data_file(app, INFO_FILE) else { return };
    let mine = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .is_some_and(|v| v["pid"].as_u64() == Some(std::process::id() as u64));
    if mine {
        let _ = fs::remove_file(path);
    }
}
