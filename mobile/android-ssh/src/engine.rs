use std::collections::HashMap;
use std::io;
use std::net::Shutdown;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::FutureExt;
use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyBase64, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::{Notify, Semaphore, mpsc, oneshot};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::key_limits::validate_key_cost;
use crate::protocol::{
    AuthMode, BridgeError, ChannelCommand, Command, Credentials, Options, Reply, TerminalKind,
    TerminalRequest, valid_dimensions,
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
const EXEC_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_EXEC_BYTES: usize = 1024 * 1024;
const MAX_REQUEST_ID: u64 = 9_007_199_254_740_991;

struct ExecRequest {
    id: u64,
    cancel: CancellationToken,
    queued: AtomicUsize,
    completion: Mutex<Option<Value>>,
    delivered: AtomicBool,
    cleaned: AtomicBool,
    started: AtomicBool,
    explicitly_cancelled: AtomicBool,
    deadline: Instant,
}

struct QueuedEvent<'a> {
    request: &'a ExecRequest,
    sent: bool,
}
impl Drop for QueuedEvent<'_> {
    fn drop(&mut self) {
        if !self.sent {
            self.request.queued.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

#[derive(Default)]
struct Operations {
    last_request: u64,
    execs: HashMap<u64, Arc<ExecRequest>>,
    opening: bool,
    terminal_completion: Option<Value>,
}

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
    ending: Mutex<Option<BridgeError>>,
    terminal: Mutex<Option<Value>>,
    finished: AtomicBool,
    ready: AtomicBool,
    authenticated: AtomicBool,
    deferred: bool,
    operations: Mutex<Operations>,
    transport_reason: Mutex<Option<BridgeError>>,
    transport_changed: Notify,
    network_lost: AtomicBool,
}

// Channel EOF is not TCP EOF. Retain direct IO evidence because russh closes
// its Handle sender before awaiting socket shutdown and invoking disconnected.
struct ObservedStream {
    tcp: TcpStream,
    shared: Arc<Shared>,
}
impl ObservedStream {
    fn lost(&self) {
        if !self.shared.cancel.is_cancelled() {
            self.shared.network_lost.store(true, Ordering::Release);
        }
    }
}
impl AsyncRead for ObservedStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buffer.filled().len();
        let capacity = buffer.remaining();
        let result = Pin::new(&mut self.tcp).poll_read(cx, buffer);
        if matches!(&result, Poll::Ready(Err(_)))
            || (matches!(&result, Poll::Ready(Ok(())))
                && capacity > 0
                && buffer.filled().len() == before)
        {
            self.lost();
        }
        result
    }
}
impl AsyncWrite for ObservedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.tcp).poll_write(cx, bytes);
        if matches!(&result, Poll::Ready(Err(_))) {
            self.lost();
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let result = Pin::new(&mut self.tcp).poll_flush(cx);
        if matches!(&result, Poll::Ready(Err(_))) {
            self.lost();
        }
        result
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        // Shutdown can follow an orderly SSH disconnect or protocol failure.
        // Its own errors cannot establish an unexpected network failure.
        Pin::new(&mut self.tcp).poll_shutdown(cx)
    }
}

impl Shared {
    fn transport_error(&self) -> Option<BridgeError> {
        *self.transport_reason.recover_lock()
    }

    fn fail(&self, error: BridgeError) {
        *self.fatal.recover_lock() = Some(error);
        *self.ending.recover_lock() = Some(error);
        self.stop();
    }

    fn interrupted(&self) -> BridgeError {
        let ending = *self.ending.recover_lock();
        ending
            .or_else(|| *self.fatal.recover_lock())
            .or_else(|| self.transport_error())
            .unwrap_or(BridgeError("cancelled"))
    }

