import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "./server/config-store.mjs";
import { createFeishuBridgeManager } from "./server/feishu-bridge.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");

function loadDotEnv(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

loadDotEnv(join(__dirname, ".env"));

const port = Number(process.env.PORT || 4317);
const agentCwd = resolve(process.env.PI_WEBUI_CWD || process.cwd());
const configStore = new ConfigStore({ cwd: agentCwd });

const clients = new Set();
let session;
let sessionReady;
let authStorage;
let modelRegistry;
let unsubscribeSessionEvents;
let lastRunId = 0;
let feishuBridge;

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(data);
  }
}

function send(client, payload) {
  client.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part?.type === "text") return part.text || "";
      if (part?.type === "thinking") return part.thinking ? `[thinking]\n${part.thinking}` : "";
      if (part?.type === "toolCall") return `[tool call: ${part.toolName || part.name || "tool"}]`;
      if (part?.type === "toolResult") return `[tool result]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function serializeMessage(message) {
  return {
    id: message.id || crypto.randomUUID(),
    role: message.role || "custom",
    text: textFromContent(message.content),
    timestamp: message.timestamp || Date.now(),
  };
}

function statePayload() {
  return {
    cwd: agentCwd,
    sessionId: session?.sessionId,
    sessionFile: session?.sessionFile,
    isStreaming: Boolean(session?.isStreaming),
    thinkingLevel: session?.thinkingLevel,
    model: session?.model
      ? {
          provider: session.model.provider,
          id: session.model.id,
          label: session.model.label || session.model.id,
        }
      : undefined,
    messages: session?.messages?.map(serializeMessage) || [],
  };
}

function serializeSessionInfo(info) {
  return {
    path: info.path,
    id: info.id,
    cwd: info.cwd,
    name: info.name,
    title: info.name || info.firstMessage || "空白会话",
    firstMessage: info.firstMessage,
    messageCount: info.messageCount,
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    isCurrent: info.path === session?.sessionFile,
  };
}

async function sessionsPayload() {
  const sessions = await SessionManager.list(agentCwd);
  if (session?.sessionFile && !sessions.some((info) => info.path === session.sessionFile)) {
    const now = new Date();
    sessions.unshift({
      path: session.sessionFile,
      id: session.sessionId,
      cwd: agentCwd,
      name: undefined,
      parentSessionPath: undefined,
      created: now,
      modified: now,
      messageCount: session.messages.length,
      firstMessage: "空白会话",
      allMessagesText: "",
    });
  }
  return {
    current: session?.sessionFile,
    sessions: sessions.map(serializeSessionInfo),
  };
}

function broadcastSessions() {
  sessionsPayload()
    .then((payload) => broadcast({ type: "sessions", ...payload }))
    .catch((error) => {
      broadcast({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });
}

function serializeModel(model) {
  return {
    provider: model.provider,
    id: model.id,
    label: model.label || model.name || model.id,
    name: model.name || model.label || model.id,
    reasoning: Boolean(model.reasoning),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function modelKey(model) {
  return `${model.provider}/${model.id}`;
}

function modelsPayload() {
  const models = modelRegistry?.getAvailable().map(serializeModel) || [];
  return {
    current: session?.model ? modelKey(session.model) : undefined,
    models,
    error: modelRegistry?.getError(),
  };
}

async function configPayload() {
  return {
    paths: {
      appConfig: configStore.configPath,
      modelsJson: configStore.modelsJsonPath,
    },
    providers: await configStore.listProviders(),
    feishuBots: await configStore.listBots(),
    feishuStatus: feishuBridge?.status() || { enabled: false, connected: false, bots: [] },
  };
}

function refreshModelRegistries() {
  modelRegistry?.refresh();
  feishuBridge?.refreshModels();
  broadcast({ type: "models", ...modelsPayload() });
}

function normalizeEvent(event) {
  switch (event.type) {
    case "agent_start":
      return { type: "status", status: "running" };
    case "agent_end":
      return { type: "status", status: event.willRetry ? "retrying" : "idle" };
    case "message_start":
      return { type: "message_start", message: serializeMessage(event.message) };
    case "message_end":
      return { type: "message_end", message: serializeMessage(event.message) };
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        return { type: "assistant_delta", delta: update.delta };
      }
      if (update.type === "thinking_delta") {
        return { type: "thinking_delta", delta: update.delta };
      }
      if (update.type === "toolcall_end") {
        return { type: "tool_call", toolCall: update.toolCall };
      }
      return { type: "message_update", updateType: update.type };
    }
    case "tool_execution_start":
      return {
        type: "tool_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_update":
      return {
        type: "tool_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
      };
    case "tool_execution_end":
      return {
        type: "tool_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      };
    case "queue_update":
      return { type: "queue", steering: event.steering, followUp: event.followUp };
    case "thinking_level_changed":
      return { type: "thinking_level", level: event.level };
    case "auto_retry_start":
      return {
        type: "retry_start",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      };
    case "auto_retry_end":
      return {
        type: "retry_end",
        success: event.success,
        attempt: event.attempt,
        finalError: event.finalError,
      };
    default:
      return { type: event.type };
  }
}

function ensureServices() {
  if (!authStorage || !modelRegistry) {
    authStorage = AuthStorage.create();
    modelRegistry = ModelRegistry.create(authStorage);
  }
}

function attachSessionEvents(activeSession) {
  unsubscribeSessionEvents?.();
  unsubscribeSessionEvents = activeSession.subscribe((event) => {
    const normalized = normalizeEvent(event);
    broadcast(normalized);
    if (
      normalized.type === "status" ||
      normalized.type === "thinking_level" ||
      normalized.type === "message_end"
    ) {
      broadcast({ type: "state", state: statePayload() });
    }
    if (normalized.type === "status" || normalized.type === "message_end") {
      broadcastSessions();
    }
  });
}

async function replaceSession(sessionManager) {
  ensureServices();
  unsubscribeSessionEvents?.();
  unsubscribeSessionEvents = undefined;
  session?.dispose();

  const created = await createAgentSession({
    cwd: agentCwd,
    authStorage,
    modelRegistry,
    sessionManager,
  });

  session = created.session;
  sessionReady = Promise.resolve(session);
  attachSessionEvents(session);

  if (created.modelFallbackMessage) {
    broadcast({ type: "notice", message: created.modelFallbackMessage });
  }

  broadcast({ type: "state", state: statePayload() });
  broadcast({ type: "models", ...modelsPayload() });
  broadcastSessions();

  return session;
}

async function initSession() {
  if (sessionReady) return sessionReady;

  sessionReady = replaceSession(SessionManager.continueRecent(agentCwd));

  return sessionReady;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function respondJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = resolve(publicDir, `.${pathname}`);
  if (!safePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(safePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    res.writeHead(200, {
      "content-type": types[extname(safePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/events" && req.method === "GET") {
    await initSession();
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    clients.add(res);
    send(res, { type: "state", state: statePayload() });
    send(res, { type: "models", ...modelsPayload() });
    send(res, { type: "sessions", ...(await sessionsPayload()) });
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    await initSession();
    respondJson(res, 200, statePayload());
    return;
  }

  if (url.pathname === "/api/feishu/status" && req.method === "GET") {
    respondJson(res, 200, feishuBridge?.status() || { enabled: false, connected: false, bots: [] });
    return;
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    respondJson(res, 200, await configPayload());
    return;
  }

  if (url.pathname === "/api/config/providers" && req.method === "POST") {
    const provider = await configStore.upsertProvider(await readJson(req));
    refreshModelRegistries();
    respondJson(res, 200, { ok: true, provider, config: await configPayload() });
    return;
  }

  const providerMatch = url.pathname.match(/^\/api\/config\/providers\/([^/]+)$/);
  if (providerMatch && req.method === "DELETE") {
    await configStore.deleteProvider(decodeURIComponent(providerMatch[1]));
    refreshModelRegistries();
    respondJson(res, 200, { ok: true, config: await configPayload() });
    return;
  }

  if (url.pathname === "/api/config/feishu/bots" && req.method === "POST") {
    const body = await readJson(req);
    const original = String(body.original || "").trim();
    const bot = await configStore.upsertBot(body);
    if (original && original !== bot.id) {
      await feishuBridge?.stopBot(original);
    }
    await feishuBridge?.syncBotChange(bot.id);
    respondJson(res, 200, { ok: true, bot, config: await configPayload() });
    return;
  }

  const botMatch = url.pathname.match(/^\/api\/config\/feishu\/bots\/([^/]+)(?:\/(start|stop))?$/);
  if (botMatch && req.method === "DELETE" && !botMatch[2]) {
    const id = decodeURIComponent(botMatch[1]);
    await feishuBridge?.stopBot(id);
    await configStore.deleteBot(id);
    await feishuBridge?.reloadBots();
    respondJson(res, 200, { ok: true, config: await configPayload() });
    return;
  }

  if (botMatch && req.method === "POST" && botMatch[2] === "start") {
    const id = decodeURIComponent(botMatch[1]);
    const status = await feishuBridge.startBot(id);
    respondJson(res, 200, { ok: true, status, config: await configPayload() });
    return;
  }

  if (botMatch && req.method === "POST" && botMatch[2] === "stop") {
    const id = decodeURIComponent(botMatch[1]);
    await feishuBridge.stopBot(id);
    respondJson(res, 200, { ok: true, config: await configPayload() });
    return;
  }

  if (url.pathname === "/api/models" && req.method === "GET") {
    await initSession();
    respondJson(res, 200, modelsPayload());
    return;
  }

  if (url.pathname === "/api/model" && req.method === "POST") {
    const activeSession = await initSession();
    const body = await readJson(req);
    const provider = String(body.provider || "").trim();
    const id = String(body.id || "").trim();

    if (!provider || !id) {
      respondJson(res, 400, { error: "需要提供 provider 和 id。" });
      return;
    }

    if (activeSession.isStreaming) {
      respondJson(res, 409, { error: "Pi 正在运行，完成或中止后再切换模型。" });
      return;
    }

    const nextModel = modelRegistry.find(provider, id);
    if (!nextModel || !modelRegistry.hasConfiguredAuth(nextModel)) {
      respondJson(res, 404, { error: `没有找到可用模型：${provider}/${id}` });
      return;
    }

    await activeSession.setModel(nextModel);
    const payload = { ok: true, model: serializeModel(nextModel), state: statePayload() };
    respondJson(res, 200, payload);
    broadcast({ type: "state", state: payload.state });
    broadcast({ type: "models", ...modelsPayload() });
    return;
  }

  if (url.pathname === "/api/sessions" && req.method === "GET") {
    await initSession();
    respondJson(res, 200, await sessionsPayload());
    return;
  }

  if (url.pathname === "/api/session/new" && req.method === "POST") {
    const activeSession = await initSession();
    if (activeSession.isStreaming) {
      respondJson(res, 409, { error: "Pi 正在运行，完成或中止后再新建会话。" });
      return;
    }

    await replaceSession(SessionManager.create(agentCwd));
    respondJson(res, 200, { ok: true, state: statePayload(), sessions: await sessionsPayload() });
    return;
  }

  if (url.pathname === "/api/session/switch" && req.method === "POST") {
    const activeSession = await initSession();
    const body = await readJson(req);
    const path = String(body.path || "").trim();

    if (!path) {
      respondJson(res, 400, { error: "需要提供会话路径。" });
      return;
    }

    if (activeSession.isStreaming) {
      respondJson(res, 409, { error: "Pi 正在运行，完成或中止后再切换会话。" });
      return;
    }

    const knownSessions = await SessionManager.list(agentCwd);
    if (!knownSessions.some((item) => item.path === path)) {
      respondJson(res, 404, { error: "没有找到这个工作目录下的会话。" });
      return;
    }

    if (path !== activeSession.sessionFile) {
      await replaceSession(SessionManager.open(path, undefined, agentCwd));
    }

    respondJson(res, 200, { ok: true, state: statePayload(), sessions: await sessionsPayload() });
    return;
  }

  if (url.pathname === "/api/prompt" && req.method === "POST") {
    const activeSession = await initSession();
    const body = await readJson(req);
    const text = String(body.text || "").trim();
    const behavior = body.behavior === "steer" ? "steer" : "followUp";
    if (!text) {
      respondJson(res, 400, { error: "Prompt text is required." });
      return;
    }

    const runId = ++lastRunId;
    respondJson(res, 202, { ok: true, runId });

    activeSession
      .prompt(text, activeSession.isStreaming ? { streamingBehavior: behavior } : undefined)
      .catch((error) => {
        broadcast({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          runId,
        });
        broadcast({ type: "state", state: statePayload() });
      });
    return;
  }

  if (url.pathname === "/api/abort" && req.method === "POST") {
    const activeSession = await initSession();
    await activeSession.abort();
    respondJson(res, 200, { ok: true });
    broadcast({ type: "state", state: statePayload() });
    return;
  }

  respondJson(res, 404, { error: "Not found" });
}

const server = createServer((req, res) => {
  const handler = req.url?.startsWith("/api/") ? handleApi : serveStatic;
  handler(req, res).catch((error) => {
    if (req.url?.startsWith("/api/")) {
      respondJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    } else {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    }
  });
});

process.on("SIGINT", () => {
  unsubscribeSessionEvents?.();
  session?.dispose();
  Promise.resolve(feishuBridge?.stop()).finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  unsubscribeSessionEvents?.();
  session?.dispose();
  Promise.resolve(feishuBridge?.stop()).finally(() => process.exit(0));
});

server.listen(port, () => {
  console.log(`Pi WebUI: http://localhost:${port}`);
  console.log(`Agent cwd: ${agentCwd}`);
  feishuBridge = createFeishuBridgeManager({ cwd: agentCwd, configStore });
  feishuBridge
    .startConfigured()
    .then(() => {
      console.log(feishuBridge.enabled ? "Feishu bridge: enabled" : "Feishu bridge: disabled");
    })
    .catch((error) => {
      console.error("Feishu bridge failed to start:", error);
    });
});
