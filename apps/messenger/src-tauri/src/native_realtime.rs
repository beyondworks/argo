use chrono::{Local, Timelike};
use futures_util::{SinkExt, StreamExt};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::RwLock;
use tokio_tungstenite::tungstenite::Message;

const CLAIM_CAPACITY: usize = 500;
const REFRESH_MARGIN_SECONDS: i64 = 90;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSessionInput {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    user_id: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NativeContextInput {
    foreground: bool,
    visible: bool,
    focused: bool,
    sound: String,
    current_channel: Option<String>,
    muted_channel_ids: Vec<String>,
    org_ids: Vec<String>,
    quiet_from: Option<u32>,
    quiet_to: Option<u32>,
}

impl NativeContextInput {
    const fn is_hidden(&self) -> bool {
        !(self.foreground && self.visible && self.focused)
    }

    fn is_quiet(&self) -> bool {
        let (Some(from), Some(to)) = (self.quiet_from, self.quiet_to) else {
            return false;
        };
        let hour = Local::now().hour();
        if from == to {
            true
        } else if from < to {
            hour >= from && hour < to
        } else {
            hour >= from || hour < to
        }
    }
}

#[derive(Clone)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRealtimeSnapshot {
    status: String,
    generation: u64,
    user_id: Option<String>,
    connected: bool,
    last_error: Option<String>,
    received: u64,
    notified: u64,
    last_message_id: Option<i64>,
    last_stage: Option<String>,
    notification_status: Option<String>,
    notify_result: Option<String>,
    badge_result: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    generation: u64,
    access_token: String,
    refresh_token: String,
    expires_at: i64,
}

#[derive(Serialize)]
pub struct NativeNotifyResult {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct Runtime {
    generation: u64,
    context: Arc<RwLock<NativeContextInput>>,
    tokens: Arc<RwLock<Tokens>>,
    snapshot: Arc<Mutex<NativeRealtimeSnapshot>>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Default)]
struct Controller {
    next_generation: u64,
    current: Option<Runtime>,
}

#[derive(Default)]
struct Claims {
    ids: HashSet<String>,
    order: VecDeque<String>,
}

impl Claims {
    fn claim(&mut self, id: &str) -> bool {
        if !self.ids.insert(id.to_string()) {
            return false;
        }
        self.order.push_back(id.to_string());
        if self.order.len() > CLAIM_CAPACITY {
            if let Some(old) = self.order.pop_front() {
                self.ids.remove(&old);
            }
        }
        true
    }

    fn release(&mut self, id: &str) {
        if self.ids.remove(id) {
            self.order.retain(|claimed| claimed != id);
        }
    }
}

#[derive(Default)]
pub struct NativeRealtimeState {
    controller: Mutex<Controller>,
    claims: Arc<Mutex<Claims>>,
    generation_gate: Arc<GenerationGate>,
}

#[derive(Default)]
struct GenerationGate(AtomicU64);

impl GenerationGate {
    fn activate(&self, generation: u64) {
        self.0.store(generation, Ordering::Release);
    }

    fn is_active(&self, generation: u64) -> bool {
        self.0.load(Ordering::Acquire) == generation
    }

    fn stop(&self, generation: u64) -> bool {
        self.0
            .compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

#[derive(Clone)]
struct WorkerConfig {
    supabase_url: String,
    anon_key: String,
    lang: String,
    user_id: String,
    generation: u64,
}

struct MessageRuntime<'a> {
    context: &'a RwLock<NativeContextInput>,
    claims: &'a Mutex<Claims>,
    generation_gate: &'a Arc<GenerationGate>,
    snapshot: &'a Mutex<NativeRealtimeSnapshot>,
}

#[derive(Deserialize)]
struct RefreshResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
}

#[derive(Deserialize)]
struct ChannelRow {
    name: String,
    kind: String,
}

#[derive(Deserialize)]
struct NativeMessageRow {
    id: i64,
    body: Option<String>,
    channel_id: String,
    org_id: Option<String>,
    author_kind: String,
    author_user_id: Option<String>,
    crew_id: Option<String>,
    deleted_at: Option<String>,
    msgr_channels: Option<ChannelRow>,
}