    fn exec_done(&self, request: &ExecRequest, result: Result<u32, BridgeError>) {
        let event = match result {
            Ok(status) => {
                json!({"type":"execExit","requestId":request.id,"exitStatus":status,"complete":true})
            }
            Err(error) => json!({"type":"execError","requestId":request.id,"code":error.0,
                "complete":false,"truncated":!matches!(error.0, "exec_cancelled" | "exec_rejected" | "exec_channel_failed")}),
        };
        let mut completion = request.completion.recover_lock();
        if completion.is_none() && !request.delivered.load(Ordering::Acquire) {
            *completion = Some(self.event(event));
        }
    }

    async fn exec_data(
        &self,
        request: &ExecRequest,
        bytes: &[u8],
        extended: bool,
    ) -> Result<(), BridgeError> {
        for chunk in bytes.chunks(MAX_DATA_BYTES) {
            self.exec_event(
                request,
                json!({"type":"execData","requestId":request.id,
                "data":STANDARD.encode(chunk),"extended":extended}),
            )
            .await?;
        }
        Ok(())
    }

    async fn exec_event(&self, request: &ExecRequest, event: Value) -> Result<(), BridgeError> {
        request.queued.fetch_add(1, Ordering::AcqRel);
        let mut reservation = QueuedEvent {
            request,
            sent: false,
        };
        let event = self.event(event);
        let result = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(BridgeError("cancelled")),
            _ = request.cancel.cancelled() => Err(BridgeError("exec_cancelled")),
            result = self.events.send(event) => result.map_err(|_| BridgeError("event_consumer_closed")),
        };
        reservation.sent = result.is_ok();
        result
    }
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
        self.authenticated.store(false, Ordering::Release);
        let reason = self.fatal.recover_lock().take().or_else(|| result.err());
        *self.ending.recover_lock() = Some(reason.unwrap_or(BridgeError("connection_closed")));
        let transport_lost =
            reason.is_some_and(|error| matches!(error.0, "transport_lost" | "remote_disconnect"));
        let event = match reason {
            Some(BridgeError("cancelled")) => {
                json!({"type":"state","state":"closed","code":"cancelled"})
            }
            Some(error) => json!({"type":"state","state":"error","code":error.0}),
            None => json!({"type":"state","state":"closed","code":"remote_closed"}),
        };
        let mut event = event;
        event["transportLost"] = transport_lost.into();
        self.stop();
        for request in self.operations.recover_lock().execs.values() {
            if !request.started.load(Ordering::Acquire) {
                request.cleaned.store(true, Ordering::Release);
                self.exec_done(
                    request,
                    Err(if request.explicitly_cancelled.load(Ordering::Acquire) {
                        BridgeError("exec_cancelled")
                    } else {
                        reason.unwrap_or(BridgeError("connection_closed"))
                    }),
                );
            }
        }
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
        ending: Mutex::new(None),
        terminal: Mutex::new(None),
        finished: AtomicBool::new(false),
        ready: AtomicBool::new(false),
        authenticated: AtomicBool::new(false),
        deferred: options.defer_terminal,
        operations: Mutex::new(Operations::default()),
        transport_reason: Mutex::new(None),
        transport_changed: Notify::new(),
        network_lost: AtomicBool::new(false),
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
            if command.is_empty() || command.len() > 16 * 1024 || command.contains('\0') {
                return Err(BridgeError("invalid_exec"));
            }
            if !entry.shared.authenticated.load(Ordering::Acquire) {
                return Err(BridgeError("not_authenticated"));
            }
            let mut operations = entry.shared.operations.recover_lock();
            validate_request(&operations, request_id)?;
            if operations.opening {
                return Err(BridgeError("terminal_opening"));
            }
            if operations.execs.len() >= 2 {
                return Err(BridgeError("exec_limit"));
            }
            operations.execs.insert(
                request_id,
                Arc::new(ExecRequest {
                    id: request_id,
                    cancel: entry.shared.cancel.child_token(),
                    queued: AtomicUsize::new(0),
                    completion: Mutex::new(None),
                    delivered: AtomicBool::new(false),
                    cleaned: AtomicBool::new(false),
                    started: AtomicBool::new(false),
                    explicitly_cancelled: AtomicBool::new(false),
                    deadline: Instant::now() + EXEC_TIMEOUT,
                }),
            );
            if let Err(error) =
                send_command(&entry.commands, ChannelCommand::Exec(request_id, command))
            {
                operations.execs.remove(&request_id);
                return Err(error);
            }
            operations.last_request = request_id;
            return Ok(());
        }
        Command::ExecCancel { request_id, .. } => {
            if request_id == 0 || request_id > MAX_REQUEST_ID {
                return Err(BridgeError("invalid_request_id"));
            }
            let operations = entry.shared.operations.recover_lock();
            if let Some(request) = operations.execs.get(&request_id) {
                request.explicitly_cancelled.store(true, Ordering::Release);
                request.cancel.cancel();
                return Ok(());
            }
            return if request_id > 0 && request_id <= operations.last_request {
                Ok(())
            } else {
                Err(BridgeError("stale_request"))
            };
        }
        Command::OpenTerminal {
            request_id,
            kind,
            command,
            cols,
            rows,
            ..
        } => {
            if !entry.shared.authenticated.load(Ordering::Acquire) {
                return Err(BridgeError("not_authenticated"));
            }
            if !entry.shared.deferred {
                return Err(BridgeError("terminal_exists"));
            }
            if !valid_dimensions(cols.unwrap_or(80), rows.unwrap_or(24)) {
                return Err(BridgeError("invalid_dimensions"));
            }
            match kind {
                TerminalKind::Shell if command.is_some() => {
                    return Err(BridgeError("invalid_terminal"));
                }
                TerminalKind::Exec
                    if command.as_ref().is_none_or(|s| {
                        s.is_empty() || s.len() > 16 * 1024 || s.contains('\0')
                    }) =>
                {
                    return Err(BridgeError("invalid_terminal"));
                }
                _ => {}
            }
            let mut operations = entry.shared.operations.recover_lock();
            validate_request(&operations, request_id)?;
            if entry.shared.ready.load(Ordering::Acquire) {
                return Err(BridgeError("terminal_exists"));
            }
            if operations.opening || operations.terminal_completion.is_some() {
                return Err(BridgeError("terminal_opening"));
            }
            if !operations.execs.is_empty() {
                return Err(BridgeError("exec_in_progress"));
            }
            operations.opening = true;
            if let Err(error) = send_command(
                &entry.commands,
                ChannelCommand::OpenTerminal(TerminalRequest {
                    request_id,
                    kind,
                    command,
                    cols,
                    rows,
                }),
            ) {
                operations.opening = false;
                return Err(error);
            }
            operations.last_request = request_id;
            return Ok(());
        }
        Command::Cancel { .. } | Command::Close { .. } => unreachable!(),
    };
    if !entry.shared.ready.load(Ordering::Acquire) {
        return Err(BridgeError("not_ready"));
    }
    send_command(&entry.commands, channel_command)
}

