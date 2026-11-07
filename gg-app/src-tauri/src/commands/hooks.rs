//! Hook-preset proxies: the per-project switch and the `.gg/hooks.json` config.

use super::agent_admin::json_or_error;
use crate::*;

/// Proxy: this window's hooks switch, config, detected commands and recent events.
#[tauri::command]
pub(crate) async fn agent_get_hooks(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/hooks", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to read the hooks settings").await
}

/// Proxy: change the hooks switch (saved per project in gg-app.json) and/or the
/// config (saved to the project's `.gg/hooks.json`). Both optional; the
/// sidecar validates them (400 → Err).
#[tauri::command]
pub(crate) async fn agent_set_hooks(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    enabled: Option<bool>,
    config: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let mut body = serde_json::Map::new();
    if let Some(enabled) = enabled {
        body.insert("enabled".into(), serde_json::Value::Bool(enabled));
    }
    if let Some(config) = config {
        body.insert("config".into(), config);
    }
    let res = client
        .post(format!("{}/hooks", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to save the hooks settings").await
}