fn lock<'a, T>(mutex: &'a Mutex<T>) -> Result<MutexGuard<'a, T>, String> {
    mutex
        .lock()
        .map_err(|_| "native realtime state unavailable".to_string())
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs() as i64)
}

fn validate_server_url(value: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(value).map_err(|_| "invalid Supabase URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("invalid Supabase URL".to_string());
    }
    Ok(value.trim_end_matches('/').to_string())
}

fn websocket_url(base: &str, anon_key: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base).map_err(|_| "invalid Supabase URL".to_string())?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme)
        .map_err(|_| "invalid Supabase URL".to_string())?;
    url.set_path("/realtime/v1/websocket");
    url.set_query(None);
    url.query_pairs_mut()
        .append_pair("apikey", anon_key)
        .append_pair("vsn", "1.0.0");
    Ok(url.into())
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

fn join_frame(topic: &str, access_token: &str, reference: u64) -> Value {
    json!({
        "topic": topic,
        "event": "phx_join",
        "payload": {
            "config": {
                "broadcast": {"ack": false, "self": false},
                "presence": {"enabled": false, "key": ""},
                "postgres_changes": [],
                "private": true
            },
            "access_token": access_token
        },
        "ref": reference.to_string()
    })
}

fn join_reply_status(text: &str) -> Option<bool> {
    let frame: Value = serde_json::from_str(text).ok()?;
    if frame.get("event")?.as_str()? != "phx_reply" {
        return None;
    }
    Some(frame.get("payload")?.get("status")?.as_str()? == "ok")
}

fn leave_frame(topic: &str, reference: u64) -> Value {
    json!({"topic": topic, "event": "phx_leave", "payload": {}, "ref": reference.to_string()})
}

fn desired_topics(user_id: &str, context: &NativeContextInput) -> HashSet<String> {
    std::iter::once(format!("realtime:u:{user_id}"))
        .chain(
            context
                .org_ids
                .iter()
                .map(|id| format!("realtime:org:{id}")),
        )
        .collect()
}

fn set_snapshot(
    snapshot: &Mutex<NativeRealtimeSnapshot>,
    status: &str,
    connected: bool,
    error: Option<&str>,
) {
    if let Ok(mut value) = snapshot.lock() {
        value.status = status.to_string();
        value.connected = connected;
        value.last_error = error.map(str::to_string);
    }
}

fn set_message_stage(snapshot: &Mutex<NativeRealtimeSnapshot>, message_id: i64, stage: &str) {
    if let Ok(mut value) = snapshot.lock() {
        value.last_message_id = Some(message_id);
        value.last_stage = Some(stage.to_string());
    }
}

#[tauri::command]
pub async fn native_realtime_start(
    app: AppHandle,
    state: State<'_, NativeRealtimeState>,
    supabase_url: String,
    anon_key: String,
    lang: Option<String>,
    session: NativeSessionInput,
    context: NativeContextInput,
) -> Result<NativeRealtimeSnapshot, String> {
    let supabase_url = validate_server_url(&supabase_url)?;
    if anon_key.is_empty()
        || session.access_token.is_empty()
        || session.refresh_token.is_empty()
        || session.user_id.is_empty()
    {
        return Err("native realtime credentials are incomplete".to_string());
    }

    let context = Arc::new(RwLock::new(context));
    let tokens = Arc::new(RwLock::new(Tokens {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
    }));
    let (generation, snapshot) = {
        let mut controller = lock(&state.controller)?;
        if let Some(mut old) = controller.current.take() {
            if let Some(task) = old.task.take() {
                task.abort();
            }
        }
        controller.next_generation = controller.next_generation.saturating_add(1);
        let generation = controller.next_generation;
        state.generation_gate.activate(generation);
        let snapshot = Arc::new(Mutex::new(NativeRealtimeSnapshot {
            status: "starting".to_string(),
            generation,
            user_id: Some(session.user_id.clone()),
            connected: false,
            last_error: None,
            received: 0,
            notified: 0,
            last_message_id: None,
            last_stage: None,
            notification_status: None,
            notify_result: None,
            badge_result: None,
        }));
        controller.current = Some(Runtime {
            generation,
            context: Arc::clone(&context),
            tokens: Arc::clone(&tokens),
            snapshot: Arc::clone(&snapshot),
            task: None,
        });
        (generation, snapshot)
    };

    let config = WorkerConfig {
        supabase_url,
        anon_key,
        lang: lang.unwrap_or_else(|| "ko".to_string()),
        user_id: session.user_id,
        generation,
    };
    let claims = Arc::clone(&state.claims);
    let generation_gate = Arc::clone(&state.generation_gate);
    let worker_snapshot = Arc::clone(&snapshot);
    let task = tauri::async_runtime::spawn(async move {
        realtime_worker(
            app,
            config,
            tokens,
            context,
            claims,
            generation_gate,
            worker_snapshot,
        )
        .await;
    });
    {
        let mut controller = lock(&state.controller)?;
        if let Some(current) = controller.current.as_mut() {
            if current.generation == generation {
                current.task = Some(task);
            } else {
                task.abort();
            }
        } else {
            task.abort();
        }
    }
    lock(&snapshot).map(|value| value.clone())
}

