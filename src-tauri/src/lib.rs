// 앱 로직은 전부 웹 프런트엔드(React + Yjs)에 있고, Tauri 는 각 OS 의 네이티브 셸 역할만 한다.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 노트 안의 외부 링크와 Google 로그인 페이지를 시스템 기본 브라우저로 연다.
        .plugin(tauri_plugin_opener::init())
        // Google OAuth / Drive API 호출 (웹뷰의 CORS 제약 없이)
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
