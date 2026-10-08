use serde::Deserialize;
use zeroize::Zeroize;

/// Only stable codes cross JNI; upstream errors can contain server messages.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BridgeError(pub &'static str);

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for BridgeError {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Options {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    pub generation: u64,
    pub auth_mode: AuthMode,
    #[serde(default = "default_cols")]
    pub cols: u32,
    #[serde(default = "default_rows")]
    pub rows: u32,
    #[serde(default = "default_term")]
    pub term: String,
    pub expected_host_key: Option<String>,
    #[serde(default)]
    pub defer_terminal: bool,
}

fn default_port() -> u16 {
    22
}
fn default_cols() -> u32 {
    80
}
fn default_rows() -> u32 {
    24
}
fn default_term() -> String {
    "xterm-256color".into()
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AuthMode {
    Password,
    PrivateKey,
    KeyboardInteractive,
}

impl AuthMode {
    pub fn name(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::PrivateKey => "privateKey",
            Self::KeyboardInteractive => "keyboardInteractive",
        }
    }
}

impl Options {
    pub fn validate(&self) -> Result<(), BridgeError> {
        if self.generation > 9_007_199_254_740_991
            || self.host.is_empty()
            || self.host.len() > 255
            || self.host.chars().any(char::is_control)
            || self.username.is_empty()
            || self.username.len() > 255
            || self.username.chars().any(char::is_control)
            || self.port == 0
            || self.term.is_empty()
            || self.term.len() > 64
            || !self
                .term
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            || !valid_dimensions(self.cols, self.rows)
            || self
                .expected_host_key
                .as_ref()
                .is_some_and(|k| k.is_empty() || k.len() > 16384)
        {
            return Err(BridgeError("invalid_options"));
        }
        Ok(())
    }
}

pub(crate) fn valid_dimensions(cols: u32, rows: u32) -> bool {
    (1..=1000).contains(&cols) && (1..=1000).contains(&rows)
}

/// Secrets are transient, never Debug/Serialize, and erased on best-effort drop.
/// russh/JVM may create their own temporary copies; this is not an mlock promise.
#[derive(Deserialize)]
pub(crate) struct Secret(pub String);

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Credentials {
    pub password: Option<Secret>,
    pub private_key: Option<Secret>,
    pub passphrase: Option<Secret>,
    pub responses: Option<Vec<Secret>>,
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub(crate) enum Command {
    #[serde(rename = "hostKeyResponse", rename_all = "camelCase")]
    HostKeyResponse {
        generation: u64,
        request_id: u64,
        accept: bool,
    },
    #[serde(rename = "authResponse", rename_all = "camelCase")]
    AuthResponse {
        generation: u64,
        request_id: u64,
        password: Option<Secret>,
        private_key: Option<Secret>,
        passphrase: Option<Secret>,
        responses: Option<Vec<Secret>>,
    },
    #[serde(rename = "write")]
    Write { generation: u64, data: String },
    #[serde(rename = "resize")]
    Resize {
        generation: u64,
        cols: u32,
        rows: u32,
    },
    #[serde(rename = "exec", rename_all = "camelCase")]
    Exec {
        generation: u64,
        request_id: u64,
        command: String,
    },
    #[serde(rename = "execCancel", rename_all = "camelCase")]
    ExecCancel { generation: u64, request_id: u64 },
    #[serde(rename = "openTerminal", rename_all = "camelCase")]
    OpenTerminal {
        generation: u64,
        request_id: u64,
        kind: TerminalKind,
        command: Option<String>,
        cols: Option<u32>,
        rows: Option<u32>,
    },
    #[serde(rename = "cancel")]
    Cancel { generation: u64 },
    #[serde(rename = "close")]
    Close { generation: u64 },
}

impl Command {
    pub fn generation(&self) -> u64 {
        match self {
            Self::HostKeyResponse { generation, .. }
            | Self::AuthResponse { generation, .. }
            | Self::Write { generation, .. }
            | Self::Resize { generation, .. }
            | Self::Exec { generation, .. }
            | Self::ExecCancel { generation, .. }
            | Self::OpenTerminal { generation, .. }
            | Self::Cancel { generation }
            | Self::Close { generation } => *generation,
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalKind {
    Shell,
    Exec,
}

impl TerminalKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Shell => "shell",
            Self::Exec => "exec",
        }
    }
}

pub(crate) struct TerminalRequest {
    pub request_id: u64,
    pub kind: TerminalKind,
    pub command: Option<String>,
    pub cols: Option<u32>,
    pub rows: Option<u32>,
}

pub(crate) enum Reply {
    HostKey(bool),
    Auth(Credentials),
}

pub(crate) enum ChannelCommand {
    Write(Vec<u8>),
    Resize(u32, u32),
    Exec(u64, String),
    OpenTerminal(TerminalRequest),
}
