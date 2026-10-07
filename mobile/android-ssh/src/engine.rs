use std::collections::HashMap;
use std::net::Shutdown;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::FutureExt;
use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyBase64, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::{Semaphore, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::key_limits::validate_key_cost;
use crate::protocol::{
    AuthMode, BridgeError, ChannelCommand, Command, Credentials, Options, Reply, valid_dimensions,
};

const MAX_CONNECTIONS: usize = 4;
const MAX_COMMAND_BYTES: usize = 512 * 1024;
const MAX_WRITE_BYTES: usize = 48 * 1024;
const MAX_DATA_BYTES: usize = 16 * 1024;
const EVENT_CAPACITY: usize = 32;
const COMMAND_CAPACITY: usize = 32;
const NETWORK_TIMEOUT: Duration = Duration::from_secs(15);
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(10);
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

trait RecoverLock<T> {
    fn recover_lock(&self) -> std::sync::MutexGuard<'_, T>;
}
impl<T> RecoverLock<T> for Mutex<T> {
    fn recover_lock(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

type Pending = (u64, bool, oneshot::Sender<Reply>);
type ClientChannel = Channel<client::Msg>;

struct Shared {
    id: u64,
    generation: u64,
    events: mpsc::Sender<Value>,
    cancel: CancellationToken,
    pending: Mutex<Option<Pending>>,
    next_request: AtomicU64,
    socket: Mutex<Option<std::net::TcpStream>>,
    trusted_key: Mutex<Option<String>>,
    fatal: Mutex<Option<BridgeError>>,
    terminal: Mutex<Option<Value>>,
    finished: AtomicBool,
    ready: AtomicBool,
    exec_count: AtomicUsize,
}

impl Shared {
    fn event(&self, mut event: Value) -> Value {
        event["connectionId"] = self.id.into();
        event["generation"] = self.generation.into();
        event
    }

    async fn emit(&self, event: Value) -> Result<(), BridgeError> {
        let event = self.event(event);
        tokio::select! {
            _ = self.cancel.cancelled() => Err(BridgeError("cancelled")),
            result = self.events.send(event) => result.map_err(|_| BridgeError("event_consumer_closed")),
        }
    }

    async fn data(
        &self,
        data: &[u8],
        extended: bool,
        exec: Option<u64>,
    ) -> Result<(), BridgeError> {
        // Bounded chunks and a bounded event queue propagate backpressure to SSH.
        for bytes in data.chunks(MAX_DATA_BYTES) {
            let mut event = json!({"type": if exec.is_some() { "execData" } else { "data" },
                "data": STANDARD.encode(bytes), "extended": extended});
            if let Some(request_id) = exec {
                event["requestId"] = request_id.into();
            }
            self.emit(event).await?;
        }
        Ok(())
    }

    fn close_transport(&self) {
        if let Some(socket) = self.socket.recover_lock().take() {
            // A duplicate FD shares this TCP socket. Shutdown also interrupts
            // russh's detached connection task, including KEX/auth prompt waits.
            let _ = socket.shutdown(Shutdown::Both);
        }
    }

    fn stop(&self) {
        self.cancel.cancel();
        self.pending.recover_lock().take();
        self.close_transport();
    }

    async fn challenge(&self, mut event: Value, is_host_key: bool) -> Result<Reply, BridgeError> {
        let request_id = self.next_request.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.recover_lock();
            if pending.is_some() {
                return Err(BridgeError("prompt_already_active"));
            }
            *pending = Some((request_id, is_host_key, sender));
        }
        event["requestId"] = request_id.into();
        let result = async {
            self.emit(event).await?;
            bounded(&self.cancel, PROMPT_TIMEOUT, "prompt_timeout", async {
                receiver.await.map_err(|_| BridgeError("cancelled"))
            })
            .await
        }
        .await;
        // Remove only this request, never a newer prompt.
        let mut pending = self.pending.recover_lock();
        if pending.as_ref().is_some_and(|(id, _, _)| *id == request_id) {
            pending.take();
        }
        result
    }

    fn reply(&self, request_id: u64, reply: Reply, host_key: bool) -> Result<(), BridgeError> {
        let mut pending = self.pending.recover_lock();
        match pending.as_ref() {
            Some((id, expected_host_key, _))
                if *id == request_id && *expected_host_key == host_key => {}
            _ => return Err(BridgeError("stale_request")),
        }
        let (_, _, sender) = pending.take().unwrap();
        sender.send(reply).map_err(|_| BridgeError("stale_request"))
    }

    fn finish(&self, result: Result<(), BridgeError>) {
        self.ready.store(false, Ordering::Release);
        let reason = self.fatal.recover_lock().take().or_else(|| result.err());
        let event = match reason {
            Some(BridgeError("cancelled")) => {
                json!({"type":"state","state":"closed","code":"cancelled"})
            }
            Some(error) => json!({"type":"state","state":"error","code":error.0}),
            None => json!({"type":"state","state":"closed","code":"remote_closed"}),
        };
        // Terminal status has a separate slot so it is not lost to a full queue.
        *self.terminal.recover_lock() = Some(self.event(event));
        self.finished.store(true, Ordering::Release);
        self.stop();
    }
}

struct Entry {
    shared: Arc<Shared>,
    commands: mpsc::Sender<ChannelCommand>,
    events: Mutex<mpsc::Receiver<Value>>,
}

struct Engine {
    runtime: tokio::runtime::Runtime,
    entries: Mutex<HashMap<u64, Arc<Entry>>>,
    next_id: AtomicU64,
}

fn engine() -> Result<&'static Engine, BridgeError> {
    crate::panic_guard::install_safe_hook();
    static ENGINE: OnceLock<Result<Engine, BridgeError>> = OnceLock::new();
    ENGINE
        .get_or_init(|| {
            Ok(Engine {
                runtime: tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .map_err(|_| BridgeError("runtime_init_failed"))?,
                entries: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
            })
        })
        .as_ref()
        .map_err(|error| *error)
}

fn entry(id: u64) -> Result<Arc<Entry>, BridgeError> {
    engine()?
        .entries
        .recover_lock()
        .get(&id)
        .cloned()
        .ok_or(BridgeError("unknown_connection"))
}

/// Starts immediately; credentials are requested only after verified host KEX.
pub fn start_json(options_json: &str) -> Result<u64, BridgeError> {
    if options_json.len() > 16 * 1024 {
        return Err(BridgeError("invalid_options"));
    }
    let options: Options =
        serde_json::from_str(options_json).map_err(|_| BridgeError("invalid_options"))?;
    options.validate()?;
    let engine = engine()?;
    let mut entries = engine.entries.recover_lock();
    if entries.len() >= MAX_CONNECTIONS {
        return Err(BridgeError("connection_limit"));
    }
    let id = engine.next_id.fetch_add(1, Ordering::Relaxed);
    let (events_tx, events_rx) = mpsc::channel(EVENT_CAPACITY);
    let (commands_tx, commands_rx) = mpsc::channel(COMMAND_CAPACITY);
    let shared = Arc::new(Shared {
        id,
        generation: options.generation,
        events: events_tx,
        cancel: CancellationToken::new(),
        pending: Mutex::new(None),
        next_request: AtomicU64::new(1),
        socket: Mutex::new(None),
        trusted_key: Mutex::new(options.expected_host_key.clone()),
        fatal: Mutex::new(None),
        terminal: Mutex::new(None),
        finished: AtomicBool::new(false),
        ready: AtomicBool::new(false),
        exec_count: AtomicUsize::new(0),
    });
    entries.insert(
        id,
        Arc::new(Entry {
            shared: shared.clone(),
            commands: commands_tx,
            events: Mutex::new(events_rx),
        }),
    );
    engine.runtime.spawn(async move {
        let result = std::panic::AssertUnwindSafe(run(options, shared.clone(), commands_rx))
            .catch_unwind()
            .await
            .unwrap_or(Err(BridgeError("native_panic")));
        shared.finish(result);
    });
    Ok(id)
}

/// Commands are accepted atomically or rejected: input is never silently dropped.
pub fn command_json(id: u64, command_json: &str) -> Result<(), BridgeError> {
    if command_json.len() > MAX_COMMAND_BYTES {
        return Err(BridgeError("command_too_large"));
    }
    let command: Command =
        serde_json::from_str(command_json).map_err(|_| BridgeError("invalid_command"))?;
    let entry = entry(id)?;
    if command.generation() != entry.shared.generation {
        return Err(BridgeError("stale_generation"));
    }
    if matches!(command, Command::Cancel { .. } | Command::Close { .. }) {
        entry.shared.stop();
        return Ok(());
    }
    if entry.shared.cancel.is_cancelled() {
        return Err(BridgeError("connection_closed"));
    }
    let channel_command = match command {
        Command::HostKeyResponse {
            request_id, accept, ..
        } => return entry.shared.reply(request_id, Reply::HostKey(accept), true),
        Command::AuthResponse {
            request_id,
            password,
            private_key,
            passphrase,
            responses,
            ..
        } => {
            return entry.shared.reply(
                request_id,
                Reply::Auth(Credentials {
                    password,
                    private_key,
                    passphrase,
                    responses,
                }),
                false,
            );
        }
        Command::Write { data, .. } => {
            if data.len() > MAX_WRITE_BYTES * 4 / 3 + 4 {
                return Err(BridgeError("write_too_large"));
            }
            let data = STANDARD
                .decode(data)
                .map_err(|_| BridgeError("invalid_base64"))?;
            if data.len() > MAX_WRITE_BYTES {
                return Err(BridgeError("write_too_large"));
            }
            ChannelCommand::Write(data)
        }
        Command::Resize { cols, rows, .. } => {
            if !valid_dimensions(cols, rows) {
                return Err(BridgeError("invalid_dimensions"));
            }
            ChannelCommand::Resize(cols, rows)
        }
        Command::Exec {
            request_id,
            command,
            ..
        } => {
            if command.len() > 16 * 1024 || command.contains('\0') {
                return Err(BridgeError("invalid_exec"));
            }
            ChannelCommand::Exec(request_id, command)
        }
        Command::Cancel { .. } | Command::Close { .. } => unreachable!(),
    };
    if !entry.shared.ready.load(Ordering::Acquire) {
        return Err(BridgeError("not_ready"));
    }
    entry
        .commands
        .try_send(channel_command)
        .map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => BridgeError("command_queue_full"),
            mpsc::error::TrySendError::Closed(_) => BridgeError("connection_closed"),
        })
}

