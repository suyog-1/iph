// Keychat: a keyboard-first Claude chat for iPhone + hardware keyboard/trackpad.
import Anthropic from "@anthropic-ai/sdk";
import { marked } from "marked";
import DOMPurify from "dompurify";

// ---------- constants ----------
// price = [input, output, cache read] in USD per million tokens (used for the rough cost estimate only)
const MODELS = [
  { id: "claude-opus-5-5", name: "Opus 5.5", price: [4, 20, 0.2], fallbacks: true },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", price: [2, 10, 0.2], fallbacks: true },
  { id: "claude-haiku-5-5", name: "Haiku 5.5", price: [0.1, 0.5, 0.01], fallbacks: false },
  { id: "claude-fable-5-1", name: "Fable 5.1", price: [10, 50, 0.25], fallbacks: true },
];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const SPEEDS = [40, 80, 140, 220, 340, 520, 800]; // glide scroll, px per second
const DEFAULTS = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "medium",
  system: "",
  showThinking: true,
  enterSends: true,
  speedIdx: 3,
  theme: "auto",
};
const KEY_SETTINGS = "keychat.settings";
const KEY_CHATS = "keychat.chats";
const KEY_CURRENT = "keychat.current";
const IS_APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const MOD = IS_APPLE ? "⌘" : "Ctrl+";

// ---------- storage ----------
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

// ---------- state ----------
const state = {
  settings: { ...DEFAULTS, ...store.get(KEY_SETTINGS, {}) },
  chats: store.get(KEY_CHATS, []),
  currentId: store.get(KEY_CURRENT, null),
  selected: -1,
  editing: null, // index of the user message being edited
  run: null, // { stream, chatId, msg }
  follow: true, // keep the streaming answer pinned to the bottom until the reader scrolls away
};

// ---------- dom ----------
const $ = (sel) => document.querySelector(sel);
const el = {
  body: document.body,
  scroller: $("#scroller"),
  thread: $("#thread"),
  title: $("#chat-title"),
  input: $("#input"),
  composer: $("#composer"),
  send: $("#send"),
  dock: $("#dock"),
  jump: $("#jump"),
  editBanner: $("#edit-banner"),
  chatList: $("#chat-list"),
  chipMode: $("#chip-mode"),
  chipModel: $("#chip-model"),
  chipEffort: $("#chip-effort"),
  chipSpeed: $("#chip-speed"),
  chipAuto: $("#chip-auto"),
  chipKeys: $("#chip-keys"),
  hints: $("#hints"),
  palette: $("#palette"),
  paletteInput: $("#palette-input"),
  paletteList: $("#palette-list"),
  help: $("#help"),
  helpBody: $("#help-body"),
  settings: $("#settings"),
  settingsForm: $("#settings-form"),
  toast: $("#toast"),
};

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

// ---------- helpers ----------
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const modelInfo = (id) => MODELS.find((m) => m.id === id);
const modelName = (id) => modelInfo(id)?.name ?? id ?? "Claude";
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
// Many iPhone/iPad keyboards have no Esc key, so Ctrl+[ (the classic terminal alias) works too.
const isEsc = (e) => e.key === "Escape" || (e.ctrlKey && !e.metaKey && e.code === "BracketLeft");

function toast(text, ms = 1600) {
  el.toast.textContent = text;
  el.toast.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.toast.classList.remove("show"), ms);
}

function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", { style: "position:fixed;opacity:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// ---------- persistence ----------
function saveSettings() {
  store.set(KEY_SETTINGS, state.settings);
}
function saveChats() {
  const ok = store.set(KEY_CHATS, state.chats) && store.set(KEY_CURRENT, state.currentId);
  if (!ok) toast("Storage is full: delete some old chats", 3000);
}

// ---------- chats ----------
function sortedChats() {
  return [...state.chats].sort((a, b) => b.updated - a.updated);
}
function currentChat() {
  let chat = state.chats.find((c) => c.id === state.currentId);
  if (!chat) {
    chat = sortedChats()[0] ?? makeChat();
    state.currentId = chat.id;
  }
  return chat;
}
function makeChat() {
  const chat = { id: uid(), title: "New chat", created: Date.now(), updated: Date.now(), messages: [] };
  state.chats.push(chat);
  return chat;
}
function newChat() {
  if (state.run) stop();
  // Reuse an existing empty chat instead of piling them up.
  const empty = state.chats.find((c) => !c.messages.length);
  const chat = empty ?? makeChat();
  chat.updated = Date.now();
  openChat(chat.id);
  focusComposer();
}
function openChat(id) {
  if (state.editing != null) cancelEdit();
  // Drop the chat we're leaving if nothing was ever said in it.
  const leaving = state.chats.find((c) => c.id === state.currentId);
  if (leaving && leaving.id !== id && !leaving.messages.length) {
    state.chats = state.chats.filter((c) => c !== leaving);
  }
  state.currentId = id;
  saveChats();
  renderThread();
  renderChatList();
  closeDrawer();
}
function cycleChat(dir) {
  const list = sortedChats();
  if (list.length < 2) return toast("No other chats");
  const i = list.findIndex((c) => c.id === state.currentId);
  const next = list[(i + dir + list.length) % list.length];
  openChat(next.id);
  toast(next.title);
}
function deleteChat(id = state.currentId) {
  const chat = state.chats.find((c) => c.id === id);
  if (!chat) return;
  if (!confirm(`Delete "${chat.title}"?`)) return;
  if (state.run?.chatId === id) stop();
  state.chats = state.chats.filter((c) => c.id !== id);
  if (state.currentId === id) state.currentId = sortedChats()[0]?.id ?? null;
  saveChats();
  renderThread();
  renderChatList();
  toast("Chat deleted");
}
function renameChat() {
  const chat = currentChat();
  const name = prompt("Rename chat", chat.title);
  if (name && name.trim()) {
    chat.title = name.trim().slice(0, 80);
    saveChats();
    el.title.textContent = chat.title;
    renderChatList();
  }
}
function titleFrom(text) {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ");
  return line.length > 48 ? line.slice(0, 47) + "…" : line || "New chat";
}

// ---------- markdown ----------
marked.use({ gfm: true, breaks: false });
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});
function renderMarkdown(target, text) {
  target.innerHTML = DOMPurify.sanitize(marked.parse(text ?? ""));
  for (const pre of target.querySelectorAll("pre")) {
    const wrap = h("div", { class: "code-wrap" });
    pre.replaceWith(wrap);
    wrap.append(pre, h("button", { class: "code-copy", type: "button", "data-act": "copy-code", text: "copy" }));
  }
}