#[tauri::command]
pub async fn native_realtime_update(
    state: State<'_, NativeRealtimeState>,
    generation: u64,
    context: NativeContextInput,
) -> Result<NativeRealtimeSnapshot, String> {
    let (runtime_context, snapshot) = {
        let controller = lock(&state.controller)?;
        let runtime = controller
            .current
            .as_ref()
            .filter(|runtime| runtime.generation == generation)
            .ok_or_else(|| "stale native realtime generation".to_string())?;
        (Arc::clone(&runtime.context), Arc::clone(&runtime.snapshot))
    };
    *runtime_context.write().await = context;
    lock(&snapshot).map(|value| value.clone())
}

#[tauri::command]
pub async fn native_realtime_stop(
    state: State<'_, NativeRealtimeState>,
    generation: u64,
) -> Result<NativeRealtimeSnapshot, String> {
    let runtime = {
        let mut controller = lock(&state.controller)?;
        let matches = controller
            .current
            .as_ref()
            .is_some_and(|runtime| runtime.generation == generation);
        if !matches {
            return Err("stale native realtime generation".to_string());
        }
        controller.current.take()
    };
    let Some(mut runtime) = runtime else {
        return Err("native realtime is not running".to_string());
    };
    state.generation_gate.stop(generation);
    if let Some(task) = runtime.task.take() {
        task.abort();
    }
    set_snapshot(&runtime.snapshot, "stopped", false, None);
    lock(&runtime.snapshot).map(|value| value.clone())
}

#[tauri::command]
pub async fn native_realtime_snapshot(
    state: State<'_, NativeRealtimeState>,
) -> Result<NativeRealtimeSnapshot, String> {
    let snapshot = {
        let controller = lock(&state.controller)?;
        controller
            .current
            .as_ref()
            .map(|runtime| Arc::clone(&runtime.snapshot))
    };
    match snapshot {
        Some(snapshot) => lock(&snapshot).map(|value| value.clone()),
        None => Ok(NativeRealtimeSnapshot {
            status: "stopped".to_string(),
            ..NativeRealtimeSnapshot::default()
        }),
    }
}

#[tauri::command]
pub async fn native_realtime_current_session(
    state: State<'_, NativeRealtimeState>,
) -> Result<Option<SessionEvent>, String> {
    let current = {
        let controller = lock(&state.controller)?;
        controller.current.as_ref().map(|runtime| {
            (
                runtime.generation,
                Arc::clone(&runtime.tokens),
                Arc::clone(&runtime.snapshot),
            )
        })
    };
    let Some((generation, tokens, snapshot)) = current else {
        return Ok(None);
    };
    let active = lock(&snapshot)?.status != "stopped";
    if !active {
        return Ok(None);
    }
    let tokens = tokens.read().await;
    Ok(Some(SessionEvent {
        generation,
        access_token: tokens.access_token.clone(),
        refresh_token: tokens.refresh_token.clone(),
        expires_at: tokens.expires_at,
    }))
}

