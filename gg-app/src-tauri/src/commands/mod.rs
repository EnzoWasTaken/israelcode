//! Tauri commands proxied to the sidecar or handled natively.

pub(crate) mod agent;
pub(crate) mod agent_admin;
pub(crate) mod background;
pub(crate) mod budget;
pub(crate) mod compaction;
pub(crate) mod files;
pub(crate) mod hooks;
pub(crate) mod mcp_market;
pub(crate) mod orchestration;
pub(crate) mod skills;
pub(crate) mod verify;
pub(crate) mod worktree_workers;
pub(crate) mod world;
