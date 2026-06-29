import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_NAME = "persona_search";
const DEFAULT_COUNT = 4;
const MAX_COUNT = 8;

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginDir, "..", "..");
const personaRoot = path.join(repoRoot, "persona");

const PERSONA_FILES = [
  { file: "active_system.md", focus: "core", label: "active-system" },
  { file: "core.md", focus: "core", label: "core" },
  { file: "kurisu_base.md", focus: "lore", label: "kurisu-base" },
  { file: "amadeus_delta.md", focus: "lore", label: "amadeus-delta" },
  { file: "voice_zh.md", focus: "voice", label: "voice-zh" },
  { file: "reactions.md", focus: "reactions", label: "reactions" },
  { file: "examples.md", focus: "examples", label: "examples" },
  { file: "lorebook.md", focus: "lore", label: "lorebook" },
  { file: "source_synthesis.md", focus: "lore", label: "source-synthesis" }
];

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "about",
  "ask", "draw", "search", "image", "persona", "amadeus", "kurisu",
  "一个", "这个", "那个", "什么", "怎么", "如何", "可以", "是不是", "就是", "不要"
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
  return new Set(["all", "core", "voice", "reactions", "lore", "examples"]).has(focus) ? focus : "all";
}

function clip(value, max) {
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
  for (const match of normalized.matchAll(/@?[a-z0-9_-]{2,64}/gi)) addTerm(terms, match[0]);
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]{2,12}/g)) {
    const seq = match[0];
    for (let size = Math.min(4, seq.length); size >= 2; size--) {
      for (let i = 0; i <= seq.length - size; i++) addTerm(terms, seq.slice(i, i + size));
    }
  }
  return [...terms];
}

function splitSections(text, meta) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
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

async function loadSections(focus) {
  const sections = [];
  for (const meta of PERSONA_FILES) {
    if (focus !== "all" && meta.focus !== focus) continue;
    const text = await fs.readFile(path.join(personaRoot, meta.file), "utf-8");
    sections.push(...splitSections(text, meta));
  }
  return sections;
}

function scoreSection(section, terms, focus) {
  const haystack = `${section.label}\n${section.title}\n${section.text}`.toLowerCase();
  let score = 0;
  const hits = [];
  for (const term of terms) {
    const count = haystack.split(term).length - 1;
    if (count <= 0) continue;
    score += Math.min(40, count * (3 + Math.min(term.length, 10)));
    hits.push(term);
  }
  if (focus !== "all" && section.focus === focus) score += 12;
  if (section.label === "core") score += 4;
  return { score, hits: [...new Set(hits)].slice(0, 8) };
}

async function searchPersona(params) {
  const query = readString(params, "query", "legacy Amadeus persona");
  const focus = normalizeFocus(readString(params, "focus", "all"));
  const count = readCount(params);
  const terms = extractTerms(query);
  const sections = await loadSections(focus);
  const scored = sections.map((section) => {
    const { score, hits } = scoreSection(section, terms, focus);
    return {
      label: section.label,
      focus: section.focus,
      title: section.title,
      score,
      hits,
      text: clip(section.text, 900)
    };
  });
  scored.sort((a, b) => b.score - a.score);
  const positive = scored.filter((item) => item.score > 0);
  return (positive.length ? positive : scored).slice(0, count);
}

function formatResults(query, results) {
  const lines = [
    `PERSONA_SEARCH ok query="${clip(query, 80)}" results=${results.length}`,
    "These are legacy Amadeus/Kurisu reference notes. Use them only when that old persona/card is explicitly relevant."
  ];
  for (const [index, result] of results.entries()) {
    lines.push(
      "",
      `${index + 1}. ${result.label} / ${result.title} (focus=${result.focus}, hits=${result.hits.join("/") || "none"})`,
      result.text
    );
  }
  return lines.join("\n");
}

const personaSearchTool = {
  name: TOOL_NAME,
  label: "Persona Search",
  description:
    "Retrieve legacy Amadeus/Kurisu persona notes only when that old persona/card is explicitly discussed. Current persona profile selection is handled by persona_config.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Legacy Amadeus/Kurisu persona, lore, or tone query from the current turn."
      },
      focus: {
        type: "string",
        enum: ["all", "core", "voice", "reactions", "lore", "examples"],
        description: "Optional persona area to search. Default all."
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
      const query = readString(params, "query", "legacy Amadeus persona");
      const results = await searchPersona(params);
      return {
        content: [{ type: "text", text: formatResults(query, results) }],
        details: { status: "ok", query, count: results.length, results }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `PERSONA_SEARCH error: ${message}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

export const __testing = {
  extractTerms,
  searchPersona
};

export default {
  id: "imagebot-persona-search",
  name: "Imagebot Persona Search",
  description: "Retrieves legacy Amadeus/Kurisu persona notes for explicit old-card references.",
  register(api) {
    api.registerTool(personaSearchTool, { name: TOOL_NAME });
  }
};
