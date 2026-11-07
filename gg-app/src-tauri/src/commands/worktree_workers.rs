//! Worktree-worker proxies: the per-project policy, and the merge review of a
//! worker's own worktree (diff, conflict preview, checks, merge, discard).

use super::agent_admin::{json_or_error, urlencoding};
use crate::*;

/// Like `json_or_error`, but a refusal that names files (a merge that would
/// clobber uncommitted work, or conflicts) lists them after the message.
async fn json_or_error_with_files(
    res: reqwest::Response,
    fallback: &str,
) -> Result<serde_json::Value, String> {
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if status.is_success() {
        return Ok(body);
    }
    let msg = body
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or(fallback)
        .to_string();
    let files: Vec<&str> = body
        .get("files")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|f| f.as_str()).collect())
        .unwrap_or_default();
    if files.is_empty() {
        Err(msg)
    } else {
        Err(format!("{msg} ({})", files.join(", ")))
    }
}

async fn get_path(
    webview: &WebviewWindow,
    client: &reqwest::Client,
    path: String,
    fallback: &str,
) -> Result<serde_json::Value, String> {
    let port = port_for(webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}{}", sidecar_base(port), path))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error_with_files(res, fallback).await
}

async fn post_path(
    webview: &WebviewWindow,
    client: &reqwest::Client,
    path: &str,
    body: serde_json::Value,
    fallback: &str,
) -> Result<serde_json::Value, String> {
    let port = port_for(webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}{}", sidecar_base(port), path))
        .header("x-gg-session", &gg_sid)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error_with_files(res, fallback).await
}

/// Proxy: the policy and this window's worker worktrees with their status.
#[tauri::command]
pub(crate) async fn agent_get_worktree_workers(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/worktree-workers", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to read the worktree workers").await
}

/// Proxy: switch worktree isolation and/or auto-merge (saved per project).
#[tauri::command]
pub(crate) async fn agent_set_worktree_workers(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    enabled: Option<bool>,
    auto_merge: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut body = serde_json::Map::new();
    if let Some(enabled) = enabled {
        body.insert("enabled".into(), serde_json::Value::Bool(enabled));
    }
    if let Some(auto_merge) = auto_merge {
        body.insert("autoMerge".into(), serde_json::Value::String(auto_merge));
    }
    post_path(
        &webview,
        &client,
        "/worktree-workers",
        serde_json::Value::Object(body),
        "failed to save the worktree workers settings",
    )
    .await
}

/// Proxy: the worker's diff against its base branch.
#[tauri::command]
pub(crate) async fn agent_worktree_diff(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    branch: String,
) -> Result<serde_json::Value, String> {
    let path = format!("/worktree-workers/diff?branch={}", urlencoding(&branch));
    get_path(&webview, &client, path, "failed to read the worker's diff").await
}

/// Proxy: the files a merge of the worker's branch would conflict on.
#[tauri::command]
pub(crate) async fn agent_worktree_preview(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    branch: String,
) -> Result<serde_json::Value, String> {
    let path = format!("/worktree-workers/preview?branch={}", urlencoding(&branch));
    get_path(&webview, &client, path, "failed to preview the merge").await
}

/// Proxy: run the project's checks inside the worker's worktree.
#[tauri::command]
pub(crate) async fn agent_worktree_verify(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    branch: String,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "branch": branch });
    post_path(
        &webview,
        &client,
        "/worktree-workers/verify",
        body,
        "failed to run the checks",
    )
    .await
}

/// Proxy: merge the worker's branch (squash by default). A refusal (409)
/// becomes an Err carrying the sidecar's message and the files involved.
#[tauri::command]
pub(crate) async fn agent_worktree_merge(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    branch: String,
    mode: Option<String>,
) -> Result<serde_json::Value, String> {
    let body =
        serde_json::json!({ "branch": branch, "mode": mode.unwrap_or_else(|| "squash".into()) });
    post_path(
        &webview,
        &client,
        "/worktree-workers/merge",
        body,
        "failed to merge the worker",
    )
    .await
}

/// Proxy: remove the worker's worktree and branch.
#[tauri::command]
pub(crate) async fn agent_worktree_discard(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    branch: String,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "branch": branch });
    post_path(
        &webview,
        &client,
        "/worktree-workers/discard",
        body,
        "failed to discard the worker",
    )
    .await
}