/// Nonblocking poll; Android forwards batches in one bridge call.
pub fn poll_json(id: u64) -> Result<String, BridgeError> {
    let entry = entry(id)?;
    let mut events = entry.events.recover_lock();
    let mut batch = Vec::with_capacity(EVENT_CAPACITY + 1);
    for _ in 0..EVENT_CAPACITY {
        match events.try_recv() {
            Ok(event) => batch.push(event),
            Err(_) => break,
        }
    }
    if entry.shared.finished.load(Ordering::Acquire) && events.is_empty() {
        if let Some(terminal) = entry.shared.terminal.recover_lock().take() {
            batch.push(terminal);
        }
    }
    serde_json::to_string(&batch).map_err(|_| BridgeError("serialization_failed"))
}

/// Frees the ID and immediately shuts down the socket even while prompting.
pub fn destroy(id: u64) {
    if let Ok(engine) = engine() {
        if let Some(entry) = engine.entries.recover_lock().remove(&id) {
            entry.shared.stop();
        }
    }
}

async fn bounded<T>(
    cancel: &CancellationToken,
    timeout: Duration,
    code: &'static str,
    future: impl std::future::Future<Output = Result<T, BridgeError>>,
) -> Result<T, BridgeError> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(BridgeError("cancelled")),
        result = tokio::time::timeout(timeout, future) => result.map_err(|_| BridgeError(code))?,
    }
}

