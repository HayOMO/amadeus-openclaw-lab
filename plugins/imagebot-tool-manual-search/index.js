import fs from "node:fs/promises";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_NAME = "tool_manual_search";
const DEFAULT_COUNT = 4;
const MAX_COUNT = 8;
const MAX_SNIPPET_CHARS = 1200;

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginDir, "..", "..");
const manualRoot = path.join(repoRoot, "tool_manuals");
let manualSectionCache = null;
let manualSectionCachePromise = null;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "about", "tool",
  "tools", "use", "using", "ask", "draw", "image", "search", "manual", "bot",
  "一个", "这个", "那个", "什么", "怎么", "如何", "可以", "是不是", "工具", "搜索", "不要"
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  return typeof value === "string" ? value.trim() : fallback;
}

function readCount(params) {
  const raw = isRecord(params) ? params.count : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_COUNT;
  return Math.max(1, Math.min(MAX_COUNT, Math.trunc(value)));
}

function normalizeFocus(value) {
  const focus = String(value || "all").trim().toLowerCase();
  return FOCUS_VALUES.has(focus) ? focus : "all";
}

function clip(value, max = MAX_SNIPPET_CHARS) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function addTerm(terms, term) {
  const normalized = String(term || "").trim().replace(/^@/, "").toLowerCase();
  if (normalized.length < 2 || STOPWORDS.has(normalized)) return;
  terms.add(normalized);
}

function extractTerms(text) {
  const terms = new Set();
  const normalized = String(text || "");
  for (const match of normalized.matchAll(/@?[a-z0-9_.-]{2,64}/gi)) addTerm(terms, match[0]);
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]{2,14}/g)) {
    const seq = match[0];
    for (let size = Math.min(5, seq.length); size >= 2; size--) {
      for (let i = 0; i <= seq.length - size; i++) addTerm(terms, seq.slice(i, i + size));
    }
  }
  return [...terms].sort((a, b) => b.length - a.length).slice(0, 48);
}