#[tauri::command]
pub async fn native_notify_claim_and_send(
    state: State<'_, NativeRealtimeState>,
    message_id: String,
    channel_id: Option<String>,
    title: String,
    body: String,
    sound: Option<String>,
) -> Result<NativeNotifyResult, String> {
    let claimed = lock(&state.claims)?.claim(&message_id);
    if !claimed {
        return Ok(NativeNotifyResult {
            status: "duplicate",
            error: None,
        });
    }
    match super::notify_mac::notify_send(
        title,
        body,
        message_id.clone(),
        sound,
        channel_id,
        Some(message_id.clone()),
    )
    .await
    {
        Ok(()) => Ok(NativeNotifyResult {
            status: "sent",
            error: None,
        }),
        Err(error) => {
            lock(&state.claims)?.release(&message_id);
            Ok(NativeNotifyResult {
                status: "skipped",
                error: Some(error),
            })
        }
    }
}

async fn realtime_worker(
    app: AppHandle,
    config: WorkerConfig,
    tokens: Arc<RwLock<Tokens>>,
    context: Arc<RwLock<NativeContextInput>>,
    claims: Arc<Mutex<Claims>>,
    generation_gate: Arc<GenerationGate>,
    snapshot: Arc<Mutex<NativeRealtimeSnapshot>>,
) {
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(20))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            set_snapshot(&snapshot, "error", false, Some("HTTP client unavailable"));
            return;
        }
    };
    let mut backoff = 1_u64;
    loop {
        if !generation_gate.is_active(config.generation) {
            return;
        }
        let refresh_result = {
            let mut current = tokens.write().await;
            refresh_if_needed(&app, &client, &config, &generation_gate, &mut current).await
        };
        if refresh_result.is_err() {
            set_snapshot(&snapshot, "retrying", false, Some("session refresh failed"));
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
            continue;
        }
        let url = match websocket_url(&config.supabase_url, &config.anon_key) {
            Ok(url) => url,
            Err(_) => {
                set_snapshot(&snapshot, "error", false, Some("realtime URL unavailable"));
                return;
            }
        };
        let socket = tokio_tungstenite::connect_async(url).await;
        let (stream, _) = match socket {
            Ok(connection) => connection,
            Err(_) => {
                set_snapshot(
                    &snapshot,
                    "retrying",
                    false,
                    Some("realtime connect failed"),
                );
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(30);
                continue;
            }
        };
        backoff = 1;
        let (mut sink, mut source) = stream.split();
        let mut current_tokens = tokens.read().await.clone();
        let mut reference = 1_u64;
        let mut topics = desired_topics(&config.user_id, &*context.read().await);
        let mut join_failed = false;
        for topic in &topics {
            if sink
                .send(Message::Text(
                    join_frame(topic, &current_tokens.access_token, reference)
                        .to_string()
                        .into(),
                ))
                .await
                .is_err()
            {
                join_failed = true;
                break;
            }
            reference = reference.saturating_add(1);
        }
        if join_failed {
            set_snapshot(&snapshot, "retrying", false, Some("realtime join failed"));
            continue;
        }
        set_snapshot(&snapshot, "joining", false, None);
        let mut interval = tokio::time::interval(Duration::from_secs(25));
        loop {
            tokio::select! {
                incoming = source.next() => {
                    let Some(incoming) = incoming else { break; };
                    let Ok(message) = incoming else { break; };
                    match message {
                        Message::Text(text) => {
                            if let Some(joined) = join_reply_status(&text) {
                                if !joined { break; }
                                set_snapshot(&snapshot, "connected", true, None);
                                continue;
                            }
                            if let Some(payload) = broadcast_message_payload(&text) {
                                if let Ok(mut value) = snapshot.lock() {
                                    value.received = value.received.saturating_add(1);
                                }
                                current_tokens = tokens.read().await.clone();
                                process_message(
                                    &app,
                                    &client,
                                    &config,
                                    &current_tokens,
                                    MessageRuntime { context: &context, claims: &claims, generation_gate: &generation_gate, snapshot: &snapshot },
                                    payload,
                                ).await;
                            }
                        }
                        Message::Ping(payload) => {
                            if sink.send(Message::Pong(payload)).await.is_err() { break; }
                        }
                        Message::Close(_) => break,
                        Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
                    }
                }
                _ = interval.tick() => {
                    let refresh_result = {
                        let mut current = tokens.write().await;
                        refresh_if_needed(&app, &client, &config, &generation_gate, &mut current).await
                    };
                    let refreshed = match refresh_result {
                        Ok(refreshed) => refreshed,
                        Err(_) => break,
                    };
                    let heartbeat = json!({"topic":"phoenix","event":"heartbeat","payload":{},"ref":reference.to_string()});
                    if sink.send(Message::Text(heartbeat.to_string().into())).await.is_err() { break; }
                    reference = reference.saturating_add(1);
                    if refreshed {
                        current_tokens = tokens.read().await.clone();
                        for topic in &topics {
                            let auth = json!({"topic":topic,"event":"access_token","payload":{"access_token":current_tokens.access_token},"ref":reference.to_string()});
                            if sink.send(Message::Text(auth.to_string().into())).await.is_err() { join_failed = true; break; }
                            reference = reference.saturating_add(1);
                        }
                        if join_failed { break; }
                    }
                    let desired = desired_topics(&config.user_id, &*context.read().await);
                    for topic in topics.difference(&desired) {
                        if sink.send(Message::Text(leave_frame(topic, reference).to_string().into())).await.is_err() { join_failed = true; break; }
                        reference = reference.saturating_add(1);
                    }
                    if join_failed { break; }
                    for topic in desired.difference(&topics) {
                        if sink.send(Message::Text(join_frame(topic, &current_tokens.access_token, reference).to_string().into())).await.is_err() { join_failed = true; break; }
                        reference = reference.saturating_add(1);
                    }
                    if join_failed { break; }
                    topics = desired;
                }
            }
        }
        set_snapshot(&snapshot, "retrying", false, Some("realtime disconnected"));
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}