// What we show for a stored assistant message.
function partsOf(content) {
  if (typeof content === "string") return { text: content, thinking: "", fallbacks: [] };
  let text = "";
  let thinking = "";
  const fallbacks = [];
  for (const b of content ?? []) {
    if (b.type === "text") text += b.text;
    else if (b.type === "thinking" && b.thinking) thinking += (thinking ? "\n\n" : "") + b.thinking;
    else if (b.type === "fallback") fallbacks.push(b);
  }
  return { text, thinking, fallbacks };
}

// ---------- rendering ----------
function renderThread() {
  const chat = currentChat();
  state.selected = -1;
  el.title.textContent = chat.title;
  el.thread.replaceChildren();
  if (!state.settings.apiKey) el.thread.append(welcomeCard());
  else if (!chat.messages.length) el.thread.append(emptyState());
  chat.messages.forEach((m, i) => el.thread.append(renderMessage(m, i)));
  if (state.run?.chatId === chat.id) state.run.el = el.thread.querySelector(`.msg[data-i="${chat.messages.indexOf(state.run.msg)}"]`);
  requestAnimationFrame(() => {
    pinToBottom();
    updateJump();
  });
}

function renderMessage(m, i) {
  const isUser = m.role === "user";
  const actions = h("div", { class: "msg-actions" },
    h("button", { type: "button", "data-act": "copy", title: "Copy (y)", text: "copy" }),
    isUser
      ? h("button", { type: "button", "data-act": "edit", title: "Edit (e)", text: "edit" })
      : h("button", { type: "button", "data-act": "regen", title: "Regenerate (r)", text: "retry" }),
  );
  const head = h("div", { class: "msg-head" },
    h("span", { class: "who", text: isUser ? "you" : modelName(m.model).toLowerCase() }),
    !isUser && m.effort ? h("span", { text: m.effort }) : null,
    actions,
  );
  const node = h("article", { class: `msg ${m.role}`, "data-i": i }, head);
  if (isUser) {
    node.append(h("div", { class: "msg-body", text: m.content }));
  } else {
    node.append(
      h("details", { class: "thinking", hidden: true }, h("summary", { text: "Thought" }), h("div", { class: "thinking-body" })),
      h("div", { class: "msg-body md" }),
      h("div", { class: "msg-notes" }),
      h("div", { class: "msg-meta" }),
    );
    paintAssistant(node, m);
  }
  return node;
}

function paintAssistant(node, m, live) {
  const { text, thinking, fallbacks } = live ?? partsOf(m.content);
  const streaming = Boolean(live);
  const det = node.querySelector(".thinking");
  const sum = det.querySelector("summary");
  const body = node.querySelector(".msg-body");

  det.hidden = !thinking && !(streaming && !text);
  det.querySelector(".thinking-body").textContent = thinking;
  if (streaming && !text) {
    sum.textContent = "Thinking…";
    sum.className = "pulse";
  } else {
    sum.className = "";
    sum.textContent = m.thoughtMs ? `Thought for ${Math.max(1, Math.round(m.thoughtMs / 1000))}s` : "Thought";
  }

  renderMarkdown(body, text);
  body.classList.toggle("caret", streaming);

  const notes = node.querySelector(".msg-notes");
  notes.replaceChildren(
    ...fallbacks.map((f) => h("div", { class: "note", text: `${modelName(f.from?.model)} declined, so ${modelName(f.to?.model)} continued.` })),
  );
  if (m.refused) notes.append(h("div", { class: "note err", text: `Claude declined this request${typeof m.refused === "string" ? ` (${m.refused})` : ""}. It's left out of the conversation history. Try rephrasing.` }));
  if (m.error) notes.append(h("div", { class: "note err", text: m.error }));
  if (m.partial) notes.append(h("div", { class: "note", text: "Stopped early. Press r to regenerate." }));
  if (m.stop === "max_tokens") notes.append(h("div", { class: "note", text: "Hit the output limit. Ask it to continue." }));

  const meta = node.querySelector(".msg-meta");
  meta.textContent = "";
  if (m.usage) {
    const u = m.usage;
    const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const parts = [`${fmtTokens(inTok)} in`, `${fmtTokens(u.output_tokens ?? 0)} out`];
    const cost = estimateCost(m.model, u);
    if (cost != null) parts.push(`≈$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`);
    meta.textContent = parts.join(" · ");
  }
  const who = node.querySelector(".who");
  if (who && m.model) who.textContent = modelName(m.model).toLowerCase();
}

function estimateCost(model, u) {
  const info = modelInfo(model);
  if (!info || !u) return null;
  const [pin, pout, pread] = info.price;
  const input = (u.input_tokens ?? 0) * pin + (u.cache_creation_input_tokens ?? 0) * pin * 1.25 + (u.cache_read_input_tokens ?? 0) * pread;
  return (input + (u.output_tokens ?? 0) * pout) / 1e6;
}

function keysGrid(rows) {
  return h("div", { class: "keys-grid" }, rows.flatMap(([k, d]) => [h("span", {}, ...kbds(k)), h("span", { text: d })]));
}
function kbds(spec) {
  return spec.split(" ").map((k) => (k === "/" || k === "…" ? ` ${k} ` : h("kbd", { text: k })));
}