struct Handler {
    shared: Arc<Shared>,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Prototype has exact host-key pinning, not a certificate authority policy.
        if server_key.certificate().is_some() {
            *self.shared.fatal.recover_lock() = Some(BridgeError("host_certificate_unsupported"));
            return Ok(false);
        }
        let key = server_key.public_key();
        let key_base64 = key.public_key_base64();
        let known = self.shared.trusted_key.recover_lock().clone();
        if let Some(known) = known {
            if known == key_base64 {
                return Ok(self.shared.emit(json!({"type":"hostKey", "status":"known",
                    "algorithm":key.algorithm().to_string(), "fingerprint":key.fingerprint(HashAlg::Sha256).to_string(),
                    "keyBase64":key_base64})).await.is_ok());
            }
            *self.shared.fatal.recover_lock() = Some(BridgeError("host_key_changed"));
            return Ok(false);
        }
        let response = self.shared.challenge(json!({"type":"hostKey", "status":"unknown", "algorithm":key.algorithm().to_string(),
            "fingerprint":key.fingerprint(HashAlg::Sha256).to_string(), "keyBase64":key_base64}), true).await;
        match response {
            Ok(Reply::HostKey(true)) => {
                *self.shared.trusted_key.recover_lock() = Some(key_base64);
                Ok(true)
            }
            Ok(Reply::HostKey(false)) => {
                *self.shared.fatal.recover_lock() = Some(BridgeError("host_key_rejected"));
                Ok(false)
            }
            Err(error) => {
                *self.shared.fatal.recover_lock() = Some(error);
                Ok(false)
            }
            _ => Ok(false),
        }
    }
}

