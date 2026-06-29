import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const LOOKUP_TOOL = "image_skill_lookup";
const SAVE_REFERENCE_TOOL = "image_skill_save_reference";
const NOTE_PREFERENCE_TOOL = "image_skill_note_preference";
const RECENT_TOOL = "image_skill_recent";

const MAX_REFERENCES = 12;
const MAX_RESULTS = 8;
const MAX_NOTE_CHARS = 600;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const ALLOWED_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || process.cwd();
}

function nowIso() {
  return new Date().toISOString();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function readCount(params, fallback = 5, max = MAX_RESULTS) {
  const raw = isRecord(params) ? params.count : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function clip(value, max = MAX_NOTE_CHARS) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function hash(value, len = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function storeRoot(config = {}) {
  const configured = String(config.storeDir || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "imagebot-image-skills"));
}

function indexPath(config = {}) {
  return path.join(storeRoot(config), "skills.json");
}

function referencesRoot(config = {}) {
  return path.join(storeRoot(config), "references");
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function safeIdForName(value) {
  const cleaned = normalizeName(value)
    .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || `skill-${hash(value, 12)}`;
}

function readStringList(params, key) {
  const raw = isRecord(params) ? params[key] : undefined;
  if (Array.isArray(raw)) return raw.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(/[,，;；|]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    const key = normalizeName(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function extractSearchTerms(value) {
  const terms = new Set();
  const text = String(value || "").toLowerCase();
  for (const match of text.matchAll(/[a-z0-9_.-]{2,64}/gi)) terms.add(match[0].toLowerCase());
  for (const match of text.matchAll(/[\u4e00-\u9fff]{2,16}/g)) {
    const seq = match[0];
    terms.add(seq);
    for (let size = Math.min(6, seq.length); size >= 2; size--) {
      for (let i = 0; i <= seq.length - size; i++) terms.add(seq.slice(i, i + size));
    }
  }
  return [...terms].slice(0, 40);
}

async function readIndex(config = {}) {
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath(config), "utf8"));
    if (isRecord(parsed) && Array.isArray(parsed.skills)) return parsed;
  } catch {}
  return { schema: 1, updatedAt: "", skills: [] };
}

async function writeIndex(config = {}, index) {
  await fs.mkdir(storeRoot(config), { recursive: true });
  const file = indexPath(config);
  const temp = `${file}.${process.pid}.tmp`;
  const next = {
    schema: 1,
    updatedAt: nowIso(),
    skills: Array.isArray(index.skills) ? index.skills : []
  };
  await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
  return next;
}

function allowedMediaRoots(config = {}) {
  const home = homeDir();
  const defaults = [
    path.join(home, ".openclaw", "media", "inbound"),
    path.join(home, ".openclaw", "media", "tool-image-generation"),
    path.join(home, ".openclaw", "media", "downloaded"),
    path.join(home, ".openclaw", "media", "gallery-resend"),
    path.join(home, ".openclaw", "media", "gacha-archive"),
    path.join(home, ".openclaw", "media", "practical-tools"),
    path.join(home, ".openclaw", "media", "archive"),
    referencesRoot(config)
  ];
  const extra = Array.isArray(config.allowedMediaRoots) ? config.allowedMediaRoots : [];
  return [...defaults, ...extra].map((entry) => path.resolve(String(entry))).filter(Boolean);
}

function isInside(root, target) {
  const rootNorm = path.resolve(root).toLowerCase();
  const targetNorm = path.resolve(target).toLowerCase();
  return targetNorm === rootNorm || targetNorm.startsWith(rootNorm + path.sep);
}

function readMediaPath(raw) {
  const value = String(raw || "").trim().replace(/^`+|`+$/g, "");
  const mediaMatch = value.match(/(?:SPOILER_)?MEDIA:\s*`?([^`\r\n]+)`?/i);
  const unwrapped = mediaMatch ? mediaMatch[1] : value;
  if (/^file:\/\//i.test(unwrapped)) return decodeURIComponent(unwrapped.replace(/^file:\/\//i, ""));
  return unwrapped;
}

async function resolveAllowedReference(config, raw) {
  const input = readMediaPath(raw);
  if (!input) throw new Error("media path is required");
  if (/^https?:\/\//i.test(input)) throw new Error("image skills save bot-local media paths, not external URLs");
  const resolved = path.resolve(input);
  if (!allowedMediaRoots(config).some((root) => isInside(root, resolved))) {
    throw new Error("media path is outside allowed bot media directories");
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("media path is not a file");
  if (stat.size > MAX_MEDIA_BYTES) throw new Error("media file is larger than 50 MB");
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(ext)) throw new Error(`unsupported reference image type: ${ext || "unknown"}`);
  return { path: resolved, stat, ext };
}

async function sha256File(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function publicSkill(skill, { includeReferences = true, maxReferences = 3 } = {}) {
  const references = includeReferences ? (skill.references || []).slice(0, maxReferences).map((ref) => ({
    refId: ref.refId,
    path: ref.path,
    sourceUrl: ref.sourceUrl || "",
    note: ref.note || "",
    createdAt: ref.createdAt || ""
  })) : [];
  return {
    skillId: skill.skillId,
    name: skill.name,
    aliases: skill.aliases || [],
    traits: skill.traits || "",
    styleHints: skill.styleHints || "",
    references,
    preferences: (skill.preferences || []).slice(-5)
  };
}

function scoreSkill(skill, query) {
  const q = normalizeName(query);
  if (!q) return 1;
  const names = [skill.name, ...(skill.aliases || [])].map(normalizeName).filter(Boolean);
  let score = 0;
  for (const name of names) {
    if (name === q) score += 100;
    else if (name.includes(q) || q.includes(name)) score += 60;
  }
  const haystack = [
    skill.name,
    ...(skill.aliases || []),
    skill.traits,
    skill.styleHints,
    ...(skill.preferences || []).map((pref) => pref.note)
  ].join("\n").toLowerCase();
  for (const term of extractSearchTerms(q)) {
    if (haystack.includes(term)) score += 12;
  }
  return score;
}

function formatLookup(skills) {
  if (!skills.length) return "IMAGE_SKILL_LOOKUP results=0";
  const lines = [`IMAGE_SKILL_LOOKUP results=${skills.length}`];
  for (const [index, skill] of skills.entries()) {
    lines.push(`${index + 1}. skill_id=${skill.skillId} | name=${skill.name} | aliases=${(skill.aliases || []).join(", ") || "-"}`);
    if (skill.traits) lines.push(`traits: ${clip(skill.traits, 220)}`);
    if (skill.styleHints) lines.push(`style: ${clip(skill.styleHints, 220)}`);
    for (const ref of (skill.references || []).slice(0, 3)) lines.push(`reference: ${ref.refId} | MEDIA: \`${ref.path}\``);
    const prefs = (skill.preferences || []).slice(-3).map((pref) => `${pref.userName || pref.userId || "user"}: ${pref.note}`);
    if (prefs.length) lines.push(`preferences: ${prefs.map((item) => clip(item, 140)).join(" | ")}`);
  }
  return lines.join("\n");
}

