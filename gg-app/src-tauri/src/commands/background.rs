//! Daemon-level proxies for persistent background sessions. No `x-gg-session`
//! header: these act on sessions across windows.

use crate::*;

async fn background_json(res: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = res.status();
    let value = res.json::<serde_json::Value>().await.map_err(|e| {
        format!(
            "background sessions: bad daemon response ({status}): {}",
            e.without_url()
        )
    })?;
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("background sessions request failed")
            .to_string());
    }
    Ok(value)
}

async fn post_background(
    webview: &WebviewWindow,
    client: &reqwest::Client,
    path: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let port = port_for(webview).ok_or("daemon not ready")?;
    let res = client
        .post(format!("{}/background-sessions/{path}", sidecar_base(port)))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    background_json(res).await
}

/// Proxy: every session the daemon is holding (running, finished, detached).
#[tauri::command]
pub(crate) async fn background_sessions_list(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .get(format!("{}/background-sessions", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    background_json(res).await
}

/// Proxy: stop a running background session.
#[tauri::command]
pub(crate) async fn background_session_stop(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: String,
) -> Result<serde_json::Value, String> {
    post_background(&webview, &client, "stop", serde_json::json!({ "id": id })).await
}

/// Proxy: drop a finished session from the list (keeps the conversation file).
#[tauri::command]
pub(crate) async fn background_session_dismiss(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: Option<String>,
    session_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "id": id, "sessionPath": session_path });
    post_background(&webview, &client, "dismiss", body).await
}

/// Proxy: stop, dispose and delete the conversation file.
#[tauri::command]
pub(crate) async fn background_session_delete(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    id: Option<String>,
    session_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "id": id, "sessionPath": session_path });
    post_background(&webview, &client, "delete", body).await
}