fn validate_request(operations: &Operations, id: u64) -> Result<(), BridgeError> {
    if id == 0 || id > MAX_REQUEST_ID {
        return Err(BridgeError("invalid_request_id"));
    }
    if id <= operations.last_request {
        return Err(BridgeError("stale_request"));
    }
    Ok(())
}

fn send_command(
    sender: &mpsc::Sender<ChannelCommand>,
    command: ChannelCommand,
) -> Result<(), BridgeError> {
    sender.try_send(command).map_err(|error| match error {
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
            Ok(event) => {
                if event["type"] == "execData" || event["type"] == "execStarted" {
                    if let Some(request) = entry
                        .shared
                        .operations
                        .recover_lock()
                        .execs
                        .get(&event["requestId"].as_u64().unwrap_or_default())
                    {
                        request.queued.fetch_sub(1, Ordering::AcqRel);
                    }
                }
                batch.push(event)
            }
            Err(_) => break,
        }
    }
    {
        let mut operations = entry.shared.operations.recover_lock();
        for request in operations.execs.values() {
            if request.cleaned.load(Ordering::Acquire)
                && request.queued.load(Ordering::Acquire) == 0
            {
                if let Some(completion) = request.completion.recover_lock().take() {
                    request.delivered.store(true, Ordering::Release);
                    batch.push(completion);
                }
            }
        }
        operations.execs.retain(|_, request| {
            !(request.cleaned.load(Ordering::Acquire) && request.delivered.load(Ordering::Acquire))
        });
        if events.is_empty() {
            if let Some(completion) = operations.terminal_completion.take() {
                batch.push(completion);
            }
        }
    }
    if entry.shared.finished.load(Ordering::Acquire)
        && events.is_empty()
        && entry.shared.operations.recover_lock().execs.is_empty()
    {
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

async fn transport_end(shared: &Shared) -> BridgeError {
    let reason = async {
        loop {
            if let Some(reason) = shared.transport_error() {
                return reason;
            }
            shared.transport_changed.notified().await;
        }
    };
    tokio::select! {
        biased;
        _=shared.cancel.cancelled()=>BridgeError("cancelled"),
        reason=tokio::time::timeout(Duration::from_millis(100),reason)=>reason.unwrap_or_else(|_| {
            shared.transport_error().unwrap_or(BridgeError(if shared.network_lost.load(Ordering::Acquire) {"transport_lost"} else {"transport_closed"}))
        }),
    }
}

struct Handler {
    shared: Arc<Shared>,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        if !self.shared.cancel.is_cancelled() {
            let code = match reason {
                client::DisconnectReason::ReceivedDisconnect(_) => "remote_disconnect",
                client::DisconnectReason::Error(
                    russh::Error::IO(_)
                    | russh::Error::HUP
                    | russh::Error::Disconnect
                    | russh::Error::KeepaliveTimeout
                    | russh::Error::ConnectionTimeout,
                ) => "transport_lost",
                client::DisconnectReason::Error(_) => "transport_failed",
            };
            *self.shared.transport_reason.recover_lock() = Some(BridgeError(code));
            self.shared.transport_changed.notify_one();
        }
        Ok(())
    }

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
                *self.shared.trusted_key.recover_lock() = Some(key_base64.clone());
                if self.shared.deferred {
                    if let Err(error) = self.shared.emit(json!({"type":"hostKey","status":"known",
                        "algorithm":key.algorithm().to_string(),"fingerprint":key.fingerprint(HashAlg::Sha256).to_string(),"keyBase64":key_base64})).await {
                        *self.shared.fatal.recover_lock() = Some(error);
                        return Ok(false);
                    }
                }
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
                ObservedStream {
                    tcp,
                    shared: shared.clone(),
                },
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
    shared.authenticated.store(true, Ordering::Release);
    let session = Arc::new(session);
    let mut channel = if options.defer_terminal {
        shared
            .emit(json!({"type":"state","state":"authenticated","deferredTerminal":true}))
            .await?;
        None
    } else {
        let channel = open_terminal(&session, &shared, &options, None).await?;
        shared.ready.store(true, Ordering::Release);
        shared.emit(json!({"type":"state","state":"ready"})).await?;
        Some(channel)
    };
    let mut monitor = tokio::time::interval(Duration::from_millis(20));
    let mut active_terminal: Option<(u64, TerminalKind)> = None;
    loop {
        tokio::select! {
            biased;
            _ = shared.cancel.cancelled() => return Err(BridgeError("cancelled")),
            _ = shared.transport_changed.notified() => {
                if let Some(error) = shared.transport_error() { return Err(error); }
            },
            _ = monitor.tick() => {
                if session.is_closed() { return Err(transport_end(&shared).await); }
            },
            command = commands.recv() => match command {
                Some(ChannelCommand::Write(data)) => {
                    let terminal = channel.as_mut().ok_or(BridgeError("not_ready"))?;
                    bounded(&shared.cancel, WRITE_TIMEOUT, "write_timeout", async {
                        terminal.data_bytes(data).await.map_err(|_| BridgeError("write_failed"))
                    }).await?;
                },
                Some(ChannelCommand::Resize(cols, rows)) => {
                    let terminal = channel.as_mut().ok_or(BridgeError("not_ready"))?;
                    bounded(&shared.cancel, WRITE_TIMEOUT, "resize_timeout", async {
                        terminal.window_change(cols, rows, 0, 0).await.map_err(|_| BridgeError("resize_failed"))
                    }).await?;
                },
                Some(ChannelCommand::Exec(request_id, command)) => {
                    let request = shared.operations.recover_lock().execs.get(&request_id).cloned().ok_or(BridgeError("stale_request"))?;
                    request.started.store(true, Ordering::Release);
                    let task_shared = shared.clone();
                    let task_session = session.clone();
                    tokio::spawn(async move {
                        let result = std::panic::AssertUnwindSafe(run_exec(task_session, task_shared.clone(), request.clone(), command))
                            .catch_unwind().await.unwrap_or(Err(BridgeError("native_panic")));
                        if result == Err(BridgeError("native_panic")) {
                            task_shared.fail(BridgeError("native_panic"));
                        }
                        let result = if request.explicitly_cancelled.load(Ordering::Acquire) { Err(BridgeError("exec_cancelled")) }
                            else if result == Err(BridgeError("cancelled")) || (result == Err(BridgeError("exec_cancelled")) && task_shared.cancel.is_cancelled()) { Err(task_shared.interrupted()) }
                            else { result };
                        task_shared.exec_done(&request, result);
                        request.cleaned.store(true, Ordering::Release);
                    });
                },
                Some(ChannelCommand::OpenTerminal(request)) => {
                    match open_terminal(&session, &shared, &options, Some(&request)).await {
                        Ok(terminal) => {
                            shared.operations.recover_lock().opening = false;
                            channel = Some(terminal);
                            active_terminal = Some((request.request_id, request.kind));
                            shared.ready.store(true, Ordering::Release);
                            shared.emit(json!({"type":"state","state":"ready","requestId":request.request_id,"terminalKind":request.kind.name()})).await?;
                        },
                        Err(error) => {
                            // Acquisition can observe a closed channel before
                            // russh publishes its final transport callback.
                            // Resolve that reason before exposing a completion
                            // that the controller might act on independently.
                            let error = if shared.cancel.is_cancelled() {
                                shared.interrupted()
                            } else if session.is_closed() || shared.transport_error().is_some() || shared.network_lost.load(Ordering::Acquire) {
                                transport_end(&shared).await
                            } else { error };
                            {
                            let mut operations = shared.operations.recover_lock();
                            operations.opening = false;
                            operations.terminal_completion = Some(shared.event(json!({"type":"terminalError","requestId":request.request_id,"code":error.0})));
                            }
                            if matches!(error.0,"cancelled"|"channel_timeout"|"pty_timeout"|"shell_timeout"|"terminal_exec_timeout"|"transport_lost"|"remote_disconnect"|"transport_failed"|"transport_closed"|"channel_cleanup_timeout") { return Err(error); }
                            if session.is_closed() { return Err(transport_end(&shared).await); }
                        },
                    }
                },
                None => return Err(BridgeError("cancelled")),
            },
            message = async {
                match channel.as_mut() {
                    Some(terminal) => terminal.wait().await,
                    None => std::future::pending().await,
                }
            } => match message {
                Some(ChannelMsg::Data { data }) => shared.data(&data, false, None).await?,
                Some(ChannelMsg::ExtendedData { data, .. }) => shared.data(&data, true, None).await?,
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    let mut event = json!({"type":"exit","exitStatus":exit_status});
                    if let Some((id,kind)) = active_terminal { event["requestId"] = id.into(); event["terminalKind"] = kind.name().into(); }
                    shared.emit(event).await?;
                },
                Some(ChannelMsg::Close) | None => {
                    // A terminal channel can close while the SSH transport lives.
                    // Never turn detach/takeover into an automatic reconnect war.
                    if session.is_closed() { return Err(transport_end(&shared).await); }
                    return Ok(());
                },
                _ => {},
            },
        }
    }
}