async fn run(
    options: Options,
    shared: Arc<Shared>,
    mut commands: mpsc::Receiver<ChannelCommand>,
) -> Result<(), BridgeError> {
    shared
        .emit(json!({"type":"state","state":"connecting"}))
        .await?;
    let tcp = bounded(&shared.cancel, NETWORK_TIMEOUT, "tcp_timeout", async {
        TcpStream::connect((options.host.as_str(), options.port))
            .await
            .map_err(|_| BridgeError("tcp_failed"))
    })
    .await?;
    tcp.set_nodelay(true)
        .map_err(|_| BridgeError("tcp_failed"))?;
    let socket = tcp.into_std().map_err(|_| BridgeError("tcp_failed"))?;
    {
        let mut retained = shared.socket.recover_lock();
        if shared.cancel.is_cancelled() {
            let _ = socket.shutdown(Shutdown::Both);
            return Err(BridgeError("cancelled"));
        }
        *retained = Some(socket.try_clone().map_err(|_| BridgeError("tcp_failed"))?);
    }
    let tcp = TcpStream::from_std(socket).map_err(|_| BridgeError("tcp_failed"))?;
    let config = Arc::new(client::Config {
        maximum_packet_size: 32768,
        channel_buffer_size: 8,
        window_size: 256 * 1024,
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        ..client::Config::default()
    });
    let mut session = bounded(
        &shared.cancel,
        PROMPT_TIMEOUT + NETWORK_TIMEOUT,
        "handshake_timeout",
        async {
            client::connect_stream(
                config,
                tcp,
                Handler {
                    shared: shared.clone(),
                },
            )
            .await
            .map_err(|_| BridgeError("handshake_failed"))
        },
    )
    .await?;
    authenticate(&options, &shared, &mut session).await?;
    let mut channel = bounded(&shared.cancel, ACQUIRE_TIMEOUT, "channel_timeout", async {
        session
            .channel_open_session()
            .await
            .map_err(|_| BridgeError("channel_failed"))
    })
    .await?;
    bounded(&shared.cancel, ACQUIRE_TIMEOUT, "pty_timeout", async {
        channel
            .request_pty(true, &options.term, options.cols, options.rows, 0, 0, &[])
            .await
            .map_err(|_| BridgeError("pty_failed"))?;
        request_reply(&shared, &mut channel, "pty_rejected", None).await
    })
    .await?;
    bounded(&shared.cancel, ACQUIRE_TIMEOUT, "shell_timeout", async {
        channel
            .request_shell(true)
            .await
            .map_err(|_| BridgeError("shell_failed"))?;
        request_reply(&shared, &mut channel, "shell_rejected", None).await
    })
    .await?;
    shared.ready.store(true, Ordering::Release);
    shared.emit(json!({"type":"state","state":"ready"})).await?;
    let mut saw_exit = false;
    loop {
        tokio::select! {
            biased;
            _ = shared.cancel.cancelled() => return Err(BridgeError("cancelled")),
            command = commands.recv() => match command {
                Some(ChannelCommand::Write(data)) => bounded(&shared.cancel, WRITE_TIMEOUT, "write_timeout", async {
                    channel.data_bytes(data).await.map_err(|_| BridgeError("write_failed"))
                }).await?,
                Some(ChannelCommand::Resize(cols, rows)) => bounded(&shared.cancel, WRITE_TIMEOUT, "resize_timeout", async {
                    channel.window_change(cols, rows, 0, 0).await.map_err(|_| BridgeError("resize_failed"))
                }).await?,
                Some(ChannelCommand::Exec(request_id, command)) => {
                    start_exec(&session, shared.clone(), request_id, command).await?;
                }
                None => return Err(BridgeError("cancelled")),
            },
            message = channel.wait() => match message {
                Some(ChannelMsg::Data { data }) => shared.data(&data, false, None).await?,
                Some(ChannelMsg::ExtendedData { data, .. }) => shared.data(&data, true, None).await?,
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    saw_exit = true;
                    shared.emit(json!({"type":"exit","exitStatus":exit_status})).await?;
                }
                Some(ChannelMsg::Close) | None => return if saw_exit { Ok(()) } else { Err(BridgeError("transport_lost")) },
                _ => {},
            },
        }
    }
}

