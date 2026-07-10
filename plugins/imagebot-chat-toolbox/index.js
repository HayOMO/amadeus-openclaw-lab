import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { openclawStatePath } from "../imagebot-shared/openclaw-paths.mjs";

const TOOL_NAME = "chat_toolbox";
const MAX_TEXT = 2000;
const MAX_COUNT = 30;
const DEFAULT_COUNT = 8;

const ACTIONS = [
  "todo_add", "todo_list", "todo_done",
  "note_save", "note_search",
  "faq_add", "faq_search",
  "quote_add", "quote_random",
  "reminder_add", "reminder_due",
  "birthday_add", "birthday_next",
  "event_add", "event_agenda",
  "poll_create", "poll_vote", "poll_results",
  "choice", "roll_dice", "flip_coin", "random_number", "shuffle", "team_split", "draw_lots",
  "rps", "eight_ball",
  "text_stats", "extract_links",
  "bookmark_add", "bookmark_search",
  "countdown",
  "habit_checkin", "habit_status",
  "mood_log", "mood_summary",
  "karma_inc", "karma_leaderboard",
  "seen_set", "seen_get",
  "tell_add", "tell_due",
  "unit_convert", "timezone_convert",
  "glossary_add", "glossary_search",
  "snippet_save", "snippet_search",
  "queue_join", "queue_list"
];

const ACTION_GROUPS = {
  task: ["todo_add", "todo_list", "todo_done"],
  records: [
    "note_save", "note_search",
    "faq_add", "faq_search",
    "quote_add", "quote_random",
    "bookmark_add", "bookmark_search",
    "glossary_add", "glossary_search",
    "snippet_save", "snippet_search"
  ],
  schedule: [
    "reminder_add", "reminder_due",
    "birthday_add", "birthday_next",
    "event_add", "event_agenda",
    "countdown"
  ],
  poll: ["poll_create", "poll_vote", "poll_results"],
  random: ["choice", "roll_dice", "flip_coin", "random_number", "shuffle", "team_split", "draw_lots", "rps", "eight_ball"],
  text: ["text_stats", "extract_links", "unit_convert", "timezone_convert"],
  wellness: ["habit_checkin", "habit_status", "mood_log", "mood_summary"],
  social: ["karma_inc", "karma_leaderboard", "seen_set", "seen_get", "tell_add", "tell_due"],
  queue: ["queue_join", "queue_list"]
};

const GROUP_ACTIONS = Object.keys(ACTION_GROUPS);

const SIMPLE_GROUP_ROUTES = {
  task: {
    add: "todo_add",
    create: "todo_add",
    list: "todo_list",
    done: "todo_done",
    complete: "todo_done"
  },
  poll: {
    create: "poll_create",
    vote: "poll_vote",
    results: "poll_results",
    result: "poll_results"
  },
  queue: {
    join: "queue_join",
    add: "queue_join",
    list: "queue_list"
  }
};