async function lookup(config, params = {}) {
  const query = readString(params, "query") || readString(params, "character") || readString(params, "name");
  const count = readCount(params, 5, MAX_RESULTS);
  const index = await readIndex(config);
  const scored = index.skills
    .map((skill) => ({ skill, score: scoreSkill(skill, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(b.skill.updatedAt || "").localeCompare(String(a.skill.updatedAt || "")))
    .slice(0, count)
    .map((item) => item.skill);
  return {
    content: [{ type: "text", text: formatLookup(scored) }],
    details: { status: "ok", query, results: scored.map((skill) => publicSkill(skill)) }
  };
}

function findSkill(index, nameOrId) {
  const key = normalizeName(nameOrId);
  return index.skills.find((skill) =>
    normalizeName(skill.skillId) === key ||
    normalizeName(skill.name) === key ||
    (skill.aliases || []).some((alias) => normalizeName(alias) === key)
  );
}

async function saveReference(config, params = {}) {
  const character = readString(params, "character") || readString(params, "name");
  if (!character) throw new Error("character/name is required");
  const source = await resolveAllowedReference(config, readString(params, "media") || readString(params, "image") || readString(params, "path"));
  const digest = await sha256File(source.path);
  const index = await readIndex(config);
  let skill = findSkill(index, character);
  if (!skill) {
    skill = {
      skillId: safeIdForName(character),
      name: character,
      aliases: [],
      traits: "",
      styleHints: "",
      references: [],
      preferences: [],
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    index.skills.push(skill);
  }
  const aliases = uniqueStrings([...skill.aliases, ...readStringList(params, "aliases"), character]);
  skill.aliases = aliases.filter((alias) => normalizeName(alias) !== normalizeName(skill.name)).slice(0, 24);
  const traits = readString(params, "traits");
  const styleHints = readString(params, "styleHints") || readString(params, "style");
  if (traits) skill.traits = clip(traits, 1200);
  if (styleHints) skill.styleHints = clip(styleHints, 1200);

  let ref = (skill.references || []).find((item) => item.sha256 === digest);
  if (!ref) {
    const refDir = path.join(referencesRoot(config), skill.skillId);
    await fs.mkdir(refDir, { recursive: true });
    const ext = source.ext === ".jpeg" ? ".jpg" : source.ext;
    const target = path.join(refDir, `${digest.slice(0, 20)}${ext}`);
    await fs.copyFile(source.path, target);
    ref = {
      refId: `ref_${digest.slice(0, 12)}`,
      sha256: digest,
      path: target,
      originalPath: source.path,
      sourceUrl: readString(params, "sourceUrl"),
      note: clip(readString(params, "note") || readString(params, "caption"), 300),
      createdAt: nowIso()
    };
    skill.references = [ref, ...(skill.references || [])].slice(0, MAX_REFERENCES);
  }
  skill.updatedAt = nowIso();
  await writeIndex(config, index);
  return {
    content: [{
      type: "text",
      text: [
        "IMAGE_SKILL_SAVE_REFERENCE ok",
        `skill_id: ${skill.skillId}`,
        `name: ${skill.name}`,
        `reference: ${ref.refId}`,
        `MEDIA: \`${ref.path}\``
      ].join("\n")
    }],
    details: { status: "ok", skill: publicSkill(skill, { maxReferences: 5 }), reference: ref }
  };
}

async function notePreference(config, params = {}) {
  const character = readString(params, "character") || readString(params, "name");
  const note = readString(params, "note") || readString(params, "preference");
  if (!character) throw new Error("character/name is required");
  if (!note) throw new Error("note/preference is required");
  const index = await readIndex(config);
  let skill = findSkill(index, character);
  if (!skill) {
    skill = {
      skillId: safeIdForName(character),
      name: character,
      aliases: [],
      traits: "",
      styleHints: "",
      references: [],
      preferences: [],
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    index.skills.push(skill);
  }
  const userId = readString(params, "userId");
  const userName = readString(params, "userName") || readString(params, "displayName");
  const preference = {
    t: nowIso(),
    userId,
    userName,
    note: clip(note, MAX_NOTE_CHARS)
  };
  skill.preferences = [...(skill.preferences || []), preference].slice(-40);
  skill.updatedAt = nowIso();
  await writeIndex(config, index);
  return {
    content: [{ type: "text", text: `IMAGE_SKILL_NOTE_PREFERENCE ok\nskill_id: ${skill.skillId}\nnote: ${preference.note}` }],
    details: { status: "ok", skill: publicSkill(skill, { maxReferences: 2 }), preference }
  };
}

async function recent(config, params = {}) {
  const count = readCount(params, 5, MAX_RESULTS);
  const index = await readIndex(config);
  const skills = [...index.skills]
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, count);
  return {
    content: [{ type: "text", text: formatLookup(skills) }],
    details: { status: "ok", results: skills.map((skill) => publicSkill(skill)) }
  };
}

function makeTool(name, label, description, parameters, execute) {
  return { name, label, description, parameters, execute };
}

const lookupTool = makeTool(LOOKUP_TOOL, "Image Skill Lookup", "Lookup local character/style reference skills before image generation.", {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", description: "Character/style/user preference query." },
    character: { type: "string", description: "Character name alias." },
    count: { type: "number", description: `Max results 1-${MAX_RESULTS}.` }
  }
}, async (_id, params) => lookup(lookupTool.config || {}, params));

const saveReferenceTool = makeTool(SAVE_REFERENCE_TOOL, "Image Skill Save Reference", "Save a bot-local reference image into a lightweight image skill.", {
  type: "object",
  additionalProperties: false,
  properties: {
    character: { type: "string", description: "Character or subject name." },
    name: { type: "string", description: "Alias for character." },
    media: { type: "string", description: "Bot-local image path or MEDIA line." },
    image: { type: "string", description: "Alias for media." },
    aliases: { type: "string", description: "Comma-separated aliases." },
    traits: { type: "string", description: "Short factual visual traits." },
    styleHints: { type: "string", description: "Short generation/style hints." },
    sourceUrl: { type: "string", description: "Optional public source URL." },
    note: { type: "string", description: "Short note for this reference." }
  },
  required: ["character", "media"]
}, async (_id, params) => {
  try {
    return await saveReference(saveReferenceTool.config || {}, params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `IMAGE_SKILL_SAVE_REFERENCE error: ${message}` }], details: { status: "failed", error: message } };
  }
});

const notePreferenceTool = makeTool(NOTE_PREFERENCE_TOOL, "Image Skill Note Preference", "Record a lightweight per-user image preference for a character/style skill.", {
  type: "object",
  additionalProperties: false,
  properties: {
    character: { type: "string", description: "Character or subject name." },
    name: { type: "string", description: "Alias for character." },
    note: { type: "string", description: "Preference note." },
    preference: { type: "string", description: "Alias for note." },
    userId: { type: "string", description: "Telegram user id if available." },
    userName: { type: "string", description: "Telegram username/name if available." },
    displayName: { type: "string", description: "Display name if available." }
  },
  required: ["character", "note"]
}, async (_id, params) => {
  try {
    return await notePreference(notePreferenceTool.config || {}, params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `IMAGE_SKILL_NOTE_PREFERENCE error: ${message}` }], details: { status: "failed", error: message } };
  }
});

const recentTool = makeTool(RECENT_TOOL, "Image Skill Recent", "List recently updated local image skills.", {
  type: "object",
  additionalProperties: false,
  properties: {
    count: { type: "number", description: `Max results 1-${MAX_RESULTS}.` }
  }
}, async (_id, params) => recent(recentTool.config || {}, params));

export const __testing = {
  readIndex,
  writeIndex,
  lookup,
  saveReference,
  notePreference,
  extractSearchTerms,
  allowedMediaRoots,
  resolveAllowedReference,
  storeRoot,
  indexPath
};

export default {
  id: "imagebot-image-skills",
  name: "Imagebot Image Skills",
  description: "Lightweight local character/style reference cache for image generation.",
  register(api) {
    const config = api.config || {};
    for (const tool of [lookupTool, saveReferenceTool, notePreferenceTool, recentTool]) tool.config = config;
    api.registerTool(lookupTool, { name: LOOKUP_TOOL });
    api.registerTool(saveReferenceTool, { name: SAVE_REFERENCE_TOOL });
    api.registerTool(notePreferenceTool, { name: NOTE_PREFERENCE_TOOL });
    api.registerTool(recentTool, { name: RECENT_TOOL });
  }
};
