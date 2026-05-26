import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import * as lark from "@larksuiteoapi/node-sdk";

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function compactText(text, limit = 7500) {
  const normalized = String(text || "").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}\n\n[输出过长，已截断显示]`;
}

function cwdMappingPath(cwd) {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
  return join(homedir(), ".pi", "agent", "pi-webui-feishu", `${hash}.json`);
}

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFile(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

class SerialQueue {
  #tails = new Map();

  enqueue(key, task) {
    const previous = this.#tails.get(key) || Promise.resolve();
    const queued = this.#tails.has(key);
    const current = previous.then(task, task);
    this.#tails.set(key, current);
    current.finally(() => {
      if (this.#tails.get(key) === current) this.#tails.delete(key);
    });
    return { queued, promise: current };
  }
}

class FeishuPiSessionPool {
  constructor({ cwd }) {
    this.cwd = cwd;
    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);
    this.mappingPath = cwdMappingPath(cwd);
    this.mapping = {};
    this.ready = undefined;
    this.sessions = new Map();
  }

  async load() {
    if (!this.ready) {
      this.ready = readJsonFile(this.mappingPath, {}).then((mapping) => {
        this.mapping = mapping && typeof mapping === "object" ? mapping : {};
      });
    }
    await this.ready;
  }

  async get(key) {
    await this.load();
    const existing = this.sessions.get(key);
    if (existing) return existing.ready;

    const ready = this.#create(key);
    this.sessions.set(key, { ready });
    return ready;
  }

  async #create(key) {
    const sessionFile = this.mapping[key];
    let sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined, this.cwd)
      : SessionManager.create(this.cwd);

    let created;
    try {
      created = await createAgentSession({
        cwd: this.cwd,
        authStorage: this.authStorage,
        modelRegistry: this.modelRegistry,
        sessionManager,
      });
    } catch (error) {
      if (!sessionFile) throw error;
      delete this.mapping[key];
      await writeJsonFile(this.mappingPath, this.mapping);
      sessionManager = SessionManager.create(this.cwd);
      created = await createAgentSession({
        cwd: this.cwd,
        authStorage: this.authStorage,
        modelRegistry: this.modelRegistry,
        sessionManager,
      });
    }

    if (created.session.sessionFile && this.mapping[key] !== created.session.sessionFile) {
      this.mapping[key] = created.session.sessionFile;
      await writeJsonFile(this.mappingPath, this.mapping);
    }

    return created.session;
  }

  dispose() {
    for (const item of this.sessions.values()) {
      item.ready.then((session) => session.dispose()).catch(() => {});
    }
    this.sessions.clear();
  }
}

function buildSessionKey(message) {
  const participant = message.senderId || "unknown";
  if (message.chatType === "p2p") {
    return `feishu:dm:${message.chatId || participant}`;
  }
  if (message.threadId) {
    return `feishu:thread:${message.chatId}:${message.threadId}`;
  }
  return `feishu:group:${message.chatId}:${participant}`;
}

function buildPrompt(message) {
  const source = message.chatType === "p2p" ? "飞书私聊" : "飞书群聊";
  const sender = message.senderName || message.senderId || "未知用户";
  return [
    `[${source}]`,
    `发送者：${sender}`,
    message.threadId ? `话题/线程：${message.threadId}` : "",
    "",
    message.content,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function isAllowed(message, allowedUsers) {
  return allowedUsers.has("*") || allowedUsers.has(message.senderId);
}

function createLogger() {
  return {
    error: (...args) => console.error("[feishu]", ...args),
    warn: (...args) => console.warn("[feishu]", ...args),
    info: (...args) => console.log("[feishu]", ...args),
    debug: (...args) => {
      if (process.env.FEISHU_DEBUG === "true") console.log("[feishu:debug]", ...args);
    },
    trace: () => {},
  };
}

export function createFeishuBridge({ cwd }) {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  const enabled = process.env.FEISHU_ENABLED === "true" || Boolean(appId && appSecret);

  if (!enabled) {
    return {
      enabled: false,
      status: () => ({ enabled: false, connected: false, reason: "FEISHU_APP_ID/FEISHU_APP_SECRET 未配置" }),
      stop: async () => {},
    };
  }

  if (!appId || !appSecret) {
    console.warn("[feishu] 已启用飞书桥接，但 FEISHU_APP_ID 或 FEISHU_APP_SECRET 为空。");
    return {
      enabled: true,
      status: () => ({ enabled: true, connected: false, reason: "缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET" }),
      stop: async () => {},
    };
  }

  const allowedUsers = new Set(splitList(process.env.FEISHU_ALLOWED_USERS));
  if (allowedUsers.size === 0) {
    console.warn("[feishu] FEISHU_ALLOWED_USERS 为空，默认拒绝所有用户；可设置为 ou_xxx,ou_yyy 或 *。");
  }

  const requireMention = process.env.FEISHU_REQUIRE_MENTION !== "false";
  const domain = process.env.FEISHU_DOMAIN === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
  const logger = createLogger();
  const sessionPool = new FeishuPiSessionPool({ cwd });
  const queue = new SerialQueue();

  const channel = lark.createLarkChannel({
    appId,
    appSecret,
    domain,
    source: "pi-agent-webui",
    logger,
    loggerLevel: process.env.FEISHU_DEBUG === "true" ? lark.LoggerLevel.debug : lark.LoggerLevel.warn,
    policy: {
      requireMention,
      respondToMentionAll: false,
      dmMode: "open",
    },
    safety: {
      chatQueue: { enabled: false },
      dedup: {
        ttl: 12 * 60 * 60 * 1000,
        maxEntries: 5000,
      },
      staleMessageWindowMs: 30 * 60 * 1000,
    },
  });

  let connected = false;
  let lastError;

  async function reply(message, text, options = {}) {
    const payload = options.markdown ? { markdown: compactText(text) } : { text: compactText(text) };
    return channel.send(message.chatId, payload, {
      replyTo: message.messageId,
      replyInThread: Boolean(message.threadId),
    });
  }

  async function processMessage(message) {
    const sessionKey = buildSessionKey(message);
    const session = await sessionPool.get(sessionKey);
    const prompt = buildPrompt(message);

    await session.prompt(prompt);
    const output = session.getLastAssistantText()?.trim() || "Pi 已完成处理，但没有生成文本输出。";
    await reply(message, output, { markdown: true });
  }

  channel.on("message", async (message) => {
    const content = message.content?.trim();
    if (!content) return;

    if (/^\/?(whoami|我的id|我的 open_id)$/i.test(content)) {
      await reply(
        message,
        [
          `你的 Feishu open_id：${message.senderId || "-"}`,
          `当前 chat_id：${message.chatId || "-"}`,
          `会话类型：${message.chatType || "-"}`,
        ].join("\n"),
      );
      return;
    }

    if (!isAllowed(message, allowedUsers)) {
      if (message.chatType === "p2p") {
        await reply(message, "你暂未在 Pi agent 飞书白名单中。");
      }
      return;
    }

    if (message.chatType === "group" && requireMention && !message.mentionedBot) {
      return;
    }

    const sessionKey = buildSessionKey(message);
    const { queued, promise } = queue.enqueue(sessionKey, () => processMessage(message));
    await reply(message, queued ? "已加入队列，前一个任务完成后会继续处理。" : "已收到，正在交给 Pi agent 处理。");
    promise.catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      reply(message, `Pi agent 执行失败：${lastError}`).catch((sendError) => {
        console.error("[feishu] failed to send error reply", sendError);
      });
    });
  });

  channel.on("reject", (event) => {
    logger.debug("message rejected", event);
  });

  channel.on("error", (error) => {
    lastError = error instanceof Error ? error.message : String(error);
    console.error("[feishu] channel error", error);
  });

  channel.on("reconnecting", () => {
    connected = false;
    console.warn("[feishu] WebSocket reconnecting...");
  });

  channel.on("reconnected", () => {
    connected = true;
    console.log("[feishu] WebSocket reconnected.");
  });

  const startPromise = channel
    .connect()
    .then(() => {
      connected = true;
      console.log("[feishu] Pi bridge connected via WebSocket.");
    })
    .catch((error) => {
      connected = false;
      lastError = error instanceof Error ? error.message : String(error);
      console.error("[feishu] Pi bridge failed to connect:", error);
    });

  return {
    enabled: true,
    status: () => ({
      enabled: true,
      connected,
      connection: channel.getConnectionStatus?.(),
      mappingPath: sessionPool.mappingPath,
      requireMention,
      allowedUsers: [...allowedUsers],
      lastError,
    }),
    stop: async () => {
      await startPromise.catch(() => {});
      await channel.disconnect().catch(() => {});
      sessionPool.dispose();
    },
  };
}