const KIND_GROUP_ROUTES = {
  records: {
    note: { save: "note_save", add: "note_save", search: "note_search", list: "note_search" },
    faq: { add: "faq_add", save: "faq_add", search: "faq_search", list: "faq_search" },
    quote: { add: "quote_add", save: "quote_add", random: "quote_random", get: "quote_random" },
    bookmark: { add: "bookmark_add", save: "bookmark_add", search: "bookmark_search", list: "bookmark_search" },
    glossary: { add: "glossary_add", save: "glossary_add", search: "glossary_search", list: "glossary_search" },
    snippet: { save: "snippet_save", add: "snippet_save", search: "snippet_search", list: "snippet_search" }
  },
  schedule: {
    reminder: { add: "reminder_add", create: "reminder_add", due: "reminder_due", list: "reminder_due" },
    birthday: { add: "birthday_add", create: "birthday_add", next: "birthday_next", list: "birthday_next" },
    event: { add: "event_add", create: "event_add", agenda: "event_agenda", list: "event_agenda" },
    countdown: { run: "countdown", get: "countdown", show: "countdown" }
  },
  random: {
    choice: { run: "choice", choose: "choice", pick: "choice" },
    dice: { run: "roll_dice", roll: "roll_dice" },
    coin: { run: "flip_coin", flip: "flip_coin" },
    number: { run: "random_number", pick: "random_number" },
    shuffle: { run: "shuffle" },
    team: { split: "team_split", run: "team_split" },
    lots: { draw: "draw_lots", run: "draw_lots" },
    rps: { play: "rps", run: "rps" },
    eight_ball: { ask: "eight_ball", run: "eight_ball" }
  },
  text: {
    stats: { run: "text_stats", get: "text_stats" },
    links: { extract: "extract_links", run: "extract_links" },
    unit: { convert: "unit_convert", run: "unit_convert" },
    timezone: { convert: "timezone_convert", run: "timezone_convert" }
  },
  wellness: {
    habit: { checkin: "habit_checkin", status: "habit_status", list: "habit_status" },
    mood: { log: "mood_log", summary: "mood_summary", list: "mood_summary" }
  },
  social: {
    karma: { inc: "karma_inc", add: "karma_inc", leaderboard: "karma_leaderboard", list: "karma_leaderboard" },
    seen: { set: "seen_set", get: "seen_get" },
    tell: { add: "tell_add", due: "tell_due", list: "tell_due" }
  }
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storeRoot(config = {}) {
  const configured = String(config.storeDir || "").trim();
  return path.resolve(configured || openclawStatePath("chat-toolbox"));
}

function statePath(config = {}) {
  return path.join(storeRoot(config), "state.json");
}

const stateLocks = new Map();

async function withStoreLock(config, fn) {
  const key = statePath(config);
  const previous = stateLocks.get(key) || Promise.resolve();
  let release;
  const current = previous
    .catch(() => {})
    .then(() => new Promise((resolve) => {
      release = resolve;
    }));
  stateLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (stateLocks.get(key) === current) stateLocks.delete(key);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function hash(value, len = 12) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function sanitizeText(value) {
  return String(value ?? "")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[telegram-token-redacted]")
    .replace(/https:\/\/api\.telegram\.org\/bot[^\s<>"']+/gi, "https://api.telegram.org/[telegram-token-redacted]")
    .replace(/[A-Za-z]:\\[^\s<>"']+/g, "[local-path-redacted]")
    .replace(/\\\\[^\\\s]+\\[^\s<>"']+/g, "[unc-path-redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip-redacted]")
    .replace(/[A-Za-z0-9_][A-Za-z0-9_-]{63,}/g, "[long-token-redacted]")
    .replace(/\r\n/g, "\n")
    .trim();
}

function clip(value, max = MAX_TEXT) {
  const text = sanitizeText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function readToken(params, ...keys) {
  for (const key of keys) {
    const value = normalizeToken(readString(params, key));
    if (value) return value;
  }
  return "";
}

function readNumber(params, key, fallback, min, max) {
  const raw = isRecord(params) ? params[key] : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function readInteger(params, key, fallback, min, max) {
  return Math.trunc(readNumber(params, key, fallback, min, max));
}

function readArrayStrings(params, key) {
  const raw = isRecord(params) ? params[key] : undefined;
  if (Array.isArray(raw)) return raw.map((item) => clip(item, 200)).filter(Boolean);
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(/\r?\n|,/).map((item) => clip(item, 200)).filter(Boolean);
  }
  return [];
}

function readItems(params) {
  return [
    ...readArrayStrings(params, "items"),
    ...readArrayStrings(params, "options")
  ].filter(Boolean);
}

function readCount(params, fallback = DEFAULT_COUNT) {
  return readInteger(params, "count", fallback, 1, MAX_COUNT);
}

function normalizeScope(value) {
  const scope = String(value || "group").trim().toLowerCase();
  return ["session", "group", "global"].includes(scope) ? scope : "group";
}

function scopeKey(params = {}, ctx = {}) {
  const scope = normalizeScope(readString(params, "scope", "group"));
  if (scope === "global") return { scope, key: "global" };
  if (scope === "session") {
    const sessionKey = readString(params, "sessionKey") || String(ctx.sessionKey || ctx.threadKey || "");
    if (!sessionKey) throw new Error("session scope requires sessionKey");
    return { scope, key: `session:${sessionKey}` };
  }
  const groupKey = readString(params, "groupKey") || String(ctx.chatId || ctx.groupId || "telegram-group");
  return { scope, key: `group:${groupKey}` };
}

function senderId(params = {}, ctx = {}) {
  return readString(params, "userId") || String(ctx.senderId || ctx.userId || "unknown-user");
}

function senderName(params = {}, ctx = {}) {
  return readString(params, "userName") || readString(params, "displayName") || String(ctx.senderName || ctx.displayName || senderId(params, ctx));
}

function defaultState() {
  return {
    version: 1,
    todos: [],
    notes: [],
    faqs: [],
    quotes: [],
    reminders: [],
    birthdays: [],
    events: [],
    polls: [],
    bookmarks: [],
    habits: {},
    moods: [],
    karma: {},
    seen: {},
    tells: [],
    glossary: [],
    snippets: [],
    queues: {},
    updatedAt: ""
  };
}

async function loadState(config = {}) {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(config), "utf8"));
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

async function saveState(config = {}, state) {
  state.version = 1;
  state.updatedAt = nowIso();
  const file = statePath(config);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(temp, file);
}

function ok(lines, details = {}) {
  return {
    content: [{ type: "text", text: ["CHAT_TOOLBOX", ...lines].filter(Boolean).join("\n") }],
    details: { status: "ok", ...details }
  };
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `CHAT_TOOLBOX error: ${clip(message, 500)}` }],
    details: { status: "failed", error: message }
  };
}

function itemId(prefix, seed) {
  return `${prefix}_${hash(`${Date.now()}:${Math.random()}:${seed}`, 10)}`;
}

function scoped(records, params, ctx) {
  const { key } = scopeKey(params, ctx);
  return records.filter((item) => item.key === key || item.scope === "global");
}

function textScore(item, query) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return 1;
  const haystack = JSON.stringify(item).toLowerCase();
  let score = 0;
  for (const term of terms) if (haystack.includes(term)) score += term.length + 1;
  return score;
}

function searchRecords(records, params, ctx) {
  const query = readString(params, "query") || readString(params, "text") || readString(params, "name");
  let selected = scoped(records, params, ctx);
  if (query) {
    selected = selected.map((item) => ({ item, score: textScore(item, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item);
  }
  return selected.slice(0, readCount(params));
}

function formatRecord(item, index = 0) {
  const prefix = index ? `${index}. ` : "";
  const label = item.title || item.name || item.question || item.text || item.url || item.id;
  return `${prefix}${item.id || item.key || "item"} | ${clip(label, 140)}`;
}

function parseTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error("date/time must be ISO-like");
  return new Date(ms).toISOString();
}

function todayKey(offsetMinutes = 0) {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function stablePick(items, seed) {
  if (!items.length) throw new Error("items/options are required");
  const digest = crypto.createHash("sha256").update(String(seed || `${Date.now()}:${Math.random()}`)).digest();
  return items[digest[0] % items.length];
}

function shuffleItems(items, seed = "") {
  const result = [...items];
  let h = crypto.createHash("sha256").update(String(seed || `${Date.now()}:${Math.random()}`)).digest();
  for (let i = result.length - 1; i > 0; i--) {
    if (i >= h.length) h = crypto.createHash("sha256").update(Buffer.concat([h, Buffer.from(String(i))])).digest();
    const j = h[i % h.length] % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function unitConvert(value, from, to) {
  const key = `${from}->${to}`.toLowerCase();
  const table = {
    "cm->m": value / 100,
    "m->cm": value * 100,
    "m->km": value / 1000,
    "km->m": value * 1000,
    "g->kg": value / 1000,
    "kg->g": value * 1000,
    "c->f": value * 9 / 5 + 32,
    "f->c": (value - 32) * 5 / 9,
    "mb->gb": value / 1024,
    "gb->mb": value * 1024
  };
  if (!Object.hasOwn(table, key)) throw new Error("unsupported unit conversion");
  return table[key];
}

function publicPoll(poll) {
  return {
    id: poll.id,
    question: poll.question,
    options: poll.options,
    closed: poll.closed === true,
    votes: Object.fromEntries(Object.entries(poll.votes || {}).map(([user, option]) => [user, option]))
  };
}

function pollCounts(poll) {
  const counts = Object.fromEntries((poll.options || []).map((option) => [option, 0]));
  for (const option of Object.values(poll.votes || {})) counts[option] = (counts[option] || 0) + 1;
  return counts;
}

function exactOrPrefix(records, id) {
  const text = String(id || "").trim();
  return records.find((item) => item.id === text || item.id?.startsWith(text)) || null;
}

function groupCoverage() {
  return Object.values(ACTION_GROUPS).flat();
}

function resolveGroupedAction(group, params = {}) {
  const simple = SIMPLE_GROUP_ROUTES[group];
  if (simple) {
    const op = readToken(params, "op", "mode", "verb", "kind", "type");
    const resolved = simple[op];
    if (resolved) return resolved;
    throw new Error(`${group} action requires op: ${Object.keys(simple).join(", ")}`);
  }

  const byKind = KIND_GROUP_ROUTES[group];
  if (!byKind) throw new Error("unknown action");
  const kind = readToken(params, "kind", "type", "feature");
  const routes = byKind[kind];
  if (!routes) throw new Error(`${group} action requires kind: ${Object.keys(byKind).join(", ")}`);
  const op = readToken(params, "op", "mode", "verb") || "run";
  const resolved = routes[op];
  if (resolved) return resolved;
  throw new Error(`${group}/${kind} requires op: ${Object.keys(routes).join(", ")}`);
}

function resolveAction(params = {}) {
  const requested = normalizeToken(readString(params, "action"));
  if (ACTIONS.includes(requested)) return requested;
  if (GROUP_ACTIONS.includes(requested)) return resolveGroupedAction(requested, params);
  throw new Error("unknown action");
}

async function executeAction(config, params, ctx = {}) {
  return withStoreLock(config, () => executeActionUnlocked(config, params, ctx));
}

async function executeActionUnlocked(config, params, ctx = {}) {
  const requestedAction = normalizeToken(readString(params, "action"));
  const action = resolveAction(params);
  const state = await loadState(config);
  const sk = scopeKey(params, ctx);
  const actorId = senderId(params, ctx);
  const actorName = senderName(params, ctx);
  const tz = Number(config.timezoneOffsetMinutes) || 0;
  let changed = false;

  const addScoped = (bucket, prefix, fields) => {
    const record = { id: itemId(prefix, JSON.stringify(fields)), t: nowIso(), scope: sk.scope, key: sk.key, userId: actorId, userName: actorName, ...fields };
    state[bucket].push(record);
    changed = true;
    return record;
  };

  if (action === "todo_add") {
    const text = clip(readString(params, "text") || readString(params, "title"), 500);
    if (!text) throw new Error("text/title is required");
    const item = addScoped("todos", "todo", { text, done: false });
    await saveState(config, state);
    return ok(["todo added", formatRecord(item)], { action, requestedAction, item });
  }
  if (action === "todo_list") {
    const items = scoped(state.todos, params, ctx).filter((item) => !item.done).slice(0, readCount(params));
    return ok([`todos=${items.length}`, ...items.map(formatRecord)], { action, results: items });
  }
  if (action === "todo_done") {
    const item = exactOrPrefix(scoped(state.todos, params, ctx), readString(params, "id"));
    if (!item) throw new Error("todo id not found");
    item.done = true;
    item.doneAt = nowIso();
    await saveState(config, state);
    return ok(["todo done", formatRecord(item)], { action, item });
  }
  if (action === "note_save") {
    const text = clip(readString(params, "text") || readString(params, "content"), 1000);
    if (!text) throw new Error("text/content is required");
    const item = addScoped("notes", "note", { title: clip(readString(params, "title"), 160), text });
    await saveState(config, state);
    return ok(["note saved", formatRecord(item)], { action, item });
  }
  if (action === "note_search") {
    const results = searchRecords(state.notes, params, ctx);
    return ok([`notes=${results.length}`, ...results.map(formatRecord)], { action, results });
  }
  if (action === "faq_add") {
    const question = clip(readString(params, "question") || readString(params, "title"), 300);
    const answer = clip(readString(params, "answer") || readString(params, "text"), 1000);
    if (!question || !answer) throw new Error("question/title and answer/text are required");
    const item = addScoped("faqs", "faq", { question, answer });
    await saveState(config, state);
    return ok(["faq added", formatRecord(item)], { action, item });
  }
  if (action === "faq_search") {
    const results = searchRecords(state.faqs, params, ctx);
    return ok([`faqs=${results.length}`, ...results.map((item, i) => `${i + 1}. ${item.question} -> ${clip(item.answer, 180)}`)], { action, results });
  }
  if (action === "quote_add") {
    const text = clip(readString(params, "text") || readString(params, "quote"), 800);
    if (!text) throw new Error("text/quote is required");
    const item = addScoped("quotes", "quote", { text, author: clip(readString(params, "author") || readString(params, "name"), 160) });
    await saveState(config, state);
    return ok(["quote added", formatRecord(item)], { action, item });
  }
  if (action === "quote_random") {
    const items = searchRecords(state.quotes, params, ctx);
    if (!items.length) throw new Error("no quotes found");
    const item = stablePick(items, readString(params, "seed"));
    return ok([`${item.text}${item.author ? ` -- ${item.author}` : ""}`], { action, item });
  }
  if (action === "reminder_add") {
    const text = clip(readString(params, "text") || readString(params, "title"), 500);
    const dueAt = parseTime(readString(params, "dueAt") || readString(params, "date"));
    if (!text || !dueAt) throw new Error("text/title and dueAt/date are required");
    const item = addScoped("reminders", "rem", { text, dueAt, done: false });
    await saveState(config, state);
    return ok(["reminder recorded; this tool does not auto-send", formatRecord(item), `dueAt=${dueAt}`], { action, item });
  }
  if (action === "reminder_due") {
    const before = parseTime(readString(params, "before") || new Date().toISOString());
    const results = scoped(state.reminders, params, ctx).filter((item) => !item.done && item.dueAt <= before).slice(0, readCount(params));
    return ok([`due=${results.length}`, ...results.map((item, i) => `${i + 1}. ${item.dueAt} ${item.text}`)], { action, results, before });
  }
  if (action === "birthday_add") {
    const name = clip(readString(params, "name") || readString(params, "target"), 120);
    const date = readString(params, "date");
    if (!name || !/^\d{2}-\d{2}$|^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("name and date YYYY-MM-DD or MM-DD are required");
    const item = addScoped("birthdays", "bday", { name, date: date.slice(-5) });
    await saveState(config, state);
    return ok(["birthday saved", `${item.name}: ${item.date}`], { action, item });
  }
  if (action === "birthday_next") {
    const today = todayKey(tz).slice(5);
    const results = scoped(state.birthdays, params, ctx)
      .map((item) => ({ ...item, rank: item.date >= today ? item.date : `~${item.date}` }))
      .sort((a, b) => a.rank.localeCompare(b.rank))
      .slice(0, readCount(params));
    return ok([`birthdays=${results.length}`, ...results.map((item, i) => `${i + 1}. ${item.name}: ${item.date}`)], { action, results });
  }
  if (action === "event_add") {
    const title = clip(readString(params, "title") || readString(params, "text"), 300);
    const date = parseTime(readString(params, "date") || readString(params, "dueAt"));
    if (!title || !date) throw new Error("title/text and date/dueAt are required");
    const item = addScoped("events", "event", { title, date });
    await saveState(config, state);
    return ok(["event saved", `${item.date} ${item.title}`], { action, item });
  }
  if (action === "event_agenda") {
    const after = parseTime(readString(params, "after") || new Date(0).toISOString());
    const results = scoped(state.events, params, ctx).filter((item) => item.date >= after).sort((a, b) => a.date.localeCompare(b.date)).slice(0, readCount(params));
    return ok([`events=${results.length}`, ...results.map((item, i) => `${i + 1}. ${item.date} ${item.title}`)], { action, results });
  }
  if (action === "poll_create") {
    const question = clip(readString(params, "question") || readString(params, "title"), 300);
    const options = readItems(params).slice(0, 10);
    if (!question || options.length < 2) throw new Error("question/title and at least 2 options are required");
    const item = addScoped("polls", "poll", { question, options, votes: {}, closed: false });
    await saveState(config, state);
    return ok(["poll created", formatRecord(item), `options: ${options.join(" | ")}`], { action, poll: publicPoll(item) });
  }
  if (action === "poll_vote") {
    const poll = exactOrPrefix(scoped(state.polls, params, ctx), readString(params, "id"));
    if (!poll) throw new Error("poll id not found");
    if (poll.closed) throw new Error("poll is closed");
    const option = readString(params, "option") || readString(params, "text");
    const resolved = poll.options.find((item) => item.toLowerCase() === option.toLowerCase()) || poll.options[Number(option) - 1];
    if (!resolved) throw new Error("option not found");
    poll.votes ||= {};
    poll.votes[actorId] = resolved;
    await saveState(config, state);
    return ok(["vote recorded", `${actorName}: ${resolved}`], { action, poll: publicPoll(poll) });
  }
  if (action === "poll_results") {
    const poll = exactOrPrefix(scoped(state.polls, params, ctx), readString(params, "id"));
    if (!poll) throw new Error("poll id not found");
    const counts = pollCounts(poll);
    return ok([poll.question, ...Object.entries(counts).map(([option, count]) => `${option}: ${count}`)], { action, poll: publicPoll(poll), counts });
  }
  if (action === "choice") {
    const item = stablePick(readItems(params), readString(params, "seed"));
    return ok([`choice: ${item}`], { action, choice: item });
  }
  if (action === "roll_dice") {
    const sides = readInteger(params, "sides", 6, 2, 1000);
    const count = readInteger(params, "count", 1, 1, 20);
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
    return ok([`rolls: ${rolls.join(", ")}`, `total: ${rolls.reduce((a, b) => a + b, 0)}`], { action, rolls, sides });
  }
  if (action === "flip_coin") {
    const result = Math.random() < 0.5 ? "heads" : "tails";
    return ok([result], { action, result });
  }
  if (action === "random_number") {
    const min = readInteger(params, "min", 1, -1_000_000, 1_000_000);
    const max = readInteger(params, "max", 100, min, 1_000_000);
    const result = min + Math.floor(Math.random() * (max - min + 1));
    return ok([`${result}`], { action, result, min, max });
  }
  if (action === "shuffle") {
    const result = shuffleItems(readItems(params), readString(params, "seed"));
    return ok(result.map((item, i) => `${i + 1}. ${item}`), { action, result });
  }
  if (action === "team_split") {
    const items = shuffleItems(readItems(params), readString(params, "seed"));
    const teamCount = readInteger(params, "teamCount", readInteger(params, "count", 2, 2, 12), 2, 12);
    const teams = Array.from({ length: teamCount }, () => []);
    items.forEach((item, index) => teams[index % teamCount].push(item));
    return ok(teams.map((team, i) => `team ${i + 1}: ${team.join(", ")}`), { action, teams });
  }
  if (action === "draw_lots") {
    const count = readInteger(params, "count", 1, 1, MAX_COUNT);
    const result = shuffleItems(readItems(params), readString(params, "seed")).slice(0, count);
    return ok(result.map((item, i) => `${i + 1}. ${item}`), { action, result });
  }
  if (action === "rps") {
    const user = readString(params, "choice") || readString(params, "text");
    const bot = stablePick(["rock", "paper", "scissors"], `${Date.now()}:${Math.random()}`);
    const beats = { rock: "scissors", paper: "rock", scissors: "paper" };
    const normalized = { r: "rock", p: "paper", s: "scissors", rock: "rock", paper: "paper", scissors: "scissors" }[user.toLowerCase()];
    if (!normalized) throw new Error("choice must be rock/paper/scissors");
    const result = normalized === bot ? "draw" : beats[normalized] === bot ? "win" : "lose";
    return ok([`you=${normalized} bot=${bot} result=${result}`], { action, user: normalized, bot, result });
  }
  if (action === "eight_ball") {
    const answers = ["yes", "no", "maybe", "ask again later", "very likely", "unlikely", "needs more data", "do it manually first"];
    const answer = stablePick(answers, readString(params, "question") || readString(params, "seed"));
    return ok([answer], { action, answer });
  }
  if (action === "text_stats") {
    const text = readString(params, "text");
    const chars = [...text].length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const lines = text ? text.split(/\r?\n/).length : 0;
    return ok([`chars=${chars}`, `words=${words}`, `lines=${lines}`], { action, chars, words, lines });
  }
  if (action === "extract_links") {
    const links = [...readString(params, "text").matchAll(/https?:\/\/[^\s<>"']+/gi)].map((m) => m[0]).slice(0, readCount(params));
    return ok([`links=${links.length}`, ...links], { action, links });
  }
  if (action === "bookmark_add") {
    const url = readString(params, "url");
    if (!/^https?:\/\//i.test(url)) throw new Error("public http/https url is required");
    const item = addScoped("bookmarks", "bm", { url, title: clip(readString(params, "title") || readString(params, "text"), 200) });
    await saveState(config, state);
    return ok(["bookmark saved", formatRecord(item)], { action, item });
  }
  if (action === "bookmark_search") {
    const results = searchRecords(state.bookmarks, params, ctx);
    return ok([`bookmarks=${results.length}`, ...results.map((item, i) => `${i + 1}. ${item.title || item.url} | ${item.url}`)], { action, results });
  }
  if (action === "countdown") {
    const target = parseTime(readString(params, "date") || readString(params, "dueAt"));
    const ms = Date.parse(target) - Date.now();
    const days = Math.floor(ms / 86_400_000);
    const hours = Math.floor((ms % 86_400_000) / 3_600_000);
    return ok([`target=${target}`, `remaining=${days}d ${hours}h`], { action, target, ms });
  }
  if (action === "habit_checkin") {
    const name = clip(readString(params, "name") || readString(params, "title"), 80);
    if (!name) throw new Error("name/title is required");
    const key = `${sk.key}:${name.toLowerCase()}`;
    const habit = state.habits[key] || { name, scope: sk.scope, key: sk.key, days: [], userId: actorId };
    const day = todayKey(tz);
    if (!habit.days.includes(day)) habit.days.push(day);
    state.habits[key] = habit;
    await saveState(config, state);
    return ok([`${name}: ${habit.days.length} check-in day(s)`], { action, habit });
  }
  if (action === "habit_status") {
    const habits = Object.values(state.habits).filter((item) => item.key === sk.key).slice(0, readCount(params));
    return ok([`habits=${habits.length}`, ...habits.map((item, i) => `${i + 1}. ${item.name}: ${item.days.length}`)], { action, results: habits });
  }
  if (action === "mood_log") {
    const mood = clip(readString(params, "mood") || readString(params, "text"), 80);
    if (!mood) throw new Error("mood/text is required");
    const item = addScoped("moods", "mood", { mood, note: clip(readString(params, "note"), 300) });
    await saveState(config, state);
    return ok(["mood logged", formatRecord(item)], { action, item });
  }
  if (action === "mood_summary") {
    const moods = scoped(state.moods, params, ctx).slice(-readCount(params));
    const counts = {};
    moods.forEach((item) => { counts[item.mood] = (counts[item.mood] || 0) + 1; });
    return ok([`moods=${moods.length}`, ...Object.entries(counts).map(([mood, count]) => `${mood}: ${count}`)], { action, counts, results: moods });
  }
  if (action === "karma_inc") {
    const target = clip(readString(params, "target") || readString(params, "name"), 120);
    if (!target) throw new Error("target/name is required");
    const key = `${sk.key}:${target.toLowerCase()}`;
    const delta = readInteger(params, "delta", 1, -100, 100);
    const record = state.karma[key] || { target, scope: sk.scope, key: sk.key, score: 0 };
    record.score += delta;
    record.updatedAt = nowIso();
    state.karma[key] = record;
    await saveState(config, state);
    return ok([`${record.target}: ${record.score}`], { action, record });
  }
  if (action === "karma_leaderboard") {
    const results = Object.values(state.karma).filter((item) => item.key === sk.key).sort((a, b) => b.score - a.score).slice(0, readCount(params));
    return ok([`karma=${results.length}`, ...results.map((item, i) => `${i + 1}. ${item.target}: ${item.score}`)], { action, results });
  }
  if (action === "seen_set") {
    const target = clip(readString(params, "target") || readString(params, "name") || actorName, 120);
    const key = `${sk.key}:${target.toLowerCase()}`;
    state.seen[key] = { target, scope: sk.scope, key: sk.key, lastSeenAt: nowIso(), note: clip(readString(params, "note") || readString(params, "text"), 300) };
    await saveState(config, state);
    return ok([`seen recorded: ${target}`], { action, item: state.seen[key] });
  }
  if (action === "seen_get") {
    const target = clip(readString(params, "target") || readString(params, "name"), 120);
    const item = state.seen[`${sk.key}:${target.toLowerCase()}`];
    if (!item) throw new Error("seen record not found");
    return ok([`${item.target}: ${item.lastSeenAt}${item.note ? ` | ${item.note}` : ""}`], { action, item });
  }
  if (action === "tell_add") {
    const target = clip(readString(params, "target") || readString(params, "name"), 120);
    const text = clip(readString(params, "text") || readString(params, "message"), 500);
    if (!target || !text) throw new Error("target/name and text/message are required");
    const item = addScoped("tells", "tell", { target, text, delivered: false });
    await saveState(config, state);
    return ok(["tell saved", formatRecord(item)], { action, item });
  }
  if (action === "tell_due") {
    const target = clip(readString(params, "target") || readString(params, "name") || actorName, 120);
    const results = scoped(state.tells, params, ctx).filter((item) => !item.delivered && item.target.toLowerCase() === target.toLowerCase()).slice(0, readCount(params));
    results.forEach((item) => { item.delivered = true; item.deliveredAt = nowIso(); });
    await saveState(config, state);
    return ok([`tells=${results.length}`, ...results.map((item, i) => `${i + 1}. ${item.text}`)], { action, results });
  }
  if (action === "unit_convert") {
    const value = readNumber(params, "value", Number.NaN, -1_000_000_000, 1_000_000_000);
    if (!Number.isFinite(value)) throw new Error("numeric value is required");
    const from = readString(params, "fromUnit") || readString(params, "from");
    const to = readString(params, "toUnit") || readString(params, "to");
    const result = unitConvert(value, from, to);
    return ok([`${value} ${from} = ${Number(result.toFixed(6))} ${to}`], { action, value, from, to, result });
  }
  if (action === "timezone_convert") {
    const date = parseTime(readString(params, "date") || readString(params, "dueAt"));
    const fromOffset = readInteger(params, "fromOffsetMinutes", 0, -14 * 60, 14 * 60);
    const toOffset = readInteger(params, "toOffsetMinutes", tz, -14 * 60, 14 * 60);
    const ms = Date.parse(date) - fromOffset * 60_000 + toOffset * 60_000;
    const result = new Date(ms).toISOString().replace("Z", "");
    return ok([`${date} @${fromOffset}min -> ${result} @${toOffset}min`], { action, result });
  }
  if (action === "glossary_add") {
    const name = clip(readString(params, "name") || readString(params, "term"), 120);
    const text = clip(readString(params, "text") || readString(params, "definition"), 800);
    if (!name || !text) throw new Error("name/term and text/definition are required");
    const item = addScoped("glossary", "term", { name, text });
    await saveState(config, state);
    return ok(["glossary term saved", formatRecord(item)], { action, item });
  }
  if (action === "glossary_search") {
    const results = searchRecords(state.glossary, params, ctx);
    return ok([`terms=${results.length}`, ...results.map((item, i) => `${i + 1}. ${item.name}: ${clip(item.text, 180)}`)], { action, results });
  }
  if (action === "snippet_save") {
    const title = clip(readString(params, "title") || readString(params, "name"), 160);
    const text = clip(readString(params, "text") || readString(params, "content"), 1200);
    if (!title || !text) throw new Error("title/name and text/content are required");
    const item = addScoped("snippets", "snip", { title, text });
    await saveState(config, state);
    return ok(["snippet saved", formatRecord(item)], { action, item });
  }
  if (action === "snippet_search") {
    const results = searchRecords(state.snippets, params, ctx);
    return ok([`snippets=${results.length}`, ...results.map(formatRecord)], { action, results });
  }
  if (action === "queue_join") {
    const name = clip(readString(params, "name") || "default", 120);
    const member = clip(readString(params, "target") || readString(params, "text") || actorName, 160);
    const key = `${sk.key}:${name.toLowerCase()}`;
    const queue = state.queues[key] || { name, scope: sk.scope, key: sk.key, members: [] };
    if (!queue.members.includes(member)) queue.members.push(member);
    state.queues[key] = queue;
    await saveState(config, state);
    return ok([`${name}: ${queue.members.join(", ")}`], { action, queue });
  }
  if (action === "queue_list") {
    const name = clip(readString(params, "name") || "default", 120);
    const queue = state.queues[`${sk.key}:${name.toLowerCase()}`] || { name, members: [] };
    return ok([`${name}: ${queue.members.length}`, ...queue.members.map((item, i) => `${i + 1}. ${item}`)], { action, queue });
  }

  if (changed) await saveState(config, state);
  throw new Error("unhandled action");
}

const chatToolboxTool = {
  name: TOOL_NAME,
  label: "Chat Toolbox",
  description: "Backlog-only grouped Telegram chat utilities for local records, schedules, polls, randomizers, social state, queues, and small text helpers.",
  parameters: {
    type: "object",
    additionalProperties: true,
    properties: {
      action: { type: "string", enum: GROUP_ACTIONS, description: "Grouped action. Legacy concrete action names are accepted internally for backlog traceability." },
      kind: { type: "string", description: "Sub-feature kind, such as note, reminder, dice, karma, or habit." },
      op: { type: "string", description: "Operation within the grouped action, such as add, search, list, vote, due, or status." },
      scope: { type: "string", enum: ["session", "group", "global"], description: "Storage scope. Default group." },
      groupKey: { type: "string", description: "Group key for group scope." },
      sessionKey: { type: "string", description: "Session key for session scope." },
      id: { type: "string", description: "Record id or prefix." },
      text: { type: "string", description: "General text input." },
      title: { type: "string", description: "Title/question/name input." },
      name: { type: "string", description: "Name, term, habit, queue, or target label." },
      target: { type: "string", description: "Target user/item label." },
      query: { type: "string", description: "Search query." },
      question: { type: "string", description: "Question for FAQ/poll/eight_ball." },
      answer: { type: "string", description: "FAQ answer." },
      quote: { type: "string", description: "Quote text." },
      author: { type: "string", description: "Quote author." },
      message: { type: "string", description: "Message content." },
      note: { type: "string", description: "Short note." },
      url: { type: "string", description: "Public bookmark URL." },
      date: { type: "string", description: "ISO-like date/time or birthday date." },
      dueAt: { type: "string", description: "ISO-like due date/time." },
      before: { type: "string", description: "ISO-like cutoff time." },
      after: { type: "string", description: "ISO-like lower bound." },
      items: { type: "array", items: { type: "string" }, description: "List items." },
      options: { type: "array", items: { type: "string" }, description: "Choice/poll options." },
      option: { type: "string", description: "Poll option." },
      choice: { type: "string", description: "Rock/paper/scissors choice." },
      mood: { type: "string", description: "Mood label." },
      value: { type: "number", description: "Numeric value." },
      min: { type: "number", description: "Minimum number." },
      max: { type: "number", description: "Maximum number." },
      count: { type: "number", description: "Count 1-30." },
      sides: { type: "number", description: "Dice sides." },
      teamCount: { type: "number", description: "Number of teams." },
      delta: { type: "number", description: "Karma delta." },
      fromUnit: { type: "string", description: "Source unit." },
      toUnit: { type: "string", description: "Target unit." },
      fromOffsetMinutes: { type: "number", description: "Source timezone offset minutes." },
      toOffsetMinutes: { type: "number", description: "Target timezone offset minutes." },
      seed: { type: "string", description: "Optional deterministic seed for random-like actions." },
      userId: { type: "string", description: "Actor id." },
      userName: { type: "string", description: "Actor display name." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params, _signal, _progress, ctx = {}) {
    try {
      return await executeAction(chatToolboxTool.config || {}, params, ctx);
    } catch (error) {
      return fail(error);
    }
  }
};

export const __testing = {
  ACTIONS,
  ACTION_GROUPS,
  GROUP_ACTIONS,
  defaultState,
  groupCoverage,
  loadState,
  resolveAction,
  scopeKey,
  unitConvert,
  executeAction
};

export default {
  id: "imagebot-chat-toolbox",
  name: "Imagebot Chat Toolbox",
  description: "Local Telegram chat utility toolbox.",
  register(api) {
    chatToolboxTool.config = api.config || {};
    api.registerTool(chatToolboxTool, { name: TOOL_NAME });
  }
};
