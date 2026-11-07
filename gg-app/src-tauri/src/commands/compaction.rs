//! Compaction-control proxies: the per-project trigger and pinned facts,
//! "Compact now" and "Undo last compaction".

use super::agent_admin::json_or_error;
use crate::*;

/// Proxy: this window's compaction preference and where the session stands.
#[tauri::command]
pub(crate) async fn agent_get_compaction(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/compaction", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to read the compaction settings").await
}

/// Proxy: change the trigger (threshold / token count; `null` drops an
/// override) and/or the pinned facts. Saved per project in gg-app.json and
/// applied to the live session; the sidecar validates (400 → Err).
#[tauri::command]
pub(crate) async fn agent_set_compaction(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    threshold: Option<serde_json::Value>,
    at_tokens: Option<serde_json::Value>,
    pins: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let mut body = serde_json::Map::new();
    if let Some(threshold) = threshold {
        body.insert("threshold".into(), threshold);
    }
    if let Some(at_tokens) = at_tokens {
        body.insert("atTokens".into(), at_tokens);
    }
    if let Some(pins) = pins {
        body.insert("pins".into(), serde_json::Value::from(pins));
    }
    let res = client
        .post(format!("{}/compaction", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to save the compaction settings").await
}

/// Proxy: compact the conversation now (409 while a run is active → Err).
#[tauri::command]
pub(crate) async fn agent_compact_now(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    focus: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let mut body = serde_json::Map::new();
    if let Some(focus) = focus {
        body.insert("focus".into(), serde_json::Value::String(focus));
    }
    let res = client
        .post(format!("{}/compaction/compact", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to compact the conversation").await
}

/// Proxy: put the conversation back as it was before the last compaction
/// (404 when there is none → Err).
#[tauri::command]
pub(crate) async fn agent_undo_compaction(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/compaction/undo", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to undo the compaction").await
}
