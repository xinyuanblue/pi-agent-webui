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
import { envFeishuBot } from "./config-store.mjs";

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
  constructor({ cwd, botId }) {
    this.cwd = cwd;
    this.botId = botId;
    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);
    this.mappingPath = cwdMappingPath(cwd);
    this.mapping = {};
    this.ready = undefined;
    this.sessions = new Map();
  }

  refreshModels() {
    this.modelRegistry.refresh();
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

function buildSessionKey(botId, message) {
  const participant = message.senderId || "unknown";
  if (message.chatType === "p2p") {
    return `feishu:${botId}:dm:${message.chatId || participant}`;
  }
  if (message.threadId) {
    return `feishu:${botId}:thread:${message.chatId}:${message.threadId}`;
  }
  return `feishu:${botId}:group:${message.chatId}:${participant}`;
}

function buildPrompt(message) {
  const source = message.chatType === "p2p" ? "飞书私聊" : "飞书群聊";
  const sender = message.senderName || message.senderId || "未知用户";
  return [
    "你正在通过飞书机器人与用户对话。",
    "你的最终回答会被系统直接发送回飞书，所以普通聊天、测试连接、状态询问都要直接回答，不要再询问“是否需要回复”或要求用户确认回复内容。",
    "如果用户要求执行会修改文件、运行命令、部署、删除、发送外部消息等高风险操作，先简要说明将要做什么并请求确认；低风险读取、解释、检查类任务可以直接执行。",
    "最终回答应面向飞书用户，不要复述本段系统说明，也不要无必要暴露 sender_id、chat_id 等内部标识。",
    "",
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

function createLogger(botName = "feishu") {
  return {
    error: (...args) => console.error(`[feishu:${botName}]`, ...args),
    warn: (...args) => console.warn(`[feishu:${botName}]`, ...args),
    info: (...args) => console.log(`[feishu:${botName}]`, ...args),
    debug: (...args) => {
      if (process.env.FEISHU_DEBUG === "true") console.log(`[feishu:${botName}:debug]`, ...args);
    },
    trace: () => {},
  };
}

class FeishuBotRuntime {
  constructor({ cwd, bot }) {
    this.cwd = cwd;
    this.bot = bot;
    this.allowedUsers = new Set(splitList(bot.allowedUsers));
    this.requireMention = bot.requireMention !== false;
    this.domain = bot.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
    this.logger = createLogger(bot.id);
    this.sessionPool = new FeishuPiSessionPool({ cwd, botId: bot.id });
    this.queue = new SerialQueue();
    this.connected = false;
    this.lastError = undefined;
    this.startPromise = undefined;

    if (this.allowedUsers.size === 0) {
      this.logger.warn("白名单为空，默认拒绝所有用户；可在 WebUI 中填写 ou_xxx 或 *。");
    }

    this.channel = lark.createLarkChannel({
      appId: bot.appId,
      appSecret: bot.appSecret,
      domain: this.domain,
      source: "pi-agent-webui",
      logger: this.logger,
      loggerLevel: process.env.FEISHU_DEBUG === "true" ? lark.LoggerLevel.debug : lark.LoggerLevel.warn,
      policy: {
        requireMention: this.requireMention,
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

    this.#bindEvents();
  }

  async reply(message, text, options = {}) {
    const payload = options.markdown ? { markdown: compactText(text) } : { text: compactText(text) };
    return this.channel.send(message.chatId, payload, {
      replyTo: message.messageId,
      replyInThread: Boolean(message.threadId),
    });
  }

  async processMessage(message) {
    const sessionKey = buildSessionKey(this.bot.id, message);
    const session = await this.sessionPool.get(sessionKey);
    const prompt = buildPrompt(message);

    await session.prompt(prompt);
    const output = session.getLastAssistantText()?.trim() || "Pi 已完成处理，但没有生成文本输出。";
    await this.reply(message, output, { markdown: true });
  }

  #bindEvents() {
    this.channel.on("message", async (message) => {
      const content = message.content?.trim();
      if (!content) return;

      if (/^\/?(whoami|我的id|我的 open_id)$/i.test(content)) {
        await this.reply(
          message,
          [
            `你的 Feishu open_id：${message.senderId || "-"}`,
            `当前 chat_id：${message.chatId || "-"}`,
            `会话类型：${message.chatType || "-"}`,
          ].join("\n"),
        );
        return;
      }

      if (!isAllowed(message, this.allowedUsers)) {
        if (message.chatType === "p2p") {
          await this.reply(message, "你暂未在 Pi agent 飞书白名单中。");
        }
        return;
      }

      if (message.chatType === "group" && this.requireMention && !message.mentionedBot) {
        return;
      }

      const sessionKey = buildSessionKey(this.bot.id, message);
      const { queued, promise } = this.queue.enqueue(sessionKey, () => this.processMessage(message));
      await this.reply(message, queued ? "已加入队列，前一个任务完成后会继续处理。" : "已收到，正在交给 Pi agent 处理。");
      promise.catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.reply(message, `Pi agent 执行失败：${this.lastError}`).catch((sendError) => {
          this.logger.error("failed to send error reply", sendError);
        });
      });
    });

    this.channel.on("reject", (event) => {
      this.logger.debug("message rejected", event);
    });

    this.channel.on("error", (error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error("channel error", error);
    });

    this.channel.on("reconnecting", () => {
      this.connected = false;
      this.logger.warn("WebSocket reconnecting...");
    });

    this.channel.on("reconnected", () => {
      this.connected = true;
      this.logger.info("WebSocket reconnected.");
    });
  }

  start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.channel
      .connect()
      .then(() => {
        this.connected = true;
        this.logger.info("Pi bridge connected via WebSocket.");
      })
      .catch((error) => {
        this.connected = false;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.logger.error("Pi bridge failed to connect:", error);
      });
    return this.startPromise;
  }

  async stop() {
    await this.startPromise?.catch(() => {});
    await this.channel.disconnect().catch(() => {});
    this.connected = false;
    this.sessionPool.dispose();
  }

  refreshModels() {
    this.sessionPool.refreshModels();
  }

  status() {
    return {
      id: this.bot.id,
      name: this.bot.name,
      enabled: this.bot.enabled !== false,
      connected: this.connected,
      connection: this.channel.getConnectionStatus?.(),
      mappingPath: this.sessionPool.mappingPath,
      requireMention: this.requireMention,
      allowedUsers: [...this.allowedUsers],
      domain: this.bot.domain || "feishu",
      appId: this.bot.appId,
      hasAppSecret: Boolean(this.bot.appSecret),
      readonly: Boolean(this.bot.readonly),
      lastError: this.lastError,
    };
  }
}

function validateBot(bot) {
  if (!bot?.appId || !bot?.appSecret) {
    throw new Error("缺少飞书 App ID 或 App Secret。");
  }
}

export function createFeishuBridgeManager({ cwd, configStore }) {
  const runtimes = new Map();
  let configuredBots = [];
  let ready;

  return {
    get enabled() {
      return configuredBots.length > 0 || Boolean(envFeishuBot());
    },
    async startConfigured() {
      if (ready) return ready;
      ready = (async () => {
        const storedBots = await configStore.getRawBots();
        configuredBots = storedBots.length ? storedBots : [envFeishuBot()].filter(Boolean);
        await Promise.all(
          configuredBots
            .filter((bot) => bot.enabled !== false && bot.autoStart !== false)
            .map((bot) => this.startBot(bot.id, bot)),
        );
      })();
      return ready;
    },
    async reloadBots() {
      const storedBots = await configStore.getRawBots();
      configuredBots = storedBots.length ? storedBots : [envFeishuBot()].filter(Boolean);
      return configuredBots;
    },
    async startBot(id, providedBot) {
      await this.reloadBots();
      const bot = providedBot || configuredBots.find((item) => item.id === id);
      if (!bot) throw new Error("没有找到这个飞书机器人。");
      if (bot.enabled === false) throw new Error("这个机器人已停用。");
      validateBot(bot);

      await runtimes.get(bot.id)?.stop();
      const runtime = new FeishuBotRuntime({ cwd, bot });
      runtimes.set(bot.id, runtime);
      await runtime.start();
      return runtime.status();
    },
    async stopBot(id) {
      const runtime = runtimes.get(id);
      if (!runtime) return;
      await runtime.stop();
      runtimes.delete(id);
    },
    refreshModels() {
      for (const runtime of runtimes.values()) runtime.refreshModels();
    },
    async syncBotChange(id) {
      await this.stopBot(id);
      await this.reloadBots();
      const bot = configuredBots.find((item) => item.id === id);
      if (bot?.enabled !== false && bot?.autoStart !== false) {
        return this.startBot(id, bot);
      }
      return undefined;
    },
    status: () => {
      const envBot = envFeishuBot();
      const known = configuredBots.length ? configuredBots : [envBot].filter(Boolean);
      const botStatuses = known.map((bot) => {
        const runtime = runtimes.get(bot.id);
        return (
          runtime?.status() || {
            id: bot.id,
            name: bot.name,
            enabled: bot.enabled !== false,
            connected: false,
            requireMention: bot.requireMention !== false,
            allowedUsers: splitList(bot.allowedUsers),
            domain: bot.domain || "feishu",
            appId: bot.appId,
            hasAppSecret: Boolean(bot.appSecret),
            readonly: Boolean(bot.readonly),
          }
        );
      });
      return {
        enabled: botStatuses.length > 0,
        connected: botStatuses.some((bot) => bot.connected),
        bots: botStatuses,
      };
    },
    async stop() {
      await Promise.all([...runtimes.keys()].map((id) => this.stopBot(id)));
    },
  };
}
