import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { openclawStatePath } from "../imagebot-shared/openclaw-paths.mjs";

const TOOL_NAME = "group_adventure";
const MAX_TEXT = 6000;
const MAX_HISTORY = 180;
const MAX_INVENTORY = 24;

const DEFAULT_WORLD = {
  id: "d20_fantasy",
  label: "D20 Fantasy",
  style: "Dungeons & Dragons style taverns, ruins, dungeons, roads, minor curses, and suspiciously specific loot.",
  classes: [
    { id: "fighter", name: "Fighter", role: "front-line martial", mod: 3, maxHp: 14, hpGain: 7, trait: "steady blade work" },
    { id: "rogue", name: "Rogue", role: "lock, trap, and bad idea specialist", mod: 3, maxHp: 10, hpGain: 5, trait: "unfairly quiet footsteps" },
    { id: "wizard", name: "Wizard", role: "arcane problem amplifier", mod: 4, maxHp: 8, hpGain: 4, trait: "very confident spell margins" },
    { id: "cleric", name: "Cleric", role: "field medic with divine complaints", mod: 3, maxHp: 12, hpGain: 6, trait: "practical miracles" },
    { id: "ranger", name: "Ranger", role: "wilderness scout", mod: 3, maxHp: 12, hpGain: 6, trait: "tracks that should not be visible" },
    { id: "bard", name: "Bard", role: "social hazard with a lute", mod: 3, maxHp: 10, hpGain: 5, trait: "weaponized confidence" }
  ],
  backgrounds: [
    "failed apprentice",
    "tavern regular",
    "minor noble in denial",
    "map thief",
    "temple errand-runner",
    "wandering scholar",
    "caravan guard",
    "curse paperwork survivor"
  ],
  encounters: [
    { id: "goblin_toll_bridge", title: "Goblin Toll Bridge", dc: 12, xp: 24, gold: 8, risk: 3, tag: "road" },
    { id: "kobold_candle_mine", title: "Kobold Candle Mine", dc: 13, xp: 28, gold: 10, risk: 4, tag: "mine" },
    { id: "haunted_cellar", title: "Haunted Cellar Under The Inn", dc: 12, xp: 26, gold: 6, risk: 4, tag: "undead" },
    { id: "owlbear_tracks", title: "Fresh Owlbear Tracks", dc: 15, xp: 38, gold: 12, risk: 6, tag: "wilds" },
    { id: "wizard_tax_audit", title: "Wizard Tower Tax Audit", dc: 14, xp: 34, gold: 16, risk: 3, tag: "arcane" },
    { id: "mimic_market_stall", title: "Mimic Market Stall", dc: 15, xp: 42, gold: 18, risk: 5, tag: "town" },
    { id: "sunken_shrine", title: "Sunken Shrine Steps", dc: 16, xp: 46, gold: 20, risk: 6, tag: "ruin" },
    { id: "bandit_recipe_book", title: "Bandits Protecting A Recipe Book", dc: 13, xp: 30, gold: 14, risk: 4, tag: "road" },
    { id: "sleeping_dragon_errand", title: "Errand Near A Sleeping Dragon", dc: 18, xp: 70, gold: 38, risk: 9, tag: "dragon" },
    { id: "library_golem", title: "Library Golem With Overdue Notices", dc: 14, xp: 36, gold: 11, risk: 4, tag: "library" }
  ],
  loot: [
    "potion of reasonable healing",
    "silvered dagger with questionable initials",
    "map fragment to a louder problem",
    "ring of dramatic timing",
    "spell scroll with coffee stains",
    "boots that refuse mud",
    "lucky copper d20",
    "minor cloak of not being noticed",
    "tin badge from an adventurer guild",
    "gemstone that hums near bad decisions"
  ],
  complications: [
    "a debt marker from a tavern appears in the backpack",
    "the local rats now recognize the party",
    "one boot smells faintly of necromancy",
    "a guild clerk requests three impossible receipts",
    "a bard already wrote the wrong version of the story",
    "the dungeon door remembers their face"
  ]
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function readNumber(params, key, fallback, min, max) {
  const raw = isRecord(params) ? params[key] : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function readObject(params, key) {
  const value = isRecord(params) ? params[key] : undefined;
  return isRecord(value) ? value : {};
}

function clip(value, max = 600) {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function hash(value, len = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function seededUnit(seed) {
  const value = parseInt(hash(seed, 12), 16);
  return value / 0xffffffffffff;
}

function seededPick(list, seed, fallback = null) {
  const values = Array.isArray(list) ? list.filter((item) => item !== undefined && item !== null) : [];
  if (!values.length) return fallback;
  const index = Math.floor(seededUnit(seed) * values.length) % values.length;
  return values[index];
}

function safeId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").slice(0, 80);
}

function normalizedIdentity(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("tg:") ? raw : `tg:${raw}`;
}

function storeRoot(config = {}) {
  const configured = String(config.storeDir || "").trim();
  return path.resolve(configured || openclawStatePath("group-adventure"));
}

function statePath(config = {}) {
  return path.join(storeRoot(config), "state.json");
}

function dateKey(config = {}, date = new Date()) {
  const offset = Number.isFinite(Number(config.timezoneOffsetMinutes)) ? Number(config.timezoneOffsetMinutes) : 480;
  const shifted = new Date(date.getTime() + offset * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${hash(Math.random(), 8)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, filePath);
}

function worldConfig(config = {}) {
  const world = isRecord(config.world) ? config.world : {};
  return {
    ...DEFAULT_WORLD,
    ...world,
    classes: Array.isArray(world.classes) && world.classes.length ? world.classes : DEFAULT_WORLD.classes,
    backgrounds: Array.isArray(world.backgrounds) && world.backgrounds.length ? world.backgrounds : DEFAULT_WORLD.backgrounds,
    encounters: Array.isArray(world.encounters) && world.encounters.length ? world.encounters : DEFAULT_WORLD.encounters,
    loot: Array.isArray(world.loot) && world.loot.length ? world.loot : DEFAULT_WORLD.loot,
    complications: Array.isArray(world.complications) && world.complications.length ? world.complications : DEFAULT_WORLD.complications
  };
}

function readIdentity(params = {}) {
  const user = readObject(params, "user");
  const chat = readObject(params, "chat");
  return {
    userId: normalizedIdentity(readString(params, "userId") || readString(user, "id") || readString(user, "userId")),
    userName: readString(params, "userName") || readString(user, "username") || readString(user, "userName"),
    displayName: readString(params, "displayName") || readString(user, "displayName") || readString(user, "name"),
    chatId: readString(params, "chatId") || readString(chat, "id") || readString(chat, "chatId"),
    chatTitle: readString(params, "chatTitle") || readString(chat, "title") || readString(chat, "name")
  };
}

function emptyState() {
  return { version: 1, users: {}, days: {}, events: [] };
}

function normalizeState(state) {
  const next = isRecord(state) ? state : emptyState();
  next.version = 1;
  next.users = isRecord(next.users) ? next.users : {};
  next.days = isRecord(next.days) ? next.days : {};
  next.events = Array.isArray(next.events) ? next.events : [];
  return next;
}

function nextLevelXp(level) {
  return 120 + Math.max(0, Number(level || 1) - 1) * 90;
}

function classById(world, id) {
  const key = safeId(id);
  return world.classes.find((item) => safeId(item.id || item.name) === key) || world.classes[0] || DEFAULT_WORLD.classes[0];
}

function createAdventurer(identity, world) {
  const userId = normalizedIdentity(identity.userId);
  const cls = seededPick(world.classes, `class:${userId}`, world.classes[0]);
  const background = seededPick(world.backgrounds, `background:${userId}`, "wanderer");
  const maxHp = Math.max(6, Number(cls.maxHp || 10) + Math.floor(seededUnit(`hp:${userId}`) * 4));
  return {
    userId,
    userName: identity.userName || "",
    displayName: identity.displayName || identity.userName || userId,
    classId: safeId(cls.id || cls.name),
    className: String(cls.name || cls.id || "Adventurer"),
    role: String(cls.role || ""),
    trait: String(cls.trait || ""),
    background: String(background),
    level: 1,
    xp: 0,
    xpToNext: nextLevelXp(1),
    gold: 0,
    hp: maxHp,
    maxHp,
    renown: 0,
    totalAdventures: 0,
    successes: 0,
    failures: 0,
    criticalSuccesses: 0,
    criticalFailures: 0,
    inventory: [],
    chatIds: [],
    history: []
  };
}

function publicAdventurer(record) {
  if (!isRecord(record)) return null;
  return {
    userId: record.userId || "",
    userName: record.userName || "",
    displayName: record.displayName || record.userName || record.userId || "",
    classId: record.classId || "",
    className: record.className || "",
    role: record.role || "",
    trait: record.trait || "",
    background: record.background || "",
    level: Number(record.level || 1),
    xp: Number(record.xp || 0),
    xpToNext: Number(record.xpToNext || nextLevelXp(record.level || 1)),
    gold: Number(record.gold || 0),
    hp: Number(record.hp || 0),
    maxHp: Number(record.maxHp || 0),
    renown: Number(record.renown || 0),
    totalAdventures: Number(record.totalAdventures || 0),
    successes: Number(record.successes || 0),
    failures: Number(record.failures || 0),
    criticalSuccesses: Number(record.criticalSuccesses || 0),
    criticalFailures: Number(record.criticalFailures || 0),
    inventory: Array.isArray(record.inventory) ? record.inventory.slice(0, MAX_INVENTORY) : [],
    lastDate: record.lastDate || "",
    lastOutcome: record.lastAdventure?.outcome || "",
    lastEncounter: record.lastAdventure?.encounter?.title || ""
  };
}

function rankUsers(users) {
  return [...users].filter(isRecord).map(publicAdventurer).filter(Boolean)
    .sort((a, b) =>
      b.level - a.level ||
      b.xp - a.xp ||
      b.renown - a.renown ||
      b.gold - a.gold ||
      b.totalAdventures - a.totalAdventures ||
      String(a.displayName).localeCompare(String(b.displayName))
    );
}

function d20(seed) {
  return 1 + Math.floor(seededUnit(seed) * 20);
}

function outcomeFor({ roll, total, dc }) {
  if (roll === 20) return "critical_success";
  if (roll === 1) return "critical_failure";
  if (total >= dc + 5) return "strong_success";
  if (total >= dc) return "success";
  if (total >= dc - 3) return "mixed";
  return "failure";
}

function rewardMultiplier(outcome) {
  if (outcome === "critical_success") return { xp: 1.7, gold: 1.8, hp: 0, renown: 4 };
  if (outcome === "strong_success") return { xp: 1.25, gold: 1.25, hp: 1, renown: 3 };
  if (outcome === "success") return { xp: 1, gold: 1, hp: -1, renown: 2 };
  if (outcome === "mixed") return { xp: 0.65, gold: 0.45, hp: -0.55, renown: 1 };
  if (outcome === "critical_failure") return { xp: 0.2, gold: 0, hp: -1.45, renown: 0 };
  return { xp: 0.35, gold: 0, hp: -1, renown: 0 };
}

function applyLevelUps(user, classData) {
  const levels = [];
  user.xpToNext = Number(user.xpToNext || nextLevelXp(user.level || 1));
  while (user.level < 20 && user.xp >= user.xpToNext) {
    const before = user.level;
    user.level += 1;
    const hpGain = Math.max(3, Number(classData.hpGain || 5));
    user.maxHp += hpGain;
    user.hp = user.maxHp;
    user.xpToNext += nextLevelXp(user.level);
    levels.push({ from: before, to: user.level, hpGain });
  }
  return levels;
}

function formatAdventureText(result) {
  const user = result.user;
  const adv = result.adventure;
  const lines = [
    `${user.displayName} adventure report`,
    `world: ${result.world.label} | ${user.className} Lv.${user.level} (${user.background})`,
    `encounter: ${adv.encounter.title} | DC ${adv.dc}`,
    `roll: d20=${adv.roll} + bonus ${adv.bonus} => ${adv.total} | outcome: ${adv.outcome}`,
    `gain: +${adv.xpGained} XP, +${adv.goldGained} gold, renown +${adv.renownGained}`,
    `HP: ${adv.hpBefore} -> ${user.hp}/${user.maxHp}`,
    adv.loot ? `loot: ${adv.loot}` : "",
    adv.complication ? `complication: ${adv.complication}` : "",
    adv.levelUps.length ? `level up: ${adv.levelUps.map((item) => `${item.from}->${item.to}`).join(", ")}` : "",
    result.alreadyAdventured ? "note: this is today's already recorded run." : ""
  ];
  return lines.filter(Boolean).join("\n");
}

function formatProfileText(user) {
  if (!user) return "No adventurer profile yet. Run group_adventure action=adventure first.";
  return [
    `${user.displayName} character sheet`,
    `${user.className} Lv.${user.level} | ${user.background}`,
    `role: ${user.role || "adventurer"} | trait: ${user.trait || "unknown"}`,
    `HP ${user.hp}/${user.maxHp} | XP ${user.xp}/${user.xpToNext} | gold ${user.gold} | renown ${user.renown}`,
    `adventures ${user.totalAdventures} | success ${user.successes} | failure ${user.failures}`,
    user.inventory.length ? `inventory: ${user.inventory.join(", ")}` : "inventory: empty"
  ].join("\n");
}

function formatPartyText(users, title = "adventuring party") {
  if (!users.length) return `${title}: no adventurers yet.`;
  return [
    `${title}: ${users.length}`,
    ...users.map((user, index) => `${index + 1}. ${user.displayName}: Lv.${user.level} ${user.className} | XP ${user.xp} | renown ${user.renown} | gold ${user.gold}`)
  ].join("\n");
}

function formatLogText(events) {
  if (!events.length) return "adventure log: empty";
  return [
    `adventure log: ${events.length}`,
    ...events.map((event) => `${event.date} ${event.displayName}: ${event.outcome} at ${event.encounterTitle} (+${event.xpGained} XP, +${event.goldGained} gold)`)
  ].join("\n");
}

function adventureResult(config, state, identity, params) {
  const world = worldConfig(config);
  const today = dateKey(config);
  const userId = normalizedIdentity(identity.userId || readString(params, "userId"));
  if (!userId) throw new Error("group_adventure adventure requires userId");
  const userName = identity.userName || readString(params, "userName");
  const displayName = identity.displayName || readString(params, "displayName") || userName || userId;
  const chatId = identity.chatId || readString(params, "chatId");

  const existing = isRecord(state.users[userId]) ? state.users[userId] : createAdventurer({ ...identity, userId, userName, displayName }, world);
  existing.userName = userName || existing.userName || "";
  existing.displayName = displayName || existing.displayName || existing.userName || userId;
  existing.chatIds = Array.isArray(existing.chatIds) ? existing.chatIds : [];
  if (chatId && !existing.chatIds.includes(chatId)) existing.chatIds.push(chatId);

  if (existing.lastDate === today && isRecord(existing.lastAdventure)) {
    const result = {
      kind: "group_adventure_result",
      today,
      alreadyAdventured: true,
      world: { id: world.id, label: world.label, style: world.style },
      adventure: existing.lastAdventure,
      user: publicAdventurer(existing),
      replyText: formatAdventureText({
        today,
        alreadyAdventured: true,
        world: { id: world.id, label: world.label, style: world.style },
        adventure: existing.lastAdventure,
        user: publicAdventurer(existing)
      }),
      modelInstruction: "Use replyText as factual adventure results. You may narrate in a Dungeons & Dragons style, but do not alter rolls, rewards, HP, level, or loot."
    };
    return { result, mutated: false };
  }

  const classData = classById(world, existing.classId || existing.className);
  const encounter = seededPick(world.encounters, `encounter:${userId}:${today}`, world.encounters[0]);
  const roll = d20(`roll:${userId}:${today}`);
  const bonus = Number(classData.mod || 2) + Math.floor(Math.max(0, Number(existing.level || 1) - 1) / 2);
  const dc = Number(encounter.dc || 12) + Math.floor(Math.max(0, Number(existing.level || 1) - 1) / 3);
  const total = roll + bonus;
  const outcome = outcomeFor({ roll, total, dc });
  const mult = rewardMultiplier(outcome);
  const hpBefore = Number(existing.hp || existing.maxHp || classData.maxHp || 10);
  const xpGained = Math.max(1, Math.round(Number(encounter.xp || 20) * mult.xp));
  const goldGained = Math.max(0, Math.round(Number(encounter.gold || 0) * mult.gold));
  const hpDelta = Math.round(Number(encounter.risk || 3) * mult.hp);
  let hpAfter = Math.min(Number(existing.maxHp || 10), Math.max(0, hpBefore + hpDelta));
  let rescued = false;
  if (hpAfter <= 0) {
    rescued = true;
    hpAfter = Math.max(1, Math.floor(Number(existing.maxHp || 10) * 0.25));
  }

  let loot = "";
  if (["critical_success", "strong_success", "success"].includes(outcome)) {
    loot = String(seededPick(world.loot, `loot:${userId}:${today}`, "") || "");
    if (loot && !existing.inventory.includes(loot)) {
      existing.inventory.push(loot);
      existing.inventory = existing.inventory.slice(-MAX_INVENTORY);
    }
  }
  const complication = ["mixed", "failure", "critical_failure"].includes(outcome)
    ? String(seededPick(world.complications, `complication:${userId}:${today}`, "") || "")
    : "";

  const levelBefore = Number(existing.level || 1);
  existing.xp = Number(existing.xp || 0) + xpGained;
  existing.gold = Number(existing.gold || 0) + goldGained;
  existing.hp = hpAfter;
  existing.renown = Number(existing.renown || 0) + mult.renown;
  existing.totalAdventures = Number(existing.totalAdventures || 0) + 1;
  if (["critical_success", "strong_success", "success"].includes(outcome)) existing.successes = Number(existing.successes || 0) + 1;
  if (["failure", "critical_failure"].includes(outcome)) existing.failures = Number(existing.failures || 0) + 1;
  if (outcome === "critical_success") existing.criticalSuccesses = Number(existing.criticalSuccesses || 0) + 1;
  if (outcome === "critical_failure") existing.criticalFailures = Number(existing.criticalFailures || 0) + 1;
  const levelUps = applyLevelUps(existing, classData);

  const adventure = {
    date: today,
    t: nowIso(),
    worldId: world.id,
    encounter: {
      id: String(encounter.id || safeId(encounter.title)),
      title: String(encounter.title || "Unmarked Dungeon Room"),
      tag: String(encounter.tag || "")
    },
    dc,
    roll,
    bonus,
    total,
    outcome,
    xpGained,
    goldGained,
    renownGained: mult.renown,
    hpBefore,
    hpDelta,
    hpAfter: existing.hp,
    rescued,
    loot,
    complication,
    levelBefore,
    levelAfter: existing.level,
    levelUps
  };
  existing.lastDate = today;
  existing.lastAdventure = adventure;
  existing.history = Array.isArray(existing.history) ? existing.history : [];
  existing.history.push(adventure);
  existing.history = existing.history.slice(-MAX_HISTORY);
  state.users[userId] = existing;
  state.days[today] = isRecord(state.days[today]) ? state.days[today] : { users: [], count: 0 };
  if (!state.days[today].users.includes(userId)) state.days[today].users.push(userId);
  state.days[today].count = state.days[today].users.length;
  state.events.unshift({
    date: today,
    t: adventure.t,
    userId,
    displayName: existing.displayName,
    className: existing.className,
    encounterId: adventure.encounter.id,
    encounterTitle: adventure.encounter.title,
    outcome,
    xpGained,
    goldGained,
    levelBefore,
    levelAfter: existing.level
  });
  state.events = state.events.slice(0, MAX_HISTORY);
  state.updatedAt = nowIso();

  const result = {
    kind: "group_adventure_result",
    today,
    alreadyAdventured: false,
    world: { id: world.id, label: world.label, style: world.style },
    adventure,
    user: publicAdventurer(existing),
    groupTodayCount: state.days[today].count,
    replyText: formatAdventureText({
      today,
      alreadyAdventured: false,
      world: { id: world.id, label: world.label, style: world.style },
      adventure,
      user: publicAdventurer(existing)
    }),
    modelInstruction: "Use replyText as factual adventure results. You may narrate in a Dungeons & Dragons style and add short Amadeus commentary, but do not alter rolls, rewards, HP, level, or loot."
  };
  return { result, mutated: true };
}

async function runGroupAdventure(config = {}, params = {}) {
  const action = readString(params, "action", "adventure").toLowerCase();
  const state = normalizeState(await readJson(statePath(config), emptyState()));
  const identity = readIdentity(params);
  const world = worldConfig(config);

  if (action === "adventure" || action === "daily" || action === "run") {
    const { result, mutated } = adventureResult(config, state, identity, params);
    if (mutated) await writeJsonAtomic(statePath(config), state);
    return result;
  }

  if (action === "profile" || action === "sheet") {
    const userId = normalizedIdentity(identity.userId || readString(params, "userId"));
    if (!userId) throw new Error("group_adventure profile requires userId");
    const user = publicAdventurer(state.users[userId]);
    return {
      kind: "group_adventure_profile",
      world: { id: world.id, label: world.label, style: world.style },
      user,
      replyText: formatProfileText(user),
      modelInstruction: "Use replyText as factual character sheet data. Do not invent missing inventory, levels, or gold."
    };
  }

  if (action === "party" || action === "leaderboard") {
    const count = readNumber(params, "count", 10, 1, 20);
    const chatId = identity.chatId || readString(params, "chatId");
    const users = rankUsers(Object.values(state.users).filter((user) => !chatId || !Array.isArray(user.chatIds) || user.chatIds.includes(chatId))).slice(0, count);
    return {
      kind: "group_adventure_party",
      today: dateKey(config),
      world: { id: world.id, label: world.label, style: world.style },
      count: users.length,
      users,
      replyText: formatPartyText(users),
      modelInstruction: "Use replyText as factual party ranking. Natural comments are fine; do not change ranks or numbers."
    };
  }

  if (action === "log" || action === "recent") {
    const count = readNumber(params, "count", 8, 1, 20);
    const chatId = identity.chatId || readString(params, "chatId");
    const events = state.events
      .filter((event) => !chatId || !isRecord(state.users[event.userId]) || !Array.isArray(state.users[event.userId].chatIds) || state.users[event.userId].chatIds.includes(chatId))
      .slice(0, count);
    return {
      kind: "group_adventure_log",
      world: { id: world.id, label: world.label, style: world.style },
      count: events.length,
      events,
      replyText: formatLogText(events),
      modelInstruction: "Use replyText as factual recent adventure log. Do not invent missing events."
    };
  }

  throw new Error("action must be adventure, profile, party, leaderboard, log, or recent");
}

function ok(action, result) {
  return {
    content: [{ type: "text", text: [
      "GROUP_ADVENTURE result",
      `action: ${action}`,
      result.modelInstruction ? `modelInstruction: ${result.modelInstruction}` : "",
      result.replyText || "",
      `json: ${JSON.stringify(result)}`
    ].filter(Boolean).join("\n").slice(0, MAX_TEXT) }],
    details: { status: "ok", action, result }
  };
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `GROUP_ADVENTURE error: ${clip(message, 500)}` }],
    details: { status: "failed", error: message }
  };
}

const groupAdventureTool = {
  name: TOOL_NAME,
  label: "Group Adventure",
  description: "Run a local Dungeons & Dragons style group adventure game. The tool owns character sheets, daily runs, rolls, HP, XP, loot, logs, and leaderboards.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["adventure", "daily", "run", "profile", "sheet", "party", "leaderboard", "log", "recent"], description: "Game operation." },
      userId: { type: "string", description: "Telegram user id. Prefer tg:<id> when available." },
      userName: { type: "string", description: "Telegram username or visible alias." },
      displayName: { type: "string", description: "Visible display name." },
      chatId: { type: "string", description: "Telegram chat id for party filtering." },
      chatTitle: { type: "string", description: "Telegram chat title." },
      user: { type: "object", description: "Optional structured user identity." },
      chat: { type: "object", description: "Optional structured chat identity." },
      count: { type: "number", description: "Max party/log entries." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params = {}) {
    try {
      const action = readString(params, "action", "adventure").toLowerCase();
      const result = await runGroupAdventure(groupAdventureTool.config || {}, params);
      return ok(action, result);
    } catch (error) {
      return fail(error);
    }
  }
};

export const __testing = {
  dateKey,
  seededUnit,
  seededPick,
  d20,
  outcomeFor,
  rewardMultiplier,
  createAdventurer,
  runGroupAdventure,
  worldConfig,
  statePath,
  publicAdventurer,
  rankUsers
};

export default {
  id: "imagebot-group-adventure",
  name: "Imagebot Group Adventure",
  description: "Local D20 fantasy group adventure game state and deterministic daily runs.",
  register(api) {
    groupAdventureTool.config = api.config || {};
    api.registerTool(groupAdventureTool, { name: TOOL_NAME });
  }
};