async fn open_terminal(
    session: &client::Handle<Handler>,
    shared: &Shared,
    options: &Options,
    request: Option<&TerminalRequest>,
) -> Result<ClientChannel, BridgeError> {
    let mut channel = bounded(&shared.cancel, ACQUIRE_TIMEOUT, "channel_timeout", async {
        session
            .channel_open_session()
            .await
            .map_err(|_| BridgeError("channel_failed"))
    })
    .await?;
    let pty_result = bounded(&shared.cancel, ACQUIRE_TIMEOUT, "pty_timeout", async {
        channel
            .request_pty(
                true,
                &options.term,
                request.and_then(|r| r.cols).unwrap_or(options.cols),
                request.and_then(|r| r.rows).unwrap_or(options.rows),
                0,
                0,
                &[],
            )
            .await
            .map_err(|_| BridgeError("pty_failed"))?;
        request_reply(&shared, &mut channel, "pty_rejected", None).await
    })
    .await;
    if let Err(error) = pty_result {
        close_channel(shared, &mut channel).await?;
        return Err(error);
    }
    let kind = request.map_or(TerminalKind::Shell, |r| r.kind);
    let result = bounded(
        &shared.cancel,
        ACQUIRE_TIMEOUT,
        if matches!(kind, TerminalKind::Shell) {
            "shell_timeout"
        } else {
            "terminal_exec_timeout"
        },
        async {
            match kind {
                TerminalKind::Shell => channel
                    .request_shell(true)
                    .await
                    .map_err(|_| BridgeError("shell_failed"))?,
                TerminalKind::Exec => channel
                    .exec(
                        true,
                        request
                            .and_then(|r| r.command.as_deref())
                            .ok_or(BridgeError("invalid_terminal"))?,
                    )
                    .await
                    .map_err(|_| BridgeError("terminal_exec_failed"))?,
            }
            request_reply(
                shared,
                &mut channel,
                if matches!(kind, TerminalKind::Shell) {
                    "shell_rejected"
                } else {
                    "terminal_exec_rejected"
                },
                None,
            )
            .await
        },
    )
    .await;
    if let Err(error) = result {
        close_channel(shared, &mut channel).await?;
        return Err(error);
    }
    Ok(channel)
}

