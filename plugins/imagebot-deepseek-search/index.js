import fs from "node:fs/promises";

const PLUGIN_ID = "imagebot-deepseek-search";
const PROVIDER_ID = "deepseek";
const CREDENTIAL_PATH = `plugins.entries.${PLUGIN_ID}.config.secretFile`;
const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";

const SearchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      description: "Public-web search query."
    },
    count: {
      type: "integer",
      description: "Maximum number of source links to return (1-10).",
      minimum: 1,
      maximum: 10
    },
    country: { type: "string", description: "Optional country hint included in the request." },
    language: { type: "string", description: "Optional language hint included in the request." },
    freshness: { type: "string", description: "Optional freshness hint included in the request." },
    date_after: { type: "string", description: "Optional lower date bound included in the request." },
    date_before: { type: "string", description: "Optional upper date bound included in the request." }
  }
};

function readPluginConfig(config) {
  return config?.plugins?.entries?.[PLUGIN_ID]?.config;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

export function normalizeDeepSeekSearchConfig(value = {}) {
  const baseUrl = String(value.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (baseUrl !== DEFAULT_BASE_URL) {
    throw new Error(`DeepSeek search baseUrl must be ${DEFAULT_BASE_URL}`);
  }
  return {
    enabled: value.enabled !== false,
    secretFile: String(value.secretFile || "").trim(),
    baseUrl,
    model: String(value.model || "deepseek-v4-flash").trim(),
    timeoutMs: boundedInteger(value.timeoutMs, 30_000, 5_000, 120_000),
    maxUses: boundedInteger(value.maxUses, 2, 1, 8),
    maxTokens: boundedInteger(value.maxTokens, 800, 128, 4096)
  };
}

function queryWithHints(args) {
  const query = String(args?.query || "").trim();
  if (!query) throw new Error("query is required");
  const hints = [
    args?.country ? `country=${String(args.country).trim()}` : "",
    args?.language ? `language=${String(args.language).trim()}` : "",
    args?.freshness ? `freshness=${String(args.freshness).trim()}` : "",
    args?.date_after ? `date_after=${String(args.date_after).trim()}` : "",
    args?.date_before ? `date_before=${String(args.date_before).trim()}` : ""
  ].filter(Boolean);
  return hints.length > 0 ? `${query}\nSearch hints: ${hints.join(", ")}` : query;
}

export function buildDeepSeekSearchRequest(args, config) {
  return {
    model: config.model,
    max_tokens: config.maxTokens,
    messages: [{
      role: "user",
      content: [
        "Search the public web for the request below. Return a concise evidence-focused answer. Do not invent sources.",
        queryWithHints(args)
      ].join("\n\n")
    }],
    tools: [{
      type: "web_search_20250305",
      name: "web_search",
      max_uses: config.maxUses
    }]
  };
}

function addResult(results, seen, value) {
  const url = String(value?.url || "").trim();
  if (!url || seen.has(url)) return;
  seen.add(url);
  results.push({
    title: String(value?.title || value?.page_title || url).trim(),
    url,
    ...(value?.page_age ? { pageAge: String(value.page_age) } : {})
  });
}

export function parseDeepSeekSearchResponse(value, count = 6) {
  const content = Array.isArray(value?.content) ? value.content : [];
  const text = content
    .filter((block) => block?.type === "text")
    .map((block) => String(block?.text || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const results = [];
  const seen = new Set();
  for (const block of content) {
    if (block?.type === "web_search_tool_result") {
      const entries = Array.isArray(block.content) ? block.content : [];
      for (const entry of entries) addResult(results, seen, entry);
    }
    const citations = Array.isArray(block?.citations) ? block.citations : [];
    for (const citation of citations) addResult(results, seen, citation);
  }
  return {
    answer: text,
    results: results.slice(0, boundedInteger(count, 6, 1, 10)),
    usage: {
      inputTokens: Number(value?.usage?.input_tokens || 0),
      outputTokens: Number(value?.usage?.output_tokens || 0),
      searchRequests: Number(value?.usage?.server_tool_use?.web_search_requests || 0)
    }
  };
}

async function readApiKey(config) {
  const fromEnv = String(process.env.DEEPSEEK_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  if (!config.secretFile) throw new Error("DeepSeek search secretFile is not configured");
  const apiKey = String(await fs.readFile(config.secretFile, "utf8")).trim();
  if (!apiKey) throw new Error("DeepSeek search API key file is empty");
  return apiKey;
}

async function executeSearch(args, rawConfig, executionContext = {}) {
  const config = normalizeDeepSeekSearchConfig(rawConfig);
  if (!config.enabled) throw new Error("DeepSeek native search is disabled");
  const apiKey = await readApiKey(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("DeepSeek native search timed out")), config.timeoutMs);
  const parentSignal = executionContext?.signal;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  try {
    const response = await fetch(`${config.baseUrl}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(buildDeepSeekSearchRequest(args, config))
    });
    const bodyText = await response.text();
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
    if (!response.ok) {
      const message = String(body?.error?.message || body?.message || bodyText || response.statusText).trim();
      throw new Error(`DeepSeek native search failed (${response.status}): ${message.slice(0, 300)}`);
    }
    const parsed = parseDeepSeekSearchResponse(body, args?.count);
    if (!parsed.answer && parsed.results.length === 0) {
      throw new Error("DeepSeek native search returned no answer or sources");
    }
    return {
      query: String(args.query).trim(),
      ...parsed,
      native: true,
      protocol: "deepseek-anthropic-web-search"
    };
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function createProvider(pluginConfig) {
  return {
    id: PROVIDER_ID,
    label: "DeepSeek Native Search",
    hint: "Uses DeepSeek's provider-native server-side web search",
    onboardingScopes: ["text-inference"],
    requiresCredential: true,
    credentialLabel: "DeepSeek API key",
    envVars: ["DEEPSEEK_API_KEY"],
    authProviderId: "deepseek",
    placeholder: "sk-...",
    signupUrl: "https://platform.deepseek.com/",
    docsUrl: "https://api-docs.deepseek.com/guides/anthropic_api",
    autoDetectOrder: 20,
    credentialPath: CREDENTIAL_PATH,
    getCredentialValue: (searchConfig) => searchConfig?.deepseekApiKey || pluginConfig.secretFile || process.env.DEEPSEEK_API_KEY,
    setCredentialValue: (target, value) => {
      target.deepseekApiKey = value;
    },
    getConfiguredCredentialValue: (config) => {
      const configured = normalizeDeepSeekSearchConfig(readPluginConfig(config) || pluginConfig);
      return configured.enabled ? configured.secretFile || process.env.DEEPSEEK_API_KEY : undefined;
    },
    createTool: () => ({
      description: "Search the public web using DeepSeek provider-native server search. Returns a synthesized answer and source links; text search only.",
      parameters: SearchSchema,
      execute: (args, context) => executeSearch(args, pluginConfig, context)
    })
  };
}

const plugin = {
  id: PLUGIN_ID,
  name: "Imagebot DeepSeek Native Search",
  description: "DeepSeek provider-native web search bridge for OpenClaw.",
  register(api) {
    const config = normalizeDeepSeekSearchConfig(api.pluginConfig || {});
    api.registerWebSearchProvider(createProvider(config));
  }
};

export default plugin;
