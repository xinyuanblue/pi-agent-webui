const els = {
  connection: document.querySelector("#connection"),
  model: document.querySelector("#model"),
  modelSelect: document.querySelector("#model-select"),
  thinking: document.querySelector("#thinking"),
  cwd: document.querySelector("#cwd"),
  status: document.querySelector("#status"),
  statusDot: document.querySelector("#status-dot"),
  session: document.querySelector("#session"),
  sessionList: document.querySelector("#session-list"),
  newSession: document.querySelector("#new-session"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  prompt: document.querySelector("#prompt"),
  behavior: document.querySelector("#behavior"),
  send: document.querySelector("#send"),
  abort: document.querySelector("#abort"),
  clear: document.querySelector("#clear"),
};

let currentAssistant;
let currentThinking;
let currentToolRail;
let currentModelKey;
let currentSessionFile;

function shouldRenderMarkdown(role) {
  return role === "assistant" || role === "system" || role === "error";
}

function isBlank(line) {
  return /^\s*$/.test(line);
}

function isSafeUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function findNextInlineToken(text, from) {
  const positions = ["`", "**", "__", "["]
    .map((token) => text.indexOf(token, from))
    .filter((position) => position >= 0);
  return positions.length ? Math.min(...positions) : text.length;
}

function appendInline(parent, text) {
  let index = 0;

  while (index < text.length) {
    if (text[index] === "\n") {
      parent.append(document.createElement("br"));
      index += 1;
      continue;
    }

    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        const code = document.createElement("code");
        code.textContent = text.slice(index + 1, end);
        parent.append(code);
        index = end + 1;
        continue;
      }
    }

    const strongToken = text.startsWith("**", index) ? "**" : text.startsWith("__", index) ? "__" : "";
    if (strongToken) {
      const end = text.indexOf(strongToken, index + 2);
      if (end > index + 2) {
        const strong = document.createElement("strong");
        appendInline(strong, text.slice(index + 2, end));
        parent.append(strong);
        index = end + 2;
        continue;
      }
    }

    if (text[index] === "[") {
      const labelEnd = text.indexOf("]", index + 1);
      const urlStart = labelEnd >= 0 ? labelEnd + 1 : -1;
      if (urlStart >= 0 && text[urlStart] === "(") {
        const urlEnd = text.indexOf(")", urlStart + 1);
        const url = urlEnd >= 0 ? text.slice(urlStart + 1, urlEnd).trim() : "";
        if (url && isSafeUrl(url)) {
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.rel = "noreferrer";
          if (/^https?:/i.test(url)) anchor.target = "_blank";
          appendInline(anchor, text.slice(index + 1, labelEnd));
          parent.append(anchor);
          index = urlEnd + 1;
          continue;
        }
      }
    }

    const next = findNextInlineToken(text, index + 1);
    parent.append(document.createTextNode(text.slice(index, next)));
    index = next;
  }
}

function appendParagraph(parent, lines) {
  const paragraph = document.createElement("p");
  appendInline(paragraph, lines.join("\n"));
  parent.append(paragraph);
}