fn broadcast_message_payload(text: &str) -> Option<Value> {
    let frame: Value = serde_json::from_str(text).ok()?;
    if frame.get("event")?.as_str()? != "broadcast" {
        return None;
    }
    let envelope = frame.get("payload")?;
    if envelope.get("event")?.as_str()? != "message" {
        return None;
    }
    envelope.get("payload").cloned()
}

async fn refresh_if_needed(
    app: &AppHandle,
    client: &reqwest::Client,
    config: &WorkerConfig,
    generation_gate: &GenerationGate,
    tokens: &mut Tokens,
) -> Result<bool, String> {
    if tokens.expires_at - now_seconds() > REFRESH_MARGIN_SECONDS {
        return Ok(false);
    }
    let url = format!("{}/auth/v1/token", config.supabase_url);
    let response = client
        .post(url)
        .query(&[("grant_type", "refresh_token")])
        .header("apikey", &config.anon_key)
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({"refresh_token": tokens.refresh_token}))
        .send()
        .await
        .map_err(|_| "session refresh request failed".to_string())?;
    if !response.status().is_success() {
        return Err("session refresh rejected".to_string());
    }
    let refreshed: RefreshResponse = response
        .json()
        .await
        .map_err(|_| "session refresh response invalid".to_string())?;
    if !generation_gate.is_active(config.generation) {
        return Err("stale native realtime generation".to_string());
    }
    tokens.access_token = refreshed.access_token;
    tokens.refresh_token = refreshed.refresh_token;
    tokens.expires_at = now_seconds().saturating_add(refreshed.expires_in);
    let _ = app.emit(
        "native-realtime-session",
        SessionEvent {
            generation: config.generation,
            access_token: tokens.access_token.clone(),
            refresh_token: tokens.refresh_token.clone(),
            expires_at: tokens.expires_at,
        },
    );
    Ok(true)
}