async fn credentials(shared: &Shared, mode: AuthMode) -> Result<Credentials, BridgeError> {
    match shared
        .challenge(
            json!({"type":"auth","mode":mode.name(),"prompts":[]}),
            false,
        )
        .await?
    {
        Reply::Auth(credentials) => Ok(credentials),
        _ => Err(BridgeError("invalid_auth_response")),
    }
}

async fn authenticate(
    options: &Options,
    shared: &Shared,
    session: &mut client::Handle<Handler>,
) -> Result<(), BridgeError> {
    shared
        .emit(json!({"type":"state","state":"authenticating"}))
        .await?;
    let success = match options.auth_mode {
        AuthMode::Password => {
            let mut credentials = credentials(shared, options.auth_mode).await?;
            let password = credentials
                .password
                .take()
                .ok_or(BridgeError("password_required"))?;
            bounded(&shared.cancel, AUTH_TIMEOUT, "auth_timeout", async {
                session
                    .authenticate_password(&options.username, &password.0)
                    .await
                    .map_err(|_| BridgeError("auth_failed"))
            })
            .await?
            .success()
        }
        AuthMode::PrivateKey => {
            let mut credentials = credentials(shared, options.auth_mode).await?;
            let private_key = credentials
                .private_key
                .take()
                .ok_or(BridgeError("private_key_required"))?;
            let passphrase = credentials.passphrase.take();
            validate_key_cost(&private_key.0)?;
            static DECODERS: OnceLock<Arc<Semaphore>> = OnceLock::new();
            let decoders = DECODERS.get_or_init(|| Arc::new(Semaphore::new(2))).clone();
            let permit = bounded(&shared.cancel, AUTH_TIMEOUT, "key_decode_busy", async {
                decoders
                    .acquire_owned()
                    .await
                    .map_err(|_| BridgeError("key_decode_failed"))
            })
            .await?;
            // Encrypted key decoding (bcrypt) must not block JNI or runtime I/O.
            let decode = tokio::task::spawn_blocking(move || {
                let _permit = permit; // retained until CPU work ends, even after cancel
                russh::keys::decode_secret_key(
                    &private_key.0,
                    passphrase.as_ref().map(|p| p.0.as_str()),
                )
                .map_err(|_| BridgeError("invalid_private_key"))
            });
            let key = bounded(&shared.cancel, AUTH_TIMEOUT, "key_decode_timeout", async {
                decode.await.map_err(|_| BridgeError("key_decode_failed"))?
            })
            .await?;
            if key
                .public_key()
                .key_data()
                .rsa()
                .is_some_and(|rsa| rsa.key_size() > 8192)
            {
                return Err(BridgeError("rsa_key_size_limit"));
            }
            let hash = bounded(&shared.cancel, AUTH_TIMEOUT, "auth_timeout", async {
                session
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|_| BridgeError("auth_failed"))
            })
            .await?
            .flatten();
            // Never fall back to legacy RSA/SHA-1 when the server has no SHA-2.
            if key.algorithm().is_rsa() && hash.is_none() {
                return Err(BridgeError("rsa_sha2_required"));
            }
            bounded(&shared.cancel, AUTH_TIMEOUT, "auth_timeout", async {
                session
                    .authenticate_publickey(
                        &options.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                    .map_err(|_| BridgeError("auth_failed"))
            })
            .await?
            .success()
        }
        AuthMode::KeyboardInteractive => {
            let mut response = bounded(&shared.cancel, AUTH_TIMEOUT, "auth_timeout", async {
                session
                    .authenticate_keyboard_interactive_start(&options.username, None)
                    .await
                    .map_err(|_| BridgeError("auth_failed"))
            })
            .await?;
            let mut rounds = 0;
            loop {
                match response {
                    KeyboardInteractiveAuthResponse::Success => break true,
                    KeyboardInteractiveAuthResponse::Failure { .. } => break false,
                    KeyboardInteractiveAuthResponse::InfoRequest {
                        name,
                        instructions,
                        prompts,
                    } => {
                        rounds += 1;
                        if rounds > 16 || prompts.len() > 32 {
                            return Err(BridgeError("auth_prompt_limit"));
                        }
                        let count = prompts.len();
                        let prompts: Vec<_> = prompts
                            .into_iter()
                            .map(|p| json!({"prompt":p.prompt,"echo":p.echo}))
                            .collect();
                        let credentials = match shared
                            .challenge(
                                json!({"type":"auth", "mode":"keyboardInteractive",
                            "name":name,"instructions":instructions,"prompts":prompts}),
                                false,
                            )
                            .await?
                        {
                            Reply::Auth(credentials) => credentials,
                            _ => return Err(BridgeError("invalid_auth_response")),
                        };
                        let responses = credentials
                            .responses
                            .as_ref()
                            .ok_or(BridgeError("responses_required"))?;
                        if responses.len() != count {
                            return Err(BridgeError("invalid_response_count"));
                        }
                        let responses = responses.iter().map(|secret| secret.0.clone()).collect();
                        response = bounded(&shared.cancel, AUTH_TIMEOUT, "auth_timeout", async {
                            session
                                .authenticate_keyboard_interactive_respond(responses)
                                .await
                                .map_err(|_| BridgeError("auth_failed"))
                        })
                        .await?;
                    }
                }
            }
        }
    };
    if success {
        Ok(())
    } else {
        Err(BridgeError("auth_rejected"))
    }
}