function isBlockStart(line) {
  return (
    /^```/.test(line) ||
    /^#{1,4}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line)
  );
}

function renderMarkdown(text) {
  const fragment = document.createDocumentFragment();
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([a-zA-Z0-9_-]+)?\s*$/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;

      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[1]) code.dataset.lang = fence[1];
      code.textContent = codeLines.join("\n");
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      const title = document.createElement(`h${level}`);
      appendInline(title, heading[2].trim());
      fragment.append(title);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = document.createElement("blockquote");
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      appendParagraph(quote, quoteLines);
      fragment.append(quote);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      const list = document.createElement("ul");
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-*+]\s+(.+)$/);
        if (!item) break;
        const li = document.createElement("li");
        appendInline(li, item[1]);
        list.append(li);
        index += 1;
      }
      fragment.append(list);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      const list = document.createElement("ol");
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!item) break;
        const li = document.createElement("li");
        appendInline(li, item[1]);
        list.append(li);
        index += 1;
      }
      fragment.append(list);
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && !isBlank(lines[index]) && !isBlockStart(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    appendParagraph(fragment, paragraphLines);
  }

  if (!fragment.childNodes.length) {
    fragment.append(document.createTextNode(""));
  }

  return fragment;
}

function setBodyText(body, text, markdown = body.dataset.markdown === "true") {
  body.dataset.rawText = text || "";
  body.replaceChildren();
  if (markdown) {
    body.append(renderMarkdown(text));
  } else {
    body.textContent = text || "";
  }
}

function resetMessageView() {
  els.messages.textContent = "";
  currentAssistant = null;
  currentThinking = null;
  currentToolRail = null;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function setStatus(status) {
  const normalized = status || "idle";
  const labels = {
    idle: "空闲",
    running: "运行中",
    retrying: "重试中",
  };
  els.status.textContent = labels[normalized] || normalized;
  els.statusDot.className = `dot ${normalized === "running" ? "running" : "idle"}`;
  els.modelSelect.disabled = normalized === "running";
  els.newSession.disabled = normalized === "running";
  for (const button of els.sessionList.querySelectorAll("button")) {
    button.disabled = normalized === "running";
  }
}

function messageEl(role, text = "") {
  const row = document.createElement("article");
  row.className = `message ${role}`;

  const label = document.createElement("div");
  label.className = "role";
  const roleLabels = {
    user: "你",
    assistant: "Pi",
    system: "系统",
    error: "错误",
  };
  label.textContent = roleLabels[role] || role;

  const body = document.createElement("div");
  const markdown = shouldRenderMarkdown(role);
  body.className = `body ${markdown ? "markdown" : "plain"}`;
  body.dataset.markdown = markdown ? "true" : "false";
  setBodyText(body, text, markdown);

  row.append(label, body);
  els.messages.append(row);
  scrollToBottom();
  return { row, body };
}

function toolEl(name, detail = "") {
  if (!currentToolRail) {
    currentToolRail = document.createElement("div");
    currentToolRail.className = "tool-rail";
    els.messages.append(currentToolRail);
  }

  const item = document.createElement("div");
  item.className = "tool";
  item.textContent = detail ? `${name}: ${detail}` : name;
  currentToolRail.append(item);
  scrollToBottom();
  return item;
}

function compactPath(path) {
  if (!path) return "-";
  if (path.length < 42) return path;
  return `${path.slice(0, 18)}...${path.slice(-21)}`;
}

function renderState(state) {
  const switchedSession = currentSessionFile && state.sessionFile && currentSessionFile !== state.sessionFile;
  currentSessionFile = state.sessionFile;
  currentModelKey = state.model ? `${state.model.provider}/${state.model.id}` : undefined;
  els.model.textContent = state.model ? `${state.model.provider}/${state.model.label}` : "未选择模型";
  if (currentModelKey && els.modelSelect.value !== currentModelKey) {
    els.modelSelect.value = currentModelKey;
  }
  els.thinking.textContent = state.thinkingLevel || "-";
  els.cwd.textContent = compactPath(state.cwd);
  els.cwd.title = state.cwd || "";
  els.session.textContent = state.sessionId ? `会话 ${state.sessionId}` : "暂无会话";
  setStatus(state.isStreaming ? "running" : "idle");

  if (switchedSession || els.messages.children.length === 0) {
    resetMessageView();
    for (const message of state.messages) {
      if (message.text) messageEl(message.role, message.text);
    }
  }
}

function formatSessionTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function renderSessions(payload) {
  const sessions = payload.sessions || [];
  els.sessionList.textContent = "";

  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无历史对话";
    els.sessionList.append(empty);
    return;
  }

  for (const item of sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-item${item.path === payload.current ? " active" : ""}`;
    button.dataset.path = item.path;

    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = item.title || "空白会话";

    const meta = document.createElement("span");
    meta.className = "session-meta";
    meta.textContent = `${item.messageCount} 条 · ${formatSessionTime(item.modified)}`;

    button.append(title, meta);
    els.sessionList.append(button);
  }
}

function appendAssistantDelta(delta) {
  if (!currentAssistant) {
    currentAssistant = messageEl("assistant");
  }
  setBodyText(currentAssistant.body, `${currentAssistant.body.dataset.rawText || ""}${delta}`, true);
  scrollToBottom();
}

function appendThinkingDelta(delta) {
  if (!currentThinking) {
    currentThinking = toolEl("思考");
  }
  currentThinking.textContent += delta;
  scrollToBottom();
}

function renderModels(payload) {
  const models = payload.models || [];
  const current = payload.current || currentModelKey;
  els.modelSelect.textContent = "";

  if (models.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "没有可用模型";
    els.modelSelect.append(option);
    els.modelSelect.disabled = true;
    return;
  }

  const byProvider = new Map();
  for (const model of models) {
    const group = byProvider.get(model.provider) || [];
    group.push(model);
    byProvider.set(model.provider, group);
  }

  for (const [provider, providerModels] of byProvider) {
    const group = document.createElement("optgroup");
    group.label = provider;
    for (const model of providerModels) {
      const option = document.createElement("option");
      option.value = `${model.provider}/${model.id}`;
      option.textContent = model.label || model.name || model.id;
      option.title = `${model.provider}/${model.id}`;
      group.append(option);
    }
    els.modelSelect.append(group);
  }

  if (current) els.modelSelect.value = current;
}