function welcomeCard() {
  const input = h("input", { type: "password", placeholder: "sk-ant-…", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": "API key" });
  const save = () => {
    const key = input.value.trim();
    if (!key) return input.focus();
    state.settings.apiKey = key;
    saveSettings();
    renderThread();
    focusComposer();
    toast("Key saved on this device");
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
  });
  requestAnimationFrame(() => input.focus());
  return h("div", { class: "card" },
    h("h1", { text: "Keychat" }),
    h("p", { text: "A Claude chat built for an iPhone with a keyboard and trackpad. Paste your Anthropic API key to start. It stays in this browser on this device." }),
    h("div", { class: "row" }, input, h("button", { class: "btn", type: "button", onclick: save, text: "Save" })),
    keysGrid([
      [`${MOD}K`, "command palette: models, chats, actions"],
      ["Esc", "READ mode: scroll and navigate with keys"],
      ["↑ ↓", "hold to glide-scroll slowly"],
      ["?", "every shortcut"],
    ]),
  );
}

function emptyState() {
  return h("div", { class: "empty" },
    h("div", { class: "big", text: `Ask ${modelName(state.settings.model)} anything` }),
    keysGrid([
      ["↵", "send"],
      ["Esc", "READ mode (j/k, ↑↓ glide)"],
      [`${MOD}K`, "commands"],
      ["?", "shortcuts"],
    ]),
  );
}

function renderChatList() {
  const list = sortedChats().filter((c) => c.messages.length || c.id === state.currentId);
  el.chatList.replaceChildren(
    ...list.map((c) =>
      h("button", { class: `chat-item${c.id === state.currentId ? " current" : ""}`, type: "button", "data-id": c.id },
        h("span", { class: "t", text: c.title }),
        h("span", { class: "d", text: `${relTime(c.updated)} · ${c.messages.length} msg` }),
      ),
    ),
  );
}

function renderStatus() {
  const s = state.settings;
  el.chipModel.textContent = modelName(s.model);
  el.chipEffort.textContent = s.effort;
  el.chipSpeed.textContent = `⇅ ${s.speedIdx + 1}`;
  el.chipKeys.textContent = `${MOD}K`;
  el.body.classList.toggle("hide-thinking", !s.showThinking);
  document.documentElement.dataset.theme = s.theme === "auto" ? "" : s.theme;
  if (s.theme === "auto") delete document.documentElement.dataset.theme;
  renderMode();
}

function isTyping() {
  return document.activeElement === el.input;
}
function renderMode() {
  const typing = isTyping();
  el.body.classList.toggle("mode-type", typing);
  el.body.classList.toggle("mode-read", !typing);
  el.chipMode.textContent = typing ? "TYPE" : "READ";
  el.hints.textContent = typing
    ? `${state.settings.enterSends ? "↵ send · ⇧↵ newline" : `${MOD}↵ send`} · esc read · ${MOD}. stop`
    : "j/k msgs · ↑↓ glide · space page · s auto · i type · ? keys";
  el.send.disabled = !state.run && !el.input.value.trim();
}

// ---------- scrolling engine ----------
// One rAF loop handles held-arrow glide and teleprompter auto-scroll, easing velocity in and out.
const motion = { hold: 0, fast: false, auto: false, v: 0, acc: 0, last: 0, raf: 0 };
const speed = () => SPEEDS[state.settings.speedIdx];

function motionStep(t) {
  const dt = Math.min(0.05, (t - motion.last) / 1000);
  motion.last = t;
  const target = motion.hold ? motion.hold * speed() * (motion.fast ? 3 : 1) : motion.auto ? speed() * 0.6 : 0;
  motion.v += (target - motion.v) * Math.min(1, dt * 9);
  motion.acc += motion.v * dt;
  const whole = Math.trunc(motion.acc);
  if (whole) {
    el.scroller.scrollTop += whole;
    motion.acc -= whole;
  }
  const atBottom = el.scroller.scrollTop + el.scroller.clientHeight >= el.scroller.scrollHeight - 1;
  if (motion.auto && atBottom && !state.run && !motion.hold) setAuto(false);
  if (target === 0 && Math.abs(motion.v) < 2) {
    motion.v = 0;
    motion.acc = 0;
    motion.raf = 0;
    updateJump();
    return;
  }
  motion.raf = requestAnimationFrame(motionStep);
}
function kickMotion() {
  if (motion.raf) return;
  motion.last = performance.now();
  motion.raf = requestAnimationFrame(motionStep);
}
function startHold(dir, fast) {
  if (dir < 0) state.follow = false;
  motion.hold = dir;
  motion.fast = fast;
  kickMotion();
}
function endHold() {
  motion.hold = 0;
}
function setAuto(on) {
  motion.auto = on;
  el.chipAuto.hidden = !on;
  if (on) kickMotion();
}
function setSpeed(delta) {
  state.settings.speedIdx = clamp(state.settings.speedIdx + delta, 0, SPEEDS.length - 1);
  saveSettings();
  renderStatus();
  toast(`Scroll speed ${state.settings.speedIdx + 1}/${SPEEDS.length}`);
}
function page(fraction) {
  if (fraction < 0) state.follow = false;
  el.scroller.scrollBy({ top: el.scroller.clientHeight * fraction, behavior: "smooth" });
}
function scrollToTop() {
  state.follow = false;
  el.scroller.scrollTo({ top: 0, behavior: "smooth" });
}
function scrollToBottom(smooth = true) {
  state.follow = true;
  if (motion.auto) setAuto(false);
  el.scroller.scrollTo({ top: el.scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}
let lastTop = 0;
function pinToBottom() {
  el.scroller.scrollTop = el.scroller.scrollHeight;
  lastTop = el.scroller.scrollTop;
}
// Scrolling up (by any means) stops following; coming back down to the bottom resumes it.
function onScroll() {
  const top = el.scroller.scrollTop;
  if (top < lastTop - 1) state.follow = false;
  else if (top > lastTop && nearBottom()) state.follow = true;
  lastTop = top;
  if (!motion.raf) updateJump();
}
function nearBottom() {
  return el.scroller.scrollHeight - el.scroller.scrollTop - el.scroller.clientHeight < 60;
}
function updateJump() {
  el.jump.hidden = nearBottom() || !state.run;
}

// ---------- message selection ----------
const msgEls = () => [...el.thread.querySelectorAll(".msg")];
function anchorIndex() {
  const top = el.scroller.scrollTop;
  const els = msgEls();
  for (let i = 0; i < els.length; i++) {
    if (els[i].offsetTop + els[i].offsetHeight > top + 24) return i;
  }
  return els.length - 1;
}
function select(i, scroll = true) {
  const els = msgEls();
  if (!els.length) return;
  state.selected = clamp(i, 0, els.length - 1);
  els.forEach((n, j) => n.classList.toggle("sel", j === state.selected));
  if (scroll) {
    state.follow = false;
    const node = els[state.selected];
    el.scroller.scrollTo({ top: Math.max(0, node.offsetTop - 10), behavior: "smooth" });
  }
}
function moveSelection(dir) {
  const els = msgEls();
  if (!els.length) return;
  if (state.selected < 0 || state.selected >= els.length) {
    const a = anchorIndex();
    const partlyAbove = els[a].offsetTop < el.scroller.scrollTop - 4;
    select(dir > 0 ? (partlyAbove ? a + 1 : a) : partlyAbove ? a : a - 1);
  } else {
    select(state.selected + dir);
  }
}
function clearSelection() {
  state.selected = -1;
  msgEls().forEach((n) => n.classList.remove("sel"));
}
function selectedMessage() {
  const chat = currentChat();
  if (state.selected >= 0) return { m: chat.messages[state.selected], i: state.selected };
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    if (chat.messages[i].role === "assistant") return { m: chat.messages[i], i };
  }
  return { m: null, i: -1 };
}
function messageText(m) {
  return m.role === "user" ? m.content : partsOf(m.content).text;
}

// ---------- actions ----------
async function copySelected() {
  const { m } = selectedMessage();
  if (!m) return toast("Nothing to copy");
  await copyText(messageText(m));
  toast("Copied message");
}
async function copyCode() {
  const { i } = selectedMessage();
  const node = msgEls()[i];
  const blocks = node ? [...node.querySelectorAll("pre code")] : [];
  if (!blocks.length) return toast("No code block in that message");
  await copyText(blocks[blocks.length - 1].textContent);
  toast(blocks.length > 1 ? "Copied the last code block" : "Copied code");
}
async function copyChat() {
  const chat = currentChat();
  const md = chat.messages
    .map((m) => `## ${m.role === "user" ? "You" : `Claude (${modelName(m.model)})`}\n\n${messageText(m)}`)
    .join("\n\n");
  await copyText(`# ${chat.title}\n\n${md}\n`);
  toast("Copied chat as Markdown");
}
function toggleThinkingOf() {
  const { i } = selectedMessage();
  const det = msgEls()[i]?.querySelector(".thinking");
  if (!det || det.hidden) return toast("No thinking on that message");
  det.open = !det.open;
}
function setModel(id) {
  state.settings.model = id;
  saveSettings();
  renderStatus();
  toast(`Model: ${modelName(id)}`);
}
function cycleModel(dir) {
  const i = MODELS.findIndex((m) => m.id === state.settings.model);
  setModel(MODELS[(i + dir + MODELS.length) % MODELS.length].id);
}
function setEffort(effort) {
  state.settings.effort = effort;
  saveSettings();
  renderStatus();
  toast(`Thinking effort: ${effort}`);
}
function cycleEffort(dir) {
  const i = EFFORTS.indexOf(state.settings.effort);
  setEffort(EFFORTS[(i + dir + EFFORTS.length) % EFFORTS.length]);
}
function toggleThinking() {
  state.settings.showThinking = !state.settings.showThinking;
  saveSettings();
  renderStatus();
  toast(state.settings.showThinking ? "Thinking shown" : "Thinking hidden");
}

function focusComposer() {
  el.input.focus({ preventScroll: true });
  const n = el.input.value.length;
  el.input.setSelectionRange(n, n);
  renderMode();
}
function enterRead() {
  el.input.blur();
  el.scroller.focus({ preventScroll: true });
  renderMode();
}

function startEdit(i) {
  const chat = currentChat();
  if (state.run) return toast(`Still answering: ${MOD}. to stop`);
  if (i < 0 || chat.messages[i]?.role !== "user") {
    i = chat.messages.findLastIndex((m) => m.role === "user");
  }
  if (i < 0) return toast("No message to edit");
  state.editing = i;
  el.input.value = chat.messages[i].content;
  el.editBanner.hidden = false;
  autosize();
  select(i);
  focusComposer();
}
function cancelEdit() {
  state.editing = null;
  el.editBanner.hidden = true;
  el.input.value = "";
  autosize();
  renderMode();
}

function regenerate() {
  const chat = currentChat();
  if (state.run) return toast(`Still answering: ${MOD}. to stop`);
  if (chat.messages.at(-1)?.role === "assistant") chat.messages.pop();
  if (chat.messages.at(-1)?.role !== "user") return toast("Nothing to regenerate");
  saveChats();
  renderThread();
  respond(chat);
}

function stop() {
  if (!state.run) return;
  state.run.stream.abort();
  toast("Stopped");
}

// ---------- Claude ----------
// Thinking blocks from before a mid-output fallback can't be replayed; text and everything after it can.
function echoable(content) {
  if (typeof content === "string") return content;
  const cut = content.findLastIndex((b) => b.type === "fallback");
  if (cut < 0) return content;
  return [...content.slice(0, cut).filter((b) => b.type === "text"), ...content.slice(cut + 1)];
}

function apiMessages(chat, upTo) {
  const out = [];
  for (const m of chat.messages.slice(0, upTo)) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    if (m.refused || m.error || m.pending) continue;
    const content = echoable(m.content);
    const hasText = typeof content === "string" ? content.trim() : content.some((b) => b.type !== "text" || b.text.trim());
    if (hasText) out.push({ role: "assistant", content });
  }
  return out;
}

function describeError(err) {
  const detail = err?.error?.error?.message ?? err?.message ?? String(err);
  if (err instanceof Anthropic.AuthenticationError) return "That API key was rejected. Press , to open Settings and check it.";
  if (err instanceof Anthropic.PermissionDeniedError) return `Permission denied: ${detail}`;
  if (err instanceof Anthropic.NotFoundError) return `Not found (is this model enabled for your key?): ${detail}`;
  if (err instanceof Anthropic.RateLimitError) return "Rate limited. Wait a moment, then press r to retry.";
  if (err instanceof Anthropic.BadRequestError) return `Request rejected: ${detail}`;
  if (err instanceof Anthropic.InternalServerError) return `Anthropic is having trouble (${err.status}). Press r to retry.`;
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach api.anthropic.com. Check your connection, then press r to retry.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${detail}`;
  return detail;
}

function buildParams(chat, model, effort) {
  const params = {
    model,
    max_tokens: 64000,
    messages: apiMessages(chat, chat.messages.length - 1),
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort },
    cache_control: { type: "ephemeral" },
  };
  if (state.settings.system.trim()) params.system = state.settings.system.trim();
  // Server-side refusal fallback: if a safety classifier declines, the API retries on Anthropic's recommended model.
  if (modelInfo(model)?.fallbacks) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  return params;
}

async function respond(chat) {
  const { model, effort, apiKey } = state.settings;
  const msg = { role: "assistant", content: [], model, effort, ts: Date.now(), pending: true };
  chat.messages.push(msg);
  const idx = chat.messages.length - 1;
  const node = renderMessage(msg, idx);
  el.thread.querySelector(".empty")?.remove();
  el.thread.append(node);
  state.follow = true;
  pinToBottom();

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const live = { text: "", thinking: "", fallbacks: [] };
  const stream = client.beta.messages.stream(buildParams(chat, model, effort));
  state.run = { stream, chatId: chat.id, msg, el: node };
  el.body.classList.add("busy");
  renderMode();

  const started = performance.now();
  let painted = 0;
  let pending = false;
  const paint = () => {
    pending = false;
    painted = performance.now();
    const target = state.run?.el;
    if (!target?.isConnected) return;
    paintAssistant(target, msg, live);
    if (state.follow && !motion.hold && !motion.auto) pinToBottom();
    updateJump();
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    const wait = Math.max(0, 60 - (performance.now() - painted));
    setTimeout(() => requestAnimationFrame(paint), wait);
  };

  try {
    for await (const ev of stream) {
      if (ev.type === "message_start") {
        msg.model = ev.message.model;
      } else if (ev.type === "content_block_start" && ev.content_block.type === "fallback") {
        live.fallbacks.push(ev.content_block);
      } else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") {
          if (!live.text && msg.thoughtMs == null) msg.thoughtMs = performance.now() - started;
          live.text += ev.delta.text;
        } else if (ev.delta.type === "thinking_delta") {
          live.thinking += ev.delta.thinking;
        }
      }
      schedule();
    }
    const final = await stream.finalMessage();
    msg.content = final.content;
    msg.model = final.model;
    msg.usage = final.usage;
    msg.stop = final.stop_reason;
    if (final.stop_reason === "refusal") msg.refused = final.stop_details?.category || true;
  } catch (err) {
    // Keep whatever text already arrived so the reader doesn't lose it.
    msg.content = live.text ? [{ type: "text", text: live.text }] : [];
    if (err instanceof Anthropic.APIUserAbortError || stream.aborted) msg.partial = true;
    else msg.error = describeError(err);
  } finally {
    delete msg.pending;
    if (msg.thoughtMs == null && live.thinking) msg.thoughtMs = performance.now() - started;
    state.run = null;
    el.body.classList.remove("busy");
    chat.updated = Date.now();
    saveChats();
    renderChatList();
    const target = el.thread.querySelector(`.msg[data-i="${idx}"]`);
    if (target && state.currentId === chat.id) {
      paintAssistant(target, msg);
      if (state.follow && !motion.hold && !motion.auto) pinToBottom();
    }
    updateJump();
    renderMode();
  }
}

function submit() {
  const text = el.input.value.trim();
  if (!text) return;
  if (state.run) return toast(`Still answering: ${MOD}. to stop`);
  if (!state.settings.apiKey) {
    openSettings();
    return toast("Add your API key first");
  }
  const chat = currentChat();
  if (state.editing != null) {
    chat.messages.splice(state.editing);
    state.editing = null;
    el.editBanner.hidden = true;
    renderThread();
  }
  chat.messages.push({ role: "user", content: text, ts: Date.now() });
  if (chat.title === "New chat") {
    chat.title = titleFrom(text);
    el.title.textContent = chat.title;
  }
  chat.updated = Date.now();
  el.input.value = "";
  autosize();
  el.thread.querySelector(".empty")?.remove();
  el.thread.append(renderMessage(chat.messages.at(-1), chat.messages.length - 1));
  clearSelection();
  saveChats();
  renderChatList();
  respond(chat);
}

// ---------- overlays: palette ----------
const pal = { mode: "all", items: [], shown: [], idx: 0, back: null };

function paletteItems(mode) {
  const s = state.settings;
  const items = [];
  const act = (label, hint, run) => items.push({ group: "action", label, hint, run });
  if (mode === "all") {
    act("New chat", "n", newChat);
    act("Switch chat…", `${MOD}J`, () => openPalette("chats"));
    act(state.run ? "Stop generating" : "Regenerate last reply", state.run ? `${MOD}.` : "r", () => (state.run ? stop() : regenerate()));
    act("Edit last message", "e", () => startEdit(-1));
    act("Copy last reply", "y", copySelected);
    act("Copy last code block", "Y", copyCode);
    act("Copy chat as Markdown", "", copyChat);
    act(s.showThinking ? "Hide thinking" : "Show thinking", "v", toggleThinking);
    act(motion.auto ? "Stop auto-scroll" : "Start auto-scroll (teleprompter)", "s", () => setAuto(!motion.auto));
    act("Scroll faster", "=", () => setSpeed(1));
    act("Scroll slower", "−", () => setSpeed(-1));
    act("Toggle chat list", "b", toggleDrawer);
    act("Rename chat", "", renameChat);
    act("Delete chat", "", () => deleteChat());
    act("Settings", ",", openSettings);
    act("Keyboard shortcuts", "?", openHelp);
    MODELS.forEach((m, i) =>
      items.push({ group: "model", label: m.name, hint: m.id === s.model ? "● current" : String(i + 1), run: () => setModel(m.id) }),
    );
    EFFORTS.forEach((e) =>
      items.push({ group: "effort", label: `${e} thinking`, hint: e === s.effort ? "● current" : "", run: () => setEffort(e) }),
    );
  }
  for (const c of sortedChats()) {
    if (!c.messages.length) continue;
    items.push({ group: "chat", label: c.title, hint: c.id === state.currentId ? "● open" : relTime(c.updated), run: () => openChat(c.id) });
  }
  return items;
}

function fuzzyScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  const at = s.indexOf(q);
  if (at >= 0) return 1000 - at;
  let si = 0;
  let score = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const f = s.indexOf(ch, si);
    if (f < 0) return 0;
    score += f === si ? 3 : 1;
    si = f + 1;
  }
  return score;
}

function renderPalette() {
  const q = el.paletteInput.value.trim();
  pal.shown = pal.items
    .map((it) => ({ it, score: fuzzyScore(q, `${it.group} ${it.label}`) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.it);
  if (!q) pal.shown = pal.items;
  pal.idx = clamp(pal.idx, 0, Math.max(0, pal.shown.length - 1));
  el.paletteList.replaceChildren(
    ...(pal.shown.length
      ? pal.shown.map((it, i) =>
          h("li", { class: i === pal.idx ? "on" : "", role: "option", "data-i": i, "aria-selected": i === pal.idx ? "true" : "false" },
            h("span", { class: "g", text: it.group }),
            h("span", { class: "l", text: it.label }),
            it.hint ? h("span", { class: "h", text: it.hint }) : null,
          ),
        )
      : [h("li", { class: "none", text: "No matches" })]),
  );
  el.paletteList.querySelector("li.on")?.scrollIntoView({ block: "nearest" });
}

function openPalette(mode = "all", query = "") {
  if (!el.palette.hidden && pal.mode === mode) return closePalette();
  pal.back = isTyping() ? el.input : el.scroller;
  closeOverlays();
  pal.mode = mode;
  pal.items = paletteItems(mode);
  pal.idx = mode === "chats" ? Math.min(1, pal.items.length - 1) : 0; // in the chat switcher, start on the previous chat
  el.paletteInput.value = query;
  el.paletteInput.placeholder = mode === "chats" ? "Switch to chat…" : "Type a command, model, or chat…";
  el.palette.hidden = false;
  renderPalette();
  el.paletteInput.focus();
}
function closePalette(restore = true) {
  el.palette.hidden = true;
  if (restore) (pal.back ?? el.scroller).focus({ preventScroll: true });
  renderMode();
}
function runPalette(i = pal.idx) {
  const it = pal.shown[i];
  if (!it) return;
  closePalette();
  it.run();
}
function paletteKey(e) {
  const k = e.key;
  const ctrl = e.ctrlKey && !e.metaKey;
  if (k === "ArrowDown" || (k === "Tab" && !e.shiftKey) || (ctrl && e.code === "KeyN") || (ctrl && e.code === "KeyJ" && pal.mode === "all")) {
    pal.idx = (pal.idx + 1) % Math.max(1, pal.shown.length);
  } else if (k === "ArrowUp" || (k === "Tab" && e.shiftKey) || (ctrl && e.code === "KeyP")) {
    pal.idx = (pal.idx - 1 + pal.shown.length) % Math.max(1, pal.shown.length);
  } else if (pal.mode === "chats" && (e.metaKey || e.ctrlKey) && e.code === "KeyJ") {
    pal.idx = (pal.idx + 1) % Math.max(1, pal.shown.length); // tap ⌘J again to move down, like an app switcher
  } else if (k === "PageDown") {
    pal.idx = clamp(pal.idx + 8, 0, pal.shown.length - 1);
  } else if (k === "PageUp") {
    pal.idx = clamp(pal.idx - 8, 0, pal.shown.length - 1);
  } else if (k === "Enter") {
    e.preventDefault();
    return runPalette();
  } else if (isEsc(e) || ((e.metaKey || e.ctrlKey) && e.code === "KeyK")) {
    e.preventDefault();
    return closePalette();
  } else {
    return;
  }
  e.preventDefault();
  renderPalette();
}

// ---------- overlays: help ----------
const SHORTCUTS = [
  ["Anywhere", [
    [`${MOD}K`, "Command palette: every action, model, effort and chat"],
    [`${MOD}J`, "Switch chat (press again to move down)"],
    [`${MOD}⇧O`, "New chat"],
    [`${MOD}.`, "Stop generating"],
    [`${MOD}⇧S`, "Show / hide chat list"],
    [`${MOD}/`, "This help"],
    [`${MOD},`, "Settings"],
    ["⌥↑ ⌥↓", "Previous / next chat"],
    ["⌃1 … ⌃4", "Pick model (Opus, Sonnet, Haiku, Fable)"],
  ]],
  ["Typing (TYPE mode)", [
    ["↵", "Send (setting: or ⌘↵)"],
    ["⇧↵", "New line"],
    ["Esc", "Leave the composer for READ mode"],
    ["↑", "On an empty composer: jump up to the last message"],
  ]],
  ["Reading (READ mode)", [
    ["↓ ↑", "Hold to glide-scroll smoothly (add ⇧ for 3× speed)"],
    ["Space ⇧Space", "Page down / up"],
    ["d u", "Half page down / up"],
    ["g G", "Top / bottom (also Home / End)"],
    ["j k", "Next / previous message"],
    ["s", "Auto-scroll on/off (teleprompter)"],
    ["− =", "Slower / faster scrolling"],
    ["y", "Copy selected message (or last reply)"],
    ["Y", "Copy its last code block"],
    ["o", "Open / close its thinking"],
    ["e", "Edit selected (or last) message"],
    ["r", "Regenerate last reply"],
    ["i / ↵", "Back to typing"],
    ["n", "New chat"],
    ["[ ]", "Previous / next chat"],
    ["b", "Chat list (then ↑↓ and ↵)"],
    ["m M", "Next / previous model"],
    ["1 2 3 4", "Pick model directly"],
    ["t T", "More / less thinking effort"],
    ["v", "Show / hide thinking summaries"],
    ["Esc", "Stop generating, or clear the selection"],
    ["⌃[", "Same as Esc (for keyboards without one)"],
    [", ?", "Settings · this help"],
  ]],
];

function renderHelp() {
  el.helpBody.replaceChildren(
    ...SHORTCUTS.flatMap(([title, rows]) => [
      h("h3", { text: title }),
      h("dl", {}, rows.flatMap(([k, d]) => [h("dt", {}, ...kbds(k)), h("dd", { text: d })])),
    ]),
  );
}
function openHelp() {
  pal.back = isTyping() ? el.input : el.scroller;
  closeOverlays();
  renderHelp();
  el.help.hidden = false;
  el.helpBody.focus({ preventScroll: true });
}

// ---------- overlays: settings ----------
function openSettings() {
  pal.back = isTyping() ? el.input : el.scroller;
  closeOverlays();
  const f = el.settingsForm;
  const s = state.settings;
  f.model.replaceChildren(...MODELS.map((m) => h("option", { value: m.id, text: `${m.name}  (${m.id})` })));
  f.effort.replaceChildren(...EFFORTS.map((e) => h("option", { value: e, text: e })));
  f.apiKey.value = s.apiKey;
  f.apiKey.type = "password";
  $("#toggle-key").textContent = "Show";
  f.model.value = s.model;
  f.effort.value = s.effort;
  f.system.value = s.system;
  f.speedIdx.value = s.speedIdx;
  f.theme.value = s.theme;
  f.enterSends.checked = s.enterSends;
  f.showThinking.checked = s.showThinking;
  el.settings.hidden = false;
  (s.apiKey ? f.model : f.apiKey).focus();
}
function readSettingsForm() {
  const f = el.settingsForm;
  const hadKey = Boolean(state.settings.apiKey);
  Object.assign(state.settings, {
    apiKey: f.apiKey.value.trim(),
    model: f.model.value,
    effort: f.effort.value,
    system: f.system.value,
    speedIdx: Number(f.speedIdx.value),
    theme: f.theme.value,
    enterSends: f.enterSends.checked,
    showThinking: f.showThinking.checked,
  });
  saveSettings();
  renderStatus();
  if (hadKey !== Boolean(state.settings.apiKey)) renderThread();
}

function closeOverlays() {
  el.palette.hidden = true;
  el.help.hidden = true;
  el.settings.hidden = true;
}
function overlayOpen() {
  return !el.palette.hidden || !el.help.hidden || !el.settings.hidden;
}
function closeOverlay() {
  closeOverlays();
  (pal.back ?? el.scroller).focus({ preventScroll: true });
  renderMode();
}

// ---------- drawer ----------
const wide = () => window.matchMedia("(min-width: 960px)").matches;
function toggleDrawer() {
  if (wide()) {
    el.body.classList.toggle("drawer-collapsed");
    if (!el.body.classList.contains("drawer-collapsed")) focusChatList();
    return;
  }
  el.body.classList.contains("drawer-open") ? closeDrawer(true) : openDrawer();
}
function openDrawer() {
  renderChatList();
  el.body.classList.add("drawer-open");
  focusChatList();
}
function closeDrawer(restore = false) {
  if (!el.body.classList.contains("drawer-open")) return;
  el.body.classList.remove("drawer-open");
  if (restore) el.scroller.focus({ preventScroll: true });
}
function focusChatList() {
  const items = [...el.chatList.querySelectorAll(".chat-item")];
  (items.find((n) => n.classList.contains("current")) ?? items[0])?.focus();
}
el.chatList.addEventListener("keydown", (e) => {
  const items = [...el.chatList.querySelectorAll(".chat-item")];
  const i = items.indexOf(document.activeElement);
  if (i < 0) return;
  const go = (j) => { e.preventDefault(); items[clamp(j, 0, items.length - 1)].focus(); };
  if (e.key === "ArrowDown" || e.key === "j") go(i + 1);
  else if (e.key === "ArrowUp" || e.key === "k") go(i - 1);
  else if (e.key === "Home" || e.key === "g") go(0);
  else if (e.key === "End" || e.key === "G") go(items.length - 1);
  else if (e.key === "Delete" || e.key === "Backspace" || e.key === "x") { e.preventDefault(); deleteChat(items[i].dataset.id); focusChatList(); }
  else if (isEsc(e) || e.key === "b") { e.preventDefault(); wide() ? el.scroller.focus() : closeDrawer(true); renderMode(); }
  else return;
  e.stopPropagation();
});
el.chatList.addEventListener("click", (e) => {
  const item = e.target.closest(".chat-item");
  if (item) openChat(item.dataset.id);
});

// ---------- keyboard ----------
function onKeyDown(e) {
  if (e.isComposing || e.keyCode === 229) return;
  const mod = e.metaKey || e.ctrlKey;
  const code = e.code;

  // Overlays get first dibs.
  if (!el.palette.hidden) return paletteKey(e);
  if (overlayOpen()) {
    if (isEsc(e) || (mod && code === "Slash") || (!el.help.hidden && e.key === "?") || (mod && code === "Comma" && !el.settings.hidden)) {
      e.preventDefault();
      closeOverlay();
    } else if (mod && code === "KeyK") {
      e.preventDefault();
      openPalette();
    }
    return;
  }

  // Global shortcuts (Cmd on Apple keyboards, Ctrl elsewhere).
  if (mod && !e.altKey) {
    if (code === "KeyK") return prevent(e, () => openPalette("all"));
    if (code === "KeyJ") return prevent(e, () => openPalette("chats"));
    if (code === "KeyO" && e.shiftKey) return prevent(e, newChat);
    if (code === "KeyS" && e.shiftKey) return prevent(e, toggleDrawer);
    if (code === "Period") return prevent(e, stop);
    if (code === "Slash") return prevent(e, openHelp);
    if (code === "Comma") return prevent(e, openSettings);
    if (e.ctrlKey && !e.metaKey && /^Digit[1-4]$/.test(code)) return prevent(e, () => setModel(MODELS[Number(code.slice(5)) - 1].id));
    if (code === "Enter" && isTyping()) return prevent(e, submit);
  }
  if (e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    return prevent(e, () => cycleChat(e.key === "ArrowUp" ? -1 : 1));
  }

  if (isTyping()) return composerKey(e);
  if (e.target.closest?.("#drawer")) return;
  const tag = document.activeElement?.tagName;
  if ((tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") && document.activeElement !== el.input) return;
  if (tag === "BUTTON" && (e.key === "Enter" || e.key === " ")) return;
  readKey(e);
}

function prevent(e, fn) {
  e.preventDefault();
  e.stopPropagation();
  fn();
}

function composerKey(e) {
  if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && state.settings.enterSends) {
    return prevent(e, submit);
  }
  if (isEsc(e)) {
    if (state.editing != null) return prevent(e, cancelEdit);
    return prevent(e, enterRead);
  }
  if (e.key === "ArrowUp" && !el.input.value && !e.shiftKey && !mod(e)) {
    return prevent(e, () => {
      enterRead();
      select(msgEls().length - 1);
    });
  }
}
const mod = (e) => e.metaKey || e.ctrlKey;

function readKey(e) {
  const run = (fn) => prevent(e, fn);
  if (isEsc(e)) {
    return run(() => {
      if (state.run) stop();
      else if (motion.auto) setAuto(false);
      else clearSelection();
    });
  }
  if (mod(e)) return;
  const k = e.key;

  // Continuous glide while the arrow is held; repeats just keep it alive.
  if (k === "ArrowDown" || k === "ArrowUp") {
    if (e.altKey) return;
    if (motion.auto) setAuto(false);
    return run(() => startHold(k === "ArrowDown" ? 1 : -1, e.shiftKey));
  }
  if (e.altKey) return;
  if (e.repeat && !"jkdu ".includes(k) && k !== "PageDown" && k !== "PageUp") return;

  switch (k) {
    case " ": return run(() => page(e.shiftKey ? -0.85 : 0.85));
    case "PageDown": return run(() => page(0.85));
    case "PageUp": return run(() => page(-0.85));
    case "d": return run(() => page(0.5));
    case "u": return run(() => page(-0.5));
    case "g": case "Home": return run(scrollToTop);
    case "G": case "End": return run(() => scrollToBottom());
    case "j": return run(() => moveSelection(1));
    case "k": return run(() => moveSelection(-1));
    case "s": return run(() => setAuto(!motion.auto));
    case "-": case "_": return run(() => setSpeed(-1));
    case "=": case "+": return run(() => setSpeed(1));
    case "y": return run(copySelected);
    case "Y": return run(copyCode);
    case "o": return run(toggleThinkingOf);
    case "e": return run(() => startEdit(state.selected));
    case "r": return run(regenerate);
    case "i": case "a": case "Enter": case "/": return run(focusComposer);
    case "n": return run(newChat);
    case "[": return run(() => cycleChat(-1));
    case "]": return run(() => cycleChat(1));
    case "b": return run(toggleDrawer);
    case "m": return run(() => cycleModel(1));
    case "M": return run(() => cycleModel(-1));
    case "1": case "2": case "3": case "4": return run(() => setModel(MODELS[Number(k) - 1].id));
    case "t": return run(() => cycleEffort(1));
    case "T": return run(() => cycleEffort(-1));
    case "v": return run(toggleThinking);
    case ",": return run(openSettings);
    case "?": return run(openHelp);
  }
}

function onKeyUp(e) {
  if ((e.key === "ArrowDown" && motion.hold > 0) || (e.key === "ArrowUp" && motion.hold < 0)) endHold();
  if (e.key === "Shift") motion.fast = false;
}

// ---------- wiring ----------
function autosize() {
  el.input.style.height = "auto";
  el.input.style.height = `${el.input.scrollHeight}px`;
  renderMode();
}

// iOS: size the app to the visual viewport so the composer stays above the on-screen keyboard.
function fitViewport() {
  const vv = window.visualViewport;
  document.documentElement.style.setProperty("--app-h", `${vv ? vv.height : window.innerHeight}px`);
  document.documentElement.style.setProperty("--dock-h", `${el.dock.offsetHeight}px`);
  if (window.scrollY) window.scrollTo(0, 0);
}

function wire() {
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", () => { endHold(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { endHold(); setAuto(false); } });
  document.addEventListener("focusin", renderMode);
  document.addEventListener("focusout", () => setTimeout(renderMode, 0));

  el.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    state.run ? stop() : submit();
  });
  el.input.addEventListener("input", autosize);

  el.scroller.addEventListener("scroll", onScroll, { passive: true });
  el.scroller.addEventListener("wheel", () => motion.auto && setAuto(false), { passive: true });
  el.scroller.addEventListener("touchstart", () => motion.auto && setAuto(false), { passive: true });
  el.jump.addEventListener("click", () => scrollToBottom());

  el.thread.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    const node = e.target.closest(".msg");
    if (btn?.dataset.act === "copy-code") {
      await copyText(btn.parentElement.querySelector("code")?.textContent ?? "");
      btn.textContent = "copied";
      setTimeout(() => (btn.textContent = "copy"), 1200);
      return;
    }
    if (!node) return;
    const i = Number(node.dataset.i);
    select(i, false);
    if (btn?.dataset.act === "copy") copySelected();
    else if (btn?.dataset.act === "edit") startEdit(i);
    else if (btn?.dataset.act === "regen") regenerate();
  });

  $("#btn-drawer").addEventListener("click", toggleDrawer);
  $("#scrim").addEventListener("click", () => closeDrawer(true));
  $("#btn-new").addEventListener("click", newChat);
  $("#btn-new-2").addEventListener("click", newChat);
  $("#btn-palette").addEventListener("click", () => openPalette("all"));
  $("#btn-settings").addEventListener("click", () => { closeDrawer(); openSettings(); });
  $("#btn-help").addEventListener("click", () => { closeDrawer(); openHelp(); });
  el.chipMode.addEventListener("click", () => (isTyping() ? enterRead() : focusComposer()));
  // Status chips shouldn't steal focus from the composer when clicked.
  for (const chip of document.querySelectorAll("#statusbar .chip")) chip.addEventListener("mousedown", (e) => e.preventDefault());
  el.chipModel.addEventListener("click", () => cycleModel(1));
  el.chipEffort.addEventListener("click", () => cycleEffort(1));
  el.chipSpeed.addEventListener("click", () => setSpeed(state.settings.speedIdx === SPEEDS.length - 1 ? -SPEEDS.length : 1));
  el.chipKeys.addEventListener("click", () => openPalette("all"));

  el.paletteInput.addEventListener("input", () => { pal.idx = 0; renderPalette(); });
  el.paletteList.addEventListener("mousemove", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li && Number(li.dataset.i) !== pal.idx) { pal.idx = Number(li.dataset.i); renderPalette(); }
  });
  el.paletteList.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) runPalette(Number(li.dataset.i));
  });
  for (const ov of [el.palette, el.help, el.settings]) {
    ov.addEventListener("click", (e) => {
      if (e.target === ov || e.target.closest("[data-close]")) closeOverlay();
    });
  }

  el.settingsForm.addEventListener("input", readSettingsForm);
  el.settingsForm.addEventListener("change", readSettingsForm);
  el.settingsForm.addEventListener("submit", (e) => { e.preventDefault(); closeOverlay(); });
  $("#toggle-key").addEventListener("click", (e) => {
    const f = el.settingsForm.apiKey;
    f.type = f.type === "password" ? "text" : "password";
    e.target.textContent = f.type === "password" ? "Show" : "Hide";
  });
  $("#btn-clear-all").addEventListener("click", () => {
    if (!confirm("Delete every chat on this device?")) return;
    if (state.run) stop();
    state.chats = [];
    state.currentId = null;
    saveChats();
    renderThread();
    renderChatList();
    toast("All chats deleted");
  });

  window.visualViewport?.addEventListener("resize", fitViewport);
  window.visualViewport?.addEventListener("scroll", fitViewport);
  window.addEventListener("resize", fitViewport);
  new ResizeObserver(fitViewport).observe(el.dock);
}

// ---------- boot ----------
wire();
fitViewport();
renderStatus();
renderThread();
renderChatList();
if (state.settings.apiKey) focusComposer();
