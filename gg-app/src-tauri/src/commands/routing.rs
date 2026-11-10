//! Auto routing proxies. Config, credentials, test and diagnostics are
//! daemon-level (Settings can be open with no window session); the per-window
//! on/off + pins attach the window's session header. Request bodies can carry
//! API keys, so they are never logged here.

use super::agent_admin::json_or_error;
use crate::*;

fn daemon_port(webview: &WebviewWindow) -> Result<u16, String> {
    port_for(webview).ok_or_else(|| "daemon not ready".to_string())
}

/// Proxy: the Auto routing config, problems, masked credentials and decider options.
#[tauri::command]
pub(crate) async fn routing_config_get(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = daemon_port(&webview)?;
    let res = client
        .get(format!("{}/routing/config", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    json_or_error(res, "failed to read Auto routing settings").await
}

/// Proxy: validate and save the Auto routing config (the sidecar answers 400 with problems).
#[tauri::command]
pub(crate) async fn routing_config_set(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    config: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let port = daemon_port(&webview)?;
    let res = client
        .post(format!("{}/routing/config", sidecar_base(port)))
        .json(&serde_json::json!({ "config": config }))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    json_or_error(res, "failed to save Auto routing settings").await
}

/// Proxy: store a decision-service API key (the sidecar answers with a masked value only).
#[tauri::command]
pub(crate) async fn routing_credential_set(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    service: String,
    api_key: String,
    replace: Option<bool>,
) -> Result<serde_json::Value, String> {
    let port = daemon_port(&webview)?;
    let res = client
        .post(format!("{}/routing/credential", sidecar_base(port)))
        .json(&serde_json::json!({
            "service": service,
            "apiKey": api_key,
            "replace": replace.unwrap_or(false),
        }))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    json_or_error(res, "failed to save the API key").await
}

/// Proxy: remove the TypeSafe decision key.
#[tauri::command]
pub(crate) async fn routing_credential_clear(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    service: String,
) -> Result<serde_json::Value, String> {
    let port = daemon_port(&webview)?;
    // Only the decision-only credential is removable here; OpenRouter is a normal provider login.
    if service != "typesafe" {
        return Err("only the TypeSafe key can be removed here".to_string());
    }
    let res = client
        .delete(format!(
            "{}/routing/credential/typesafe",
            sidecar_base(port)
        ))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    json_or_error(res, "failed to remove the API key").await
}

/// Proxy: run one routing decision on a canned task. `decider` is the picker's
/// (possibly unsaved) choice; without it the saved decider is tested.
#[tauri::command]
pub(crate) async fn routing_test(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    decider: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let port = daemon_port(&webview)?;
    let body = match decider {
        Some(d) => serde_json::json!({ "decider": d }),
        None => serde_json::json!({}),
    };
    let res = client
        .post(format!("{}/routing/test", sidecar_base(port)))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    json_or_error(res, "routing test failed").await
}

/// Proxy: the last routing diagnostics (content-free).
#[tauri::command]
pub(crate) async fn routing_diagnostics(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = daemon_port(&webview)?;
    let res = client
        .get(format!("{}/routing/diagnostics", sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    json_or_error(res, "failed to read routing diagnostics").await
}

/// Proxy: switch Auto on/off for THIS window and/or set its pins (`null` clears them).
#[tauri::command]
pub(crate) async fn agent_routing_session(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    enabled: Option<bool>,
    pins: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let port = daemon_port(&webview)?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let mut body = serde_json::Map::new();
    if let Some(e) = enabled {
        body.insert("enabled".into(), serde_json::Value::Bool(e));
    }
    if let Some(p) = pins {
        body.insert("pins".into(), p);
    }
    let res = client
        .post(format!("{}/routing/session", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    json_or_error(res, "failed to change Auto routing").await
}