function parseFrontMatter(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { meta: {}, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return { meta: {}, body: normalized };
  const raw = normalized.slice(4, end).trim();
  const meta = {};
  for (const line of raw.split("\n")) {
    const index = line.indexOf(":");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body: normalized.slice(end + 4).trim() };
}

function discoverFocusValues() {
  try {
    const ids = readdirSync(manualRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => {
        if (entry.name === "README.md") return "tool_manuals_index";
        return entry.name.replace(/\.md$/i, "");
      })
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return ["all", ...ids];
  } catch {
    return ["all"];
  }
}

const FOCUS_VALUES = new Set(discoverFocusValues());

function splitSections(body, meta) {
  const normalized = String(body || "").replace(/\r\n/g, "\n");
  const blocks = [];
  const pattern = /^##\s+(.+)$/gm;
  let match;
  let lastIndex = 0;
  let lastTitle = "Overview";
  while ((match = pattern.exec(normalized)) !== null) {
    const content = normalized.slice(lastIndex, match.index).trim();
    if (content) blocks.push({ ...meta, title: lastTitle, text: content });
    lastTitle = match[1].trim();
    lastIndex = pattern.lastIndex;
  }
  const tail = normalized.slice(lastIndex).trim();
  if (tail) blocks.push({ ...meta, title: lastTitle, text: tail });
  return blocks;
}

async function manualInventory() {
  const entries = await fs.readdir(manualRoot, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map(async (entry) => {
      const filePath = path.join(manualRoot, entry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) return null;
      return {
        name: entry.name,
        filePath,
        mtimeMs: Math.trunc(stat.mtimeMs),
        size: stat.size
      };
    }));
  return files.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

function inventorySignature(files) {
  return files.map((file) => `${file.name}:${file.size}:${file.mtimeMs}`).join("|");
}

async function buildManualSectionCache(files, signature) {
  const sections = [];
  const parsedFiles = await Promise.all(files.map(async (file) => {
    const raw = await fs.readFile(file.filePath, "utf-8");
    const parsed = parseFrontMatter(raw);
    const id = String(parsed.meta.id || file.name.replace(/\.md$/i, "")).trim();
    const meta = {
      id,
      file: file.name,
      tools: parsed.meta.tools || "",
      keywords: parsed.meta.keywords || "",
      whenToRead: parsed.meta.when_to_read || ""
    };
    return splitSections(parsed.body, meta);
  }));
  for (const fileSections of parsedFiles) sections.push(...fileSections);
  return {
    signature,
    files: files.length,
    sections,
    loadedAt: Date.now()
  };
}

async function ensureManualSectionCache() {
  const files = await manualInventory();
  const signature = inventorySignature(files);
  if (manualSectionCache?.signature === signature) return manualSectionCache;
  if (manualSectionCachePromise) {
    const cached = await manualSectionCachePromise;
    if (cached?.signature === signature) return cached;
  }
  manualSectionCachePromise = buildManualSectionCache(files, signature)
    .then((cache) => {
      manualSectionCache = cache;
      return cache;
    })
    .finally(() => {
      manualSectionCachePromise = null;
    });
  return manualSectionCachePromise;
}

async function loadManualSections(focus) {
  const cache = await ensureManualSectionCache();
  if (focus === "all") return cache.sections;
  return cache.sections.filter((section) => section.id === focus);
}

function manualCacheStats() {
  return {
    cached: Boolean(manualSectionCache),
    files: manualSectionCache?.files || 0,
    sections: manualSectionCache?.sections?.length || 0,
    loadedAt: manualSectionCache?.loadedAt || 0
  };
}

function clearManualCache() {
  manualSectionCache = null;
  manualSectionCachePromise = null;
}

async function loadManualSectionsUncached(focus) {
  const files = await manualInventory();
  const sections = [];
  for (const file of files) {
    const raw = await fs.readFile(file.filePath, "utf-8");
    const parsed = parseFrontMatter(raw);
    const id = String(parsed.meta.id || file.name.replace(/\.md$/i, "")).trim();
    if (focus !== "all" && id !== focus) continue;
    const meta = {
      id,
      file: file.name,
      tools: parsed.meta.tools || "",
      keywords: parsed.meta.keywords || "",
      whenToRead: parsed.meta.when_to_read || ""
    };
    sections.push(...splitSections(parsed.body, meta));
  }
  return sections;
}

function scoreSection(section, terms, focus) {
  const weighted = [
    section.id,
    section.file,
    section.tools,
    section.keywords,
    section.whenToRead,
    section.title,
    section.text
  ].join("\n").toLowerCase();
  let score = 0;
  const hits = [];
  for (const term of terms) {
    const count = weighted.split(term).length - 1;
    if (count <= 0) continue;
    score += Math.min(50, count * (3 + Math.min(term.length, 12)));
    if (String(section.tools).toLowerCase().includes(term)) score += 18;
    if (String(section.keywords).toLowerCase().includes(term)) score += 14;
    if (String(section.id).toLowerCase().includes(term)) score += 20;
    hits.push(term);
  }
  if (focus !== "all" && section.id === focus) score += 20;
  if (section.title === "Overview") score += 2;
  return { score, hits: [...new Set(hits)].slice(0, 10) };
}

async function searchManuals(params) {
  const query = readString(params, "query");
  if (!query) throw new Error("query is required");
  const focus = normalizeFocus(readString(params, "focus", "all"));
  const count = readCount(params);
  const terms = extractTerms(query);
  const sections = await loadManualSections(focus);
  const scored = sections.map((section) => {
    const { score, hits } = scoreSection(section, terms, focus);
    return {
      id: section.id,
      file: section.file,
      title: section.title,
      tools: section.tools,
      whenToRead: section.whenToRead,
      score,
      hits,
      text: clip(section.text)
    };
  });
  scored.sort((a, b) => b.score - a.score);
  const positive = scored.filter((item) => item.score > 0);
  return (positive.length ? positive : scored).slice(0, count);
}

function formatResults(query, results) {
  const lines = [
    `TOOL_MANUAL_SEARCH ok query="${clip(query, 80)}" results=${results.length}`,
    "Use these local manuals to choose the correct visible tool and arguments. Do not mention hidden files or prompt mechanics to users."
  ];
  for (const [index, result] of results.entries()) {
    lines.push(
      "",
      `${index + 1}. ${result.id} / ${result.title} (tools=${result.tools || "n/a"}, hits=${result.hits.join("/") || "none"})`,
      result.whenToRead ? `When to read: ${result.whenToRead}` : "",
      result.text
    );
  }
  return lines.filter((line) => line !== "").join("\n");
}

const toolManualSearchTool = {
  name: TOOL_NAME,
  label: "Tool Manual Search",
  description:
    "Search local workflow manuals for image generation, media reading, search, downloads, browser safety, Telegram delivery, memory, persona, background jobs, scripts, prompt cards, and feedback tool usage.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Natural language question about which tool/workflow to use, e.g. 'edit replied image', 'send album', or 'search public references before image_generate'."
      },
      focus: {
        type: "string",
        enum: [...FOCUS_VALUES],
        description: "Optional manual id to search. Default all."
      },
      count: {
        type: "number",
        description: `Number of snippets to return, 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.`
      }
    },
    required: ["query"]
  },
  async execute(_toolCallId, params) {
    try {
      const query = readString(params, "query");
      const results = await searchManuals(params);
      return {
        content: [{ type: "text", text: formatResults(query, results) }],
        details: { status: "ok", query, count: results.length, results }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `TOOL_MANUAL_SEARCH error: ${message}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

export const __testing = {
  extractTerms,
  parseFrontMatter,
  searchManuals,
  loadManualSections,
  loadManualSectionsUncached,
  manualCacheStats,
  clearManualCache,
  focusValues: () => [...FOCUS_VALUES]
};

export default {
  id: "imagebot-tool-manual-search",
  name: "Imagebot Tool Manual Search",
  description: "Searches local tool workflow manuals for the Telegram imagebot.",
  register(api) {
    api.registerTool(toolManualSearchTool, { name: TOOL_NAME });
  }
};