async fn request_reply(
    shared: &Shared,
    channel: &mut ClientChannel,
    rejected: &'static str,
    exec: Option<u64>,
) -> Result<(), BridgeError> {
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Failure) => return Err(BridgeError(rejected)),
            Some(ChannelMsg::Data { data }) => shared.data(&data, false, exec).await?,
            Some(ChannelMsg::ExtendedData { data, .. }) => shared.data(&data, true, exec).await?,
            Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                return Err(BridgeError("channel_closed"));
            }
            _ => {}
        }
    }
}

async fn start_exec(
    session: &client::Handle<Handler>,
    shared: Arc<Shared>,
    request_id: u64,
    command: String,
) -> Result<(), BridgeError> {
    if shared.exec_count.fetch_add(1, Ordering::AcqRel) >= 2 {
        shared.exec_count.fetch_sub(1, Ordering::AcqRel);
        shared
            .emit(json!({"type":"execError","requestId":request_id,"code":"exec_limit"}))
            .await?;
        return Ok(());
    }
    let mut channel = match bounded(&shared.cancel, ACQUIRE_TIMEOUT, "exec_timeout", async {
        session
            .channel_open_session()
            .await
            .map_err(|_| BridgeError("exec_channel_failed"))
    })
    .await
    {
        Ok(channel) => channel,
        Err(error) => {
            shared.exec_count.fetch_sub(1, Ordering::AcqRel);
            shared
                .emit(json!({"type":"execError","requestId":request_id,"code":error.0}))
                .await?;
            // A timed-out acquisition may open late; closing this single-purpose
            // transport is the prototype's guarantee against orphan channels.
            if error.0 == "exec_timeout" {
                return Err(error);
            }
            return Ok(());
        }
    };
    let acquisition = bounded(&shared.cancel, ACQUIRE_TIMEOUT, "exec_timeout", async {
        channel
            .exec(true, command)
            .await
            .map_err(|_| BridgeError("exec_failed"))?;
        request_reply(&shared, &mut channel, "exec_rejected", Some(request_id)).await
    })
    .await;
    if let Err(error) = acquisition {
        let _ = tokio::time::timeout(Duration::from_secs(1), channel.close()).await;
        shared.exec_count.fetch_sub(1, Ordering::AcqRel);
        shared
            .emit(json!({"type":"execError","requestId":request_id,"code":error.0}))
            .await?;
        if error.0 == "exec_timeout" {
            return Err(error);
        }
        return Ok(());
    }
    tokio::spawn(async move {
        let result = std::panic::AssertUnwindSafe(bounded(&shared.cancel, Duration::from_secs(30), "exec_timeout", async {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Data { data }) => shared.data(&data, false, Some(request_id)).await?,
                    Some(ChannelMsg::ExtendedData { data, .. }) => shared.data(&data, true, Some(request_id)).await?,
                    Some(ChannelMsg::ExitStatus { exit_status }) => shared.emit(json!({"type":"execExit","requestId":request_id,"exitStatus":exit_status})).await?,
                    Some(ChannelMsg::Close) | None => break Ok(()),
                    _ => {},
                }
            }
        })).catch_unwind().await.unwrap_or(Err(BridgeError("native_panic")));
        let _ = tokio::time::timeout(Duration::from_secs(1), channel.close()).await;
        if let Err(error) = result {
            let _ = shared
                .emit(json!({"type":"execError","requestId":request_id,"code":error.0}))
                .await;
        }
        shared.exec_count.fetch_sub(1, Ordering::AcqRel);
    });
    Ok(())
}