async fn process_message(
    app: &AppHandle,
    client: &reqwest::Client,
    config: &WorkerConfig,
    tokens: &Tokens,
    runtime: MessageRuntime<'_>,
    payload: Value,
) {
    let MessageRuntime {
        context,
        claims,
        generation_gate,
        snapshot,
    } = runtime;
    let Some(message_id) = payload.get("id").and_then(Value::as_i64) else {
        return;
    };
    set_message_stage(snapshot, message_id, "received");
    if !generation_gate.is_active(config.generation) {
        set_message_stage(snapshot, message_id, "skipped-stale-generation");
        return;
    }
    let badge = sync_badge(app, client, config, tokens).await;
    if let Ok(mut value) = snapshot.lock() {
        value.badge_result = Some(match badge {
            Ok(count) => format!("set:{count}"),
            Err(error) => error,
        });
    }
    let before = context.read().await.clone();
    if !before.is_hidden() {
        set_message_stage(snapshot, message_id, "skipped-visible");
        return;
    }
    if before.is_quiet() {
        set_message_stage(snapshot, message_id, "skipped-quiet");
        return;
    }
    let message = match fetch_message(client, config, tokens, message_id).await {
        Ok(Some(message)) => message,
        Ok(None) => {
            set_message_stage(snapshot, message_id, "rls-empty");
            return;
        }
        Err(stage) => {
            set_message_stage(snapshot, message_id, &stage);
            return;
        }
    };
    if message.deleted_at.is_some() {
        set_message_stage(snapshot, message_id, "skipped-deleted");
        return;
    }
    if message.author_user_id.as_deref() == Some(config.user_id.as_str()) {
        set_message_stage(snapshot, message_id, "skipped-self");
        return;
    }
    if before.muted_channel_ids.contains(&message.channel_id) {
        set_message_stage(snapshot, message_id, "skipped-muted");
        return;
    }
    let after = context.read().await.clone();
    if !after.is_hidden()
        || after.is_quiet()
        || after.muted_channel_ids.contains(&message.channel_id)
        || !generation_gate.is_active(config.generation)
    {
        set_message_stage(snapshot, message_id, "skipped-context-changed");
        return;
    }
    let claim_key = format!("message:{}", message.id);
    let claimed = claims
        .lock()
        .map(|mut claims| claims.claim(&claim_key))
        .unwrap_or(false);
    if !claimed {
        set_message_stage(snapshot, message_id, "skipped-duplicate");
        return;
    }
    let author = fetch_author_name(client, config, tokens, &message)
        .await
        .unwrap_or_else(|| "Argo".to_string());
    if !generation_gate.is_active(config.generation) {
        if let Ok(mut value) = claims.lock() {
            value.release(&claim_key);
        }
        set_message_stage(snapshot, message_id, "skipped-stale-generation");
        return;
    }
    let channel = message.msgr_channels.as_ref();
    let title = if channel.is_some_and(|channel| channel.kind == "dm") {
        author
    } else if config.lang == "en" {
        format!(
            "{author} in #{}",
            channel.map_or("", |channel| channel.name.as_str())
        )
    } else {
        format!(
            "{author} · #{}",
            channel.map_or("", |channel| channel.name.as_str())
        )
    };
    let body = message
        .body
        .as_deref()
        .map(str::trim)
        .filter(|body| !body.is_empty())
        .map(|body| body.chars().take(140).collect::<String>())
        .unwrap_or_else(|| {
            if config.lang == "en" {
                "Sent an attachment".to_string()
            } else {
                "사진·파일을 보냈습니다".to_string()
            }
        });
    let notification_status = super::notify_mac::notify_capability_status()
        .await
        .unwrap_or_else(|error| format!("error:{error}"));
    if let Ok(mut value) = snapshot.lock() {
        value.notification_status = Some(notification_status);
    }
    let active_generation = Arc::clone(generation_gate);
    let generation = config.generation;
    let notify_result = super::notify_mac::notify_send_guarded(
        title,
        body,
        claim_key.clone(),
        Some(after.sound),
        Some(message.channel_id.clone()),
        Some(claim_key.clone()),
        move || active_generation.is_active(generation),
    )
    .await;
    match notify_result {
        Ok(()) => {
            if let Ok(mut value) = snapshot.lock() {
                value.notify_result = Some("submitted".to_string());
                value.last_stage = Some("notified".to_string());
                value.last_message_id = Some(message_id);
                value.notified = value.notified.saturating_add(1);
            }
        }
        Err(error) => {
            if let Ok(mut value) = claims.lock() {
                value.release(&claim_key);
            }
            if let Ok(mut value) = snapshot.lock() {
                value.notify_result = Some(format!("error:{error}"));
                value.last_stage = Some("notify-error".to_string());
                value.last_message_id = Some(message_id);
            }
        }
    }
}

