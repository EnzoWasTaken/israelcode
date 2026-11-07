//! Verify-loop proxies: the per-project switch, the commands and "Run checks now".

use super::agent_admin::json_or_error;
use crate::*;

/// Proxy: this window's verify switch, commands and whether a loop runs.
#[tauri::command]
pub(crate) async fn agent_get_verify(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/verify", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to read the verify settings").await
}

/// Proxy: change the verify switch (saved per project in gg-app.json) and/or
/// the commands and round cap (saved to the project's `.gg/verify.json`).
/// Every field is optional; the sidecar validates them (400 → Err).
#[tauri::command]
pub(crate) async fn agent_set_verify(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    enabled: Option<bool>,
    commands: Option<serde_json::Value>,
    max_rounds: Option<u32>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let mut body = serde_json::Map::new();
    if let Some(enabled) = enabled {
        body.insert("enabled".into(), serde_json::Value::Bool(enabled));
    }
    if let Some(commands) = commands {
        body.insert("commands".into(), commands);
    }
    if let Some(max_rounds) = max_rounds {
        body.insert("maxRounds".into(), serde_json::Value::from(max_rounds));
    }
    let res = client
        .post(format!("{}/verify", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to save the verify settings").await
}

/// Proxy: run the project's checks now (409 while a run is active → Err).
#[tauri::command]
pub(crate) async fn agent_run_verify(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/verify/run", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to start the checks").await
}