function handleEvent(event) {
  switch (event.type) {
    case "state":
      renderState(event.state);
      break;
    case "models":
      renderModels(event);
      break;
    case "sessions":
      renderSessions(event);
      break;
    case "status":
      setStatus(event.status);
      if (event.status === "running") {
        currentAssistant = null;
        currentThinking = null;
        currentToolRail = null;
      }
      break;
    case "message_start":
      if (event.message.role === "user") {
        messageEl("user", event.message.text);
      }
      if (event.message.role === "assistant") {
        currentAssistant = messageEl("assistant", event.message.text);
      }
      break;
    case "message_end":
      if (event.message.role === "assistant" && currentAssistant) {
        setBodyText(
          currentAssistant.body,
          event.message.text || currentAssistant.body.dataset.rawText || currentAssistant.body.textContent,
          true,
        );
      }
      currentThinking = null;
      break;
    case "assistant_delta":
      appendAssistantDelta(event.delta);
      break;
    case "thinking_delta":
      appendThinkingDelta(event.delta);
      break;
    case "tool_start":
      toolEl(event.toolName, "运行中");
      break;
    case "tool_end":
      toolEl(event.toolName, event.isError ? "失败" : "完成");
      break;
    case "queue":
      if (event.followUp?.length || event.steering?.length) {
        toolEl("队列", `${event.steering.length} 条转向，${event.followUp.length} 条跟进`);
      }
      break;
    case "notice":
      messageEl("system", event.message);
      break;
    case "error":
      messageEl("error", event.message);
      setStatus("idle");
      break;
  }
}

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || response.statusText);
  }
  return response.json();
}

els.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = els.prompt.value.trim();
  if (!text) return;

  els.prompt.value = "";
  els.send.disabled = true;
  try {
    await postJson("/api/prompt", { text, behavior: els.behavior.value });
  } catch (error) {
    messageEl("error", error.message);
  } finally {
    els.send.disabled = false;
    els.prompt.focus();
  }
});

els.modelSelect.addEventListener("change", async () => {
  const value = els.modelSelect.value;
  if (!value || value === currentModelKey) return;

  const [provider, ...idParts] = value.split("/");
  const id = idParts.join("/");
  els.modelSelect.disabled = true;
  try {
    const payload = await postJson("/api/model", { provider, id });
    renderState(payload.state);
    messageEl("system", `已切换模型：${payload.model.provider}/${payload.model.label}`);
  } catch (error) {
    messageEl("error", error.message);
    if (currentModelKey) els.modelSelect.value = currentModelKey;
  } finally {
    els.modelSelect.disabled = false;
  }
});

els.sessionList.addEventListener("click", async (event) => {
  const button = event.target.closest(".session-item");
  if (!button) return;
  const path = button.dataset.path;
  if (!path || path === currentSessionFile) return;

  els.sessionList.querySelectorAll("button").forEach((item) => {
    item.disabled = true;
  });

  try {
    const payload = await postJson("/api/session/switch", { path });
    renderState(payload.state);
    renderSessions(payload.sessions);
  } catch (error) {
    messageEl("error", error.message);
  } finally {
    els.sessionList.querySelectorAll("button").forEach((item) => {
      item.disabled = false;
    });
  }
});

els.newSession.addEventListener("click", async () => {
  els.newSession.disabled = true;
  try {
    const payload = await postJson("/api/session/new");
    renderState(payload.state);
    renderSessions(payload.sessions);
  } catch (error) {
    messageEl("error", error.message);
  } finally {
    els.newSession.disabled = false;
  }
});

els.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    els.composer.requestSubmit();
  }
});

els.abort.addEventListener("click", async () => {
  await postJson("/api/abort").catch((error) => messageEl("error", error.message));
});

els.clear.addEventListener("click", () => {
  resetMessageView();
});

const source = new EventSource("/api/events");
source.onopen = () => {
  els.connection.textContent = "已连接";
};
source.onerror = () => {
  els.connection.textContent = "连接断开";
  setStatus("idle");
};
source.onmessage = (message) => {
  handleEvent(JSON.parse(message.data));
};