async fn close_channel(shared: &Shared, channel: &mut ClientChannel) -> Result<(), BridgeError> {
    if shared.cancel.is_cancelled() {
        return Ok(());
    }
    let cleanup = async {
        channel.close().await?;
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Close) | None => return Ok::<(), russh::Error>(()),
                _ => {} // Discard late data; it cannot escape a canceled request.
            }
        }
    };
    let result = tokio::time::timeout(Duration::from_secs(1), cleanup).await;
    if !matches!(&result, Ok(Ok(()))) && !shared.cancel.is_cancelled() {
        let error = if matches!(result, Ok(Err(_)))
            || shared.transport_error().is_some()
            || shared.network_lost.load(Ordering::Acquire)
        {
            transport_end(shared).await
        } else {
            BridgeError("channel_cleanup_timeout")
        };
        shared.fail(error);
        return Err(error);
    }
    Ok(())
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
            let result = bounded(&shared.cancel, AUTH_TIMEOUT, "auth_timeout", async {
                session
                    .authenticate_publickey(
                        &options.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                    .map_err(|_| BridgeError("auth_failed"))
            })
            .await?;
            if matches!(
                result,
                client::AuthResult::Failure {
                    partial_success: true,
                    ..
                }
            ) {
                return Err(BridgeError("auth_partial_success"));
            }
            result.success()
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

async fn run_exec(
    session: Arc<client::Handle<Handler>>,
    shared: Arc<Shared>,
    request: Arc<ExecRequest>,
    command: String,
) -> Result<u32, BridgeError> {
    if shared.cancel.is_cancelled() {
        return Err(BridgeError("cancelled"));
    }
    if request.cancel.is_cancelled() {
        return Err(BridgeError("exec_cancelled"));
    }
    let deadline = request.deadline;
    if deadline <= Instant::now() {
        return Err(BridgeError("exec_timeout"));
    }
    // Keep this future alive on per-request cancellation. russh cannot cancel an
    // already sent channel-open request; a late channel must be closed explicitly.
    let acquisition = session.channel_open_session();
    tokio::pin!(acquisition);
    let channel = tokio::select! {
        biased;
        _ = shared.cancel.cancelled() => return Err(BridgeError("cancelled")),
        _ = request.cancel.cancelled() => {
            tokio::select! {
                biased;
                _ = shared.cancel.cancelled() => {},
                result = &mut acquisition => {
                    if let Ok(mut channel) = result {
                        let _ = close_channel(&shared,&mut channel).await;
                    }
                },
                _ = tokio::time::sleep_until(deadline) => {
                    shared.fail(BridgeError("channel_cleanup_timeout"));
                },
            }
            return Err(BridgeError("exec_cancelled"));
        },
        result = &mut acquisition => match result {
            Ok(channel)=>channel,
            Err(_) if session.is_closed()=>return Err(transport_end(&shared).await),
            Err(_)=>return Err(BridgeError("exec_channel_failed")),
        },
        _ = tokio::time::sleep_until(deadline) => {
            // Only this Tab's transport is reset. Never call this network loss.
            shared.fail(BridgeError("exec_timeout"));
            return Err(BridgeError("exec_timeout"));
        },
    };
    let mut channel = channel;
    let mut closed = false;
    let operation = async {
        channel
            .exec(true, command)
            .await
            .map_err(|_| BridgeError("exec_failed"))?;
        let mut acknowledged = false;
        let mut status = None;
        let mut bytes = 0usize;
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) if !acknowledged => {
                    acknowledged = true;
                    shared
                        .exec_event(
                            &request,
                            json!({"type":"execStarted","requestId":request.id}),
                        )
                        .await?;
                }
                Some(ChannelMsg::Failure) if !acknowledged => {
                    return Err(BridgeError("exec_rejected"));
                }
                Some(ChannelMsg::Data { data }) => {
                    bytes = bytes
                        .checked_add(data.len())
                        .ok_or(BridgeError("exec_output_limit"))?;
                    if bytes > MAX_EXEC_BYTES {
                        return Err(BridgeError("exec_output_limit"));
                    }
                    shared.exec_data(&request, &data, false).await?;
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    bytes = bytes
                        .checked_add(data.len())
                        .ok_or(BridgeError("exec_output_limit"))?;
                    if bytes > MAX_EXEC_BYTES {
                        return Err(BridgeError("exec_output_limit"));
                    }
                    shared.exec_data(&request, &data, true).await?;
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    if status.replace(exit_status).is_some() {
                        return Err(BridgeError("exec_incomplete"));
                    }
                }
                Some(ChannelMsg::ExitSignal { .. }) => return Err(BridgeError("exec_incomplete")),
                Some(ChannelMsg::Close) | None => {
                    closed = true;
                    if session.is_closed() {
                        return Err(transport_end(&shared).await);
                    }
                    return if acknowledged {
                        status.ok_or(BridgeError("exec_incomplete"))
                    } else {
                        Err(BridgeError("exec_incomplete"))
                    };
                }
                // EOF is half-close. ExitStatus and trailing data may follow it.
                _ => {}
            }
        }
    };
    let result = tokio::select! {
        biased;
        _ = shared.cancel.cancelled() => Err(BridgeError("cancelled")),
        _ = request.cancel.cancelled() => Err(BridgeError("exec_cancelled")),
        _ = tokio::time::sleep_until(deadline) => Err(BridgeError("exec_timeout")),
        result = operation => result,
    };
    if !closed {
        let _ = close_channel(&shared, &mut channel).await;
    }
    result
}
