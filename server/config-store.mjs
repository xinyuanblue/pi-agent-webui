import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_MODEL_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function cwdHash(cwd) {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 16);
}

function configPath(cwd) {
  return join(homedir(), ".pi", "agent", "pi-webui", `${cwdHash(cwd)}.json`);
}

function modelsJsonPath() {
  return join(homedir(), ".pi", "agent", "models.json");
}

function stripJsonComments(content) {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (!inString && char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (!inString && char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    output += char;

    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      inString = !inString;
    }
  }

  return output;
}

async function readJsonFile(path, fallback, options = {}) {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(options.stripComments ? stripJsonComments(content) : content);
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFile(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeId(value, fallback) {
  const id = String(value || fallback || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || fallback || randomUUID();
}

function normalizeProviderInput(body, existing) {
  const provider = normalizeId(body.provider || body.id, existing?.provider);
  const models = splitList(body.models).map((id) => ({
    id,
    name: id,
    reasoning: Boolean(body.reasoning),
    input: ["text"],
    cost: DEFAULT_MODEL_COST,
    contextWindow: Number(body.contextWindow || 128000),
    maxTokens: Number(body.maxTokens || 16384),
  }));

  return {
    provider,
    name: String(body.name || existing?.name || provider).trim(),
    baseUrl: String(body.baseUrl || existing?.baseUrl || "").trim(),
    apiKey: String(body.apiKey || "").trim() || existing?.apiKey,
    api: String(body.api || existing?.api || "openai-completions").trim(),
    authHeader: body.authHeader === undefined ? existing?.authHeader : Boolean(body.authHeader),
    models,
  };
}

function sanitizeProvider(providerName, provider) {
  return {
    provider: providerName,
    name: provider.name || providerName,
    baseUrl: provider.baseUrl || "",
    api: provider.api || "openai-completions",
    authHeader: Boolean(provider.authHeader),
    hasApiKey: Boolean(provider.apiKey),
    models: (provider.models || []).map((model) => ({
      id: model.id,
      name: model.name || model.id,
      reasoning: Boolean(model.reasoning),
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  };
}

function normalizeBotInput(body, existing) {
  const id = normalizeId(body.id, existing?.id || `bot-${randomUUID().slice(0, 8)}`);
  return {
    id,
    name: String(body.name || existing?.name || id).trim(),
    appId: String(body.appId || existing?.appId || "").trim(),
    appSecret: String(body.appSecret || "").trim() || existing?.appSecret || "",
    domain: body.domain === "lark" ? "lark" : "feishu",
    allowedUsers: splitList(body.allowedUsers ?? existing?.allowedUsers),
    requireMention: body.requireMention === undefined ? existing?.requireMention !== false : Boolean(body.requireMention),
    enabled: body.enabled === undefined ? existing?.enabled !== false : Boolean(body.enabled),
    autoStart: body.autoStart === undefined ? existing?.autoStart !== false : Boolean(body.autoStart),
  };
}

function sanitizeBot(bot) {
  return {
    id: bot.id,
    name: bot.name,
    appId: bot.appId,
    domain: bot.domain || "feishu",
    allowedUsers: bot.allowedUsers || [],
    requireMention: bot.requireMention !== false,
    enabled: bot.enabled !== false,
    autoStart: bot.autoStart !== false,
    hasAppSecret: Boolean(bot.appSecret),
  };
}

export class ConfigStore {
  constructor({ cwd }) {
    this.cwd = cwd;
    this.configPath = configPath(cwd);
    this.modelsJsonPath = modelsJsonPath();
  }

  async readAppConfig() {
    const config = await readJsonFile(this.configPath, {});
    return {
      version: 1,
      feishuBots: Array.isArray(config.feishuBots) ? config.feishuBots : [],
    };
  }

  async writeAppConfig(config) {
    await writeJsonFile(this.configPath, {
      version: 1,
      feishuBots: Array.isArray(config.feishuBots) ? config.feishuBots : [],
    });
  }

  async readModelsConfig() {
    const config = await readJsonFile(this.modelsJsonPath, { providers: {} }, { stripComments: true });
    return {
      ...config,
      providers: config.providers && typeof config.providers === "object" ? config.providers : {},
    };
  }

  async writeModelsConfig(config) {
    await writeJsonFile(this.modelsJsonPath, {
      ...config,
      providers: config.providers && typeof config.providers === "object" ? config.providers : {},
    });
  }

  async listProviders() {
    const config = await this.readModelsConfig();
    return Object.entries(config.providers).map(([name, provider]) => sanitizeProvider(name, provider));
  }

  async upsertProvider(body) {
    const config = await this.readModelsConfig();
    const requested = normalizeId(body.original || body.provider || body.id, "");
    const existing = requested ? config.providers[requested] : undefined;
    const provider = normalizeProviderInput(body, existing);

    if (!provider.baseUrl) throw new Error("需要填写 Base URL。");
    if (!provider.apiKey) throw new Error("需要填写 API Key。");
    if (!provider.models.length) throw new Error("至少需要填写一个模型 ID。");

    if (requested && requested !== provider.provider) delete config.providers[requested];
    config.providers[provider.provider] = {
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      api: provider.api,
      authHeader: provider.authHeader,
      models: provider.models,
    };
    await this.writeModelsConfig(config);
    return sanitizeProvider(provider.provider, config.providers[provider.provider]);
  }

  async deleteProvider(providerName) {
    const config = await this.readModelsConfig();
    delete config.providers[providerName];
    await this.writeModelsConfig(config);
  }

  async listBots() {
    const config = await this.readAppConfig();
    return config.feishuBots.map(sanitizeBot);
  }

  async getRawBots() {
    const config = await this.readAppConfig();
    return config.feishuBots;
  }

  async upsertBot(body) {
    const config = await this.readAppConfig();
    const requested = normalizeId(body.original || body.id, "");
    const index = requested ? config.feishuBots.findIndex((bot) => bot.id === requested) : -1;
    const existing = index >= 0 ? config.feishuBots[index] : undefined;
    const bot = normalizeBotInput(body, existing);

    if (!bot.appId) throw new Error("需要填写飞书 App ID。");
    if (!bot.appSecret) throw new Error("需要填写飞书 App Secret。");

    if (index >= 0) {
      config.feishuBots[index] = bot;
    } else {
      config.feishuBots.push(bot);
    }
    await this.writeAppConfig(config);
    return sanitizeBot(bot);
  }

  async deleteBot(id) {
    const config = await this.readAppConfig();
    config.feishuBots = config.feishuBots.filter((bot) => bot.id !== id);
    await this.writeAppConfig(config);
  }

  async getBot(id) {
    const config = await this.readAppConfig();
    return config.feishuBots.find((bot) => bot.id === id);
  }

  sanitizeBot(bot) {
    return sanitizeBot(bot);
  }
}

export function envFeishuBot() {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  const enabled = process.env.FEISHU_ENABLED === "true" || Boolean(appId && appSecret);
  if (!enabled || !appId || !appSecret) return undefined;
  return {
    id: "env-default",
    name: "环境变量机器人",
    appId,
    appSecret,
    domain: process.env.FEISHU_DOMAIN === "lark" ? "lark" : "feishu",
    allowedUsers: splitList(process.env.FEISHU_ALLOWED_USERS),
    requireMention: process.env.FEISHU_REQUIRE_MENTION !== "false",
    enabled: true,
    autoStart: true,
    readonly: true,
  };
}