async fn fetch_message(
    client: &reqwest::Client,
    config: &WorkerConfig,
    tokens: &Tokens,
    message_id: i64,
) -> Result<Option<NativeMessageRow>, String> {
    let url = format!("{}/rest/v1/msgr_messages", config.supabase_url);
    let response = client
        .get(url)
        .query(&[
            ("select", "id,body,channel_id,org_id,author_kind,author_user_id,crew_id,deleted_at,msgr_channels(name,kind)".to_string()),
            ("id", format!("eq.{message_id}")),
            ("deleted_at", "is.null".to_string()),
            ("limit", "1".to_string()),
        ])
        .header("apikey", &config.anon_key)
        .header(AUTHORIZATION, bearer(&tokens.access_token))
        .send()
        .await
        .map_err(|_| "rls-request-error".to_string())?;
    if !response.status().is_success() {
        return Err(format!("rls-http-{}", response.status().as_u16()));
    }
    Ok(response
        .json::<Vec<NativeMessageRow>>()
        .await
        .map_err(|_| "rls-response-invalid".to_string())?
        .into_iter()
        .next())
}

async fn fetch_author_name(
    client: &reqwest::Client,
    config: &WorkerConfig,
    tokens: &Tokens,
    message: &NativeMessageRow,
) -> Option<String> {
    let (table, filters) = if message.author_kind == "crew" {
        (
            "msgr_crews",
            vec![("id", format!("eq.{}", message.crew_id.as_ref()?))],
        )
    } else if let Some(org_id) = message.org_id.as_ref() {
        (
            "msgr_org_members",
            vec![
                ("org_id", format!("eq.{org_id}")),
                (
                    "user_id",
                    format!("eq.{}", message.author_user_id.as_ref()?),
                ),
            ],
        )
    } else {
        (
            "msgr_profiles",
            vec![(
                "user_id",
                format!("eq.{}", message.author_user_id.as_ref()?),
            )],
        )
    };
    let url = format!("{}/rest/v1/{table}", config.supabase_url);
    let mut request = client
        .get(url)
        .query(&[("select", "display_name"), ("limit", "1")])
        .header("apikey", &config.anon_key)
        .header(AUTHORIZATION, bearer(&tokens.access_token));
    for (key, value) in filters {
        request = request.query(&[(key, value)]);
    }
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response
        .json::<Vec<Value>>()
        .await
        .ok()?
        .first()
        .and_then(|row| row.get("display_name"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

async fn sync_badge(
    app: &AppHandle,
    client: &reqwest::Client,
    config: &WorkerConfig,
    tokens: &Tokens,
) -> Result<i64, String> {
    let url = format!("{}/rest/v1/rpc/msgr_unread_totals", config.supabase_url);
    let response = client
        .post(url)
        .header("apikey", &config.anon_key)
        .header(AUTHORIZATION, bearer(&tokens.access_token))
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({}))
        .send()
        .await
        .map_err(|_| "badge-request-error".to_string())?;
    if !response.status().is_success() {
        return Err(format!("badge-http-{}", response.status().as_u16()));
    }
    let rows = response
        .json::<Vec<Value>>()
        .await
        .map_err(|_| "badge-response-invalid".to_string())?;
    let count = rows
        .iter()
        .filter_map(|row| row.get("n").and_then(Value::as_i64))
        .fold(0_i64, i64::saturating_add);
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_badge_count((count > 0).then_some(count))
            .map_err(|_| "badge-set-error".to_string())?;
        Ok(count)
    } else {
        Err("badge-window-missing".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supabase_broadcast_message() {
        let frame = json!({
            "topic": "realtime:u:person",
            "event": "broadcast",
            "payload": {"event": "message", "payload": {"id": 42, "channel_id": "room"}},
            "ref": null
        });
        assert_eq!(
            broadcast_message_payload(&frame.to_string())
                .and_then(|payload| payload.get("id").and_then(Value::as_i64)),
            Some(42)
        );
    }

    #[test]
    fn ignores_non_message_wire_events() {
        let heartbeat = json!({"event":"phx_reply","payload":{}});
        assert!(broadcast_message_payload(&heartbeat.to_string()).is_none());
    }

    #[test]
    fn join_wire_is_private_and_presence_free() {
        let frame = join_frame("realtime:u:person", "session-token", 7);
        assert_eq!(frame["payload"]["config"]["private"], true);
        assert_eq!(frame["payload"]["config"]["presence"]["enabled"], false);
        assert_eq!(frame["payload"]["config"]["presence"]["key"], "");
        assert_eq!(frame["payload"]["access_token"], "session-token");
        assert_eq!(frame["ref"], "7");
    }

    #[test]
    fn subscribes_to_user_and_public_org_topics() {
        let context = NativeContextInput {
            org_ids: vec!["org-a".to_string(), "org-b".to_string()],
            ..NativeContextInput::default()
        };
        let topics = desired_topics("person", &context);
        assert_eq!(topics.len(), 3);
        assert!(topics.contains("realtime:u:person"));
        assert!(topics.contains("realtime:org:org-a"));
        assert!(topics.contains("realtime:org:org-b"));
    }

    #[test]
    fn join_reply_requires_explicit_ok() {
        assert_eq!(
            join_reply_status(
                &json!({"event":"phx_reply","ref":"1","payload":{"status":"ok"}}).to_string()
            ),
            Some(true)
        );
        assert_eq!(
            join_reply_status(
                &json!({"event":"phx_reply","ref":"1","payload":{"status":"error"}}).to_string()
            ),
            Some(false)
        );
    }

    #[test]
    fn claims_each_message_once_and_evicts_oldest() {
        let mut claims = Claims::default();
        assert!(claims.claim("message:1"));
        assert!(!claims.claim("message:1"));
        for id in 2..=(CLAIM_CAPACITY as i64 + 1) {
            assert!(claims.claim(&format!("message:{id}")));
        }
        assert!(claims.claim("message:1"));
    }

    #[test]
    fn failed_notification_releases_claim_for_retry() {
        let mut claims = Claims::default();
        assert!(claims.claim("message:9"));
        claims.release("message:9");
        assert!(claims.claim("message:9"));
    }

    #[test]
    fn generation_isolates_relogin_and_account_switch() {
        let gate = GenerationGate::default();
        gate.activate(1);
        assert!(gate.is_active(1));
        gate.activate(2);
        assert!(!gate.is_active(1));
        assert!(gate.is_active(2));
        assert!(!gate.stop(1));
        assert!(gate.is_active(2));
        assert!(gate.stop(2));
        assert!(!gate.is_active(2));
    }

    #[test]
    fn snapshot_never_serializes_credentials() {
        let snapshot = NativeRealtimeSnapshot {
            status: "connected".to_string(),
            generation: 3,
            user_id: Some("person".to_string()),
            connected: true,
            last_error: None,
            received: 1,
            notified: 1,
            ..NativeRealtimeSnapshot::default()
        };
        let serialized = serde_json::to_string(&snapshot).expect("snapshot serializes");
        assert!(!serialized.contains("accessToken"));
        assert!(!serialized.contains("refreshToken"));
    }

    #[test]
    fn hidden_classification_requires_all_foreground_signals() {
        let mut context = NativeContextInput {
            foreground: true,
            visible: true,
            focused: true,
            ..NativeContextInput::default()
        };
        assert!(!context.is_hidden());
        context.focused = false;
        assert!(context.is_hidden());
    }

    #[test]
    fn websocket_url_contains_vsn_without_token() {
        let url = websocket_url("https://example.supabase.co", "public-anon");
        assert_eq!(
            url.as_deref(),
            Ok("wss://example.supabase.co/realtime/v1/websocket?apikey=public-anon&vsn=1.0.0")
        );
    }
}
