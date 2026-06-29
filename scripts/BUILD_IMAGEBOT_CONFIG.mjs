import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const generatedDir = path.join(scriptDir, "generated");

const persistentStorage = {
  marsForwardMaxEntries: 100_000,
  galleryManifestLines: 1_000_000,
  galleryManifestReadBytes: 512 * 1024 * 1024,
  galleryVisualIndexEntries: 100_000
};

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function readOptionalJson(file, fallback = {}) {
  try {
    return await readJson(file);
  } catch {
    return fallback;
  }
}

async function readText(file) {
  return fs.readFile(file, "utf8");
}

function repoPath(...parts) {
  return path.join(repoRoot, ...parts);
}

function statePath(...parts) {
  return path.join(os.homedir(), ".openclaw", ...parts);
}

function findCodexPluginPath() {
  const root = statePath("npm", "projects");
  if (!fsSync.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name === "openclaw.plugin.json" && /[\\/]@openclaw[\\/]codex[\\/]openclaw\.plugin\.json$/i.test(full)) {
        return path.dirname(full);
      }
    }
  }
  return null;
}

async function buildPrompt(settings) {
  const parts = [];
  for (const segment of settings.promptSegments) {
    const raw = await readText(repoPath(...segment.split("/")));
    parts.push(raw.trim());
  }
  let prompt = parts.join("\n\n").trim();
  if (prompt.includes("{{PERSONA_CARD}}")) {
    assert.ok(settings.personaPath, "prompt uses {{PERSONA_CARD}} but settings.personaPath is not configured");
    const persona = (await readText(repoPath(...settings.personaPath.split("/")))).trim();
    prompt = prompt.replace("{{PERSONA_CARD}}", persona).trim();
  }
  lintPrompt(prompt, settings.promptLint);
  return prompt;
}

function lintPrompt(prompt, lintConfig = {}) {
  const lower = prompt.toLowerCase();
  for (const term of lintConfig.forbiddenSubstrings || []) {
    assert.ok(!lower.includes(String(term).toLowerCase()), `prompt contains forbidden substring: ${term}`);
  }
  for (const term of lintConfig.requiredSubstrings || []) {
    assert.ok(lower.includes(String(term).toLowerCase()), `prompt missing required substring: ${term}`);
  }
}

async function buildCustomCommands(settings) {
  const catalog = await readJson(repoPath(...settings.commandCatalogPath.split("/")));
  return (catalog.commands || [])
    .filter((item) => item.enabled !== false)
    .filter((item) => item.menu !== false)
    .map((item) => ({
      command: String(item.command || "").trim().toLowerCase(),
      description: String(item.description || "").trim()
    }))
    .filter((item) => item.command && item.description);
}

function pluginPaths(settings) {
  const paths = settings.localPluginDirs.map((item) => repoPath(...item.split("/")));
  const codexPath = findCodexPluginPath();
  if (codexPath) paths.push(codexPath);
  return paths;
}

function browserConfig() {
  return {
    enabled: true,
    evaluateEnabled: false,
    headless: true,
    defaultProfile: "openclaw",
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: false,
      allowedHostnames: [
        "example.com",
        "google.com",
        "www.google.com",
        "lens.google.com",
        "saucenao.com",
        "safe.iqdb.org",
        "iqdb.org",
        "ascii2d.net",
        "tineye.com"
      ],
      hostnameAllowlist: [
        "example.com",
        "*.example.com",
        "saucenao.com",
        "*.saucenao.com",
        "iqdb.org",
        "*.iqdb.org",
        "ascii2d.net",
        "*.ascii2d.net",
        "lens.google.com",
        "tineye.com",
        "*.tineye.com"
      ]
    },
    tabCleanup: {
      enabled: true,
      idleMinutes: 15,
      maxTabsPerSession: 4,
      sweepMinutes: 5
    }
  };
}

function groupStreaming() {
  return {
    preview: { toolProgress: false },
    progress: { toolProgress: false }
  };
}

function queueConfig(settings) {
  return {
    mode: settings.queue.mode,
    debounceMsByChannel: { telegram: settings.queue.telegramDebounceMs },
    cap: settings.queue.cap,
    drop: settings.queue.drop
  };
}

function browserGuardConfig() {
  return {
    allowedProfiles: ["openclaw"],
    allowedPathPrefixes: [
      statePath("media", "inbound"),
      statePath("media", "tool-image-generation"),
      statePath("media", "downloaded"),
      statePath("media", "gacha-archive"),
      statePath("feature-core", "gacha-archive")
    ]
  };
}

function gachaArchiveConfig(settings) {
  return {
    enabled: true,
    localDir: statePath("feature-core", "gacha-archive"),
    sendDir: statePath("media", "gacha-archive"),
    channelChatId: settings.gachaArchive.channelChatId,
    tokenFile: statePath("secrets", "telegram-imagebot.token"),
    sendMode: "auto",
    sendToChannelDefault: false,
    telegramTimeoutMs: settings.gachaArchive.telegramTimeoutMs,
    telegramRetryDelaysMs: settings.gachaArchive.telegramRetryDelaysMs
  };
}

function loopDetection() {
  return {
    enabled: true,
    historySize: 12,
    warningThreshold: 3,
    unknownToolThreshold: 2,
    criticalThreshold: 4,
    globalCircuitBreakerThreshold: 5,
    detectors: {
      genericRepeat: true,
      knownPollNoProgress: true,
      pingPong: true
    }
  };
}

function backgroundJobsSharedConfig(settings, kind = "default") {
  const cfg = settings.backgroundJobs || {};
  const keyByKind = {
    default: "defaultMaxConcurrent",
    web: "webMaxConcurrent",
    media: "mediaMaxConcurrent",
    video: "videoMaxConcurrent",
    feature: "featureMaxConcurrent"
  };
  const configured = cfg[keyByKind[kind] || keyByKind.default] ?? cfg.defaultMaxConcurrent;
  const maxConcurrent = Number.isFinite(Number(configured)) ? Number(configured) : 3;
  return {
    storeDir: statePath("background-jobs"),
    maxConcurrent,
    appendActiveContext: true
  };
}

function browserPoolConfig(settings) {
  const cfg = settings.browserPool || {};
  return {
    prewarm: cfg.prewarm === true,
    maxPages: Number.isFinite(Number(cfg.maxPages)) ? Number(cfg.maxPages) : 4,
    idleMs: Number.isFinite(Number(cfg.idleMs)) ? Number(cfg.idleMs) : 15 * 60 * 1000
  };
}

function accountBrowserRiskTierConfig(cfg, tierName, defaults) {
  const tiers = cfg && typeof cfg.tiers === "object" ? cfg.tiers : {};
  const tier = tiers && typeof tiers[tierName] === "object" ? tiers[tierName] : {};
  return {
    minIntervalMs: Number.isFinite(Number(tier.minIntervalMs)) ? Number(tier.minIntervalMs) : defaults.minIntervalMs,
    hourlyLimit: Number.isFinite(Number(tier.hourlyLimit)) ? Number(tier.hourlyLimit) : defaults.hourlyLimit,
    dailyLimit: Number.isFinite(Number(tier.dailyLimit)) ? Number(tier.dailyLimit) : defaults.dailyLimit,
    actionLimit: Number.isFinite(Number(tier.actionLimit)) ? Number(tier.actionLimit) : defaults.actionLimit
  };
}

function accountBrowserRiskConfig(settings) {
  const cfg = settings.accountBrowserRisk || {};
  return {
    enabled: cfg.enabled !== false,
    loginBackoffMs: Number.isFinite(Number(cfg.loginBackoffMs)) ? Number(cfg.loginBackoffMs) : 300_000,
    verificationBackoffMs: Number.isFinite(Number(cfg.verificationBackoffMs)) ? Number(cfg.verificationBackoffMs) : 1_800_000,
    tiers: {
      read: accountBrowserRiskTierConfig(cfg, "read", { minIntervalMs: 5_000, hourlyLimit: 48, dailyLimit: 160, actionLimit: 0 }),
      light: accountBrowserRiskTierConfig(cfg, "light", { minIntervalMs: 9_000, hourlyLimit: 32, dailyLimit: 120, actionLimit: 2 }),
      interactive: accountBrowserRiskTierConfig(cfg, "interactive", { minIntervalMs: 15_000, hourlyLimit: 18, dailyLimit: 80, actionLimit: 4 })
    }
  };
}

function imageGenerationModelConfig(settings) {
  const cfg = settings.imageGeneration || {};
  const model = settings.modelParams || {};
  const timeoutMsFromSeconds = Number.isFinite(Number(model.imageGenerationTimeoutSeconds))
    ? Number(model.imageGenerationTimeoutSeconds) * 1000
    : Number.isFinite(Number(model.imageTimeoutSeconds))
      ? Number(model.imageTimeoutSeconds) * 1000
      : 420000;
  const timeoutMs = Number.isFinite(Number(cfg.timeoutMs)) ? Number(cfg.timeoutMs) : timeoutMsFromSeconds;
  const fallbacks = Array.isArray(cfg.fallbacks)
    ? cfg.fallbacks.map((item) => String(item).trim()).filter(Boolean)
    : [];
  return {
    primary: String(cfg.primary || "openai/gpt-image-2"),
    fallbacks,
    timeoutMs: Math.max(1000, Math.floor(timeoutMs))
  };
}

function chatModelConfig(settings) {
  const state = settings.modelState || {};
  const model = settings.modelParams || {};
  const primary = String(state.model || model.model || "openai/gpt-5.5").trim();
  const reasoningEffort = String(state.reasoningEffort || model.reasoningEffort || "medium").trim();
  const textVerbosity = String(state.textVerbosity || model.textVerbosity || "low").trim();
  return {
    primary,
    reasoningEffort,
    textVerbosity
  };
}

function webSearchConfig(settings) {
  const cfg = settings.webSearch || {};
  const native = cfg.openaiCodex || {};
  const result = {
    enabled: true,
    maxResults: Number.isFinite(Number(cfg.maxResults)) ? Number(cfg.maxResults) : 6,
    timeoutSeconds: Number.isFinite(Number(cfg.timeoutSeconds)) ? Number(cfg.timeoutSeconds) : 30,
    cacheTtlMinutes: Number.isFinite(Number(cfg.cacheTtlMinutes)) ? Number(cfg.cacheTtlMinutes) : 15,
    openaiCodex: {
      enabled: native.enabled !== false,
      mode: String(native.mode || "live"),
      contextSize: String(native.contextSize || "medium")
    }
  };
  if (cfg.provider) {
    result.provider = String(cfg.provider);
  }
  return result;
}

function lifecycleHookPolicy({ promptInjection = false } = {}) {
  return {
    allowConversationAccess: true,
    ...(promptInjection ? { allowPromptInjection: true } : {})
  };
}

function buildConfigOps(settings, customCommands) {
  const model = settings.modelParams;
  const chatModel = chatModelConfig(settings);
  const ops = [
    { path: "agents.defaults.model.primary", value: chatModel.primary },
    { path: "agents.list[0].model", value: chatModel.primary },
    { path: `agents.defaults.models["${chatModel.primary}"]`, value: {} },
    { path: `agents.list[0].models["${chatModel.primary}"]`, value: {} },
    { path: "agents.list[0].params.reasoningEffort", value: chatModel.reasoningEffort },
    { path: "agents.list[0].params.textVerbosity", value: chatModel.textVerbosity },
    { path: "agents.defaults.maxConcurrent", value: model.maxConcurrent },
    { path: "agents.defaults.subagents.maxConcurrent", value: model.subagentMaxConcurrent },
    { path: "agents.list[0].groupChat.mentionPatterns", value: settings.mentionPatterns },
    { path: "messages.groupChat.mentionPatterns", value: settings.mentionPatterns },
    { path: "messages.queue", value: queueConfig(settings) },
    { path: "messages.ackReaction", value: "" },
    { path: "messages.ackReactionScope", value: "off" },
    { path: "messages.statusReactions", value: { enabled: false } },
    { path: "plugins.allow", value: settings.allowedPluginIds },
    { path: "plugins.load.paths", value: pluginPaths(settings) },
    { path: "plugins.entries.browser.enabled", value: true },
    { path: "plugins.entries.deepseek.enabled", value: true },
    { path: "plugins.entries.web-image-search.enabled", value: true },
    { path: "plugins.entries.web-image-search.config", value: { backgroundJobs: backgroundJobsSharedConfig(settings, "web"), browserPool: browserPoolConfig(settings) } },
    { path: "plugins.entries.imagebot-browser-guard.enabled", value: true },
    { path: "plugins.entries.imagebot-browser-guard.hooks", value: lifecycleHookPolicy() },
    { path: "plugins.entries.imagebot-browser-guard.config", value: browserGuardConfig() },
    { path: "plugins.entries.imagebot-video-utils.enabled", value: true },
    { path: "plugins.entries.imagebot-video-utils.config", value: { backgroundJobs: backgroundJobsSharedConfig(settings, "video") } },
    { path: "plugins.entries.imagebot-audio-transcribe.enabled", value: true },
    {
      path: "plugins.entries.imagebot-audio-transcribe.config",
      value: {
        mediaDir: statePath("media", "audio-transcribe"),
        storeDir: statePath("audio-transcribe"),
        backgroundJobs: backgroundJobsSharedConfig(settings, "video")
      }
    },
    { path: "plugins.entries.imagebot-public-video.enabled", value: true },
    {
      path: "plugins.entries.imagebot-public-video.config",
      value: {
        mediaDir: statePath("media", "public-video"),
        storeDir: statePath("public-video"),
        maxBytes: 100 * 1024 * 1024,
        maxDurationSeconds: 20 * 60,
        backgroundJobs: backgroundJobsSharedConfig(settings, "video")
      }
    },
    { path: "plugins.entries.imagebot-pixiv-resource.enabled", value: true },
    {
      path: "plugins.entries.imagebot-pixiv-resource.config",
      value: {
        refreshTokenFile: statePath("secrets", "pixiv-refresh.token"),
        mediaDir: statePath("media", "pixiv-resource"),
        storeDir: statePath("resources", "pixiv"),
        maxImageBytes: 120 * 1024 * 1024
      }
    },
    { path: "plugins.entries.imagebot-image-skills.enabled", value: true },
    {
      path: "plugins.entries.imagebot-image-skills.config",
      value: {
        storeDir: statePath("imagebot-image-skills")
      }
    },
    { path: "plugins.entries.imagebot-meme-tools.enabled", value: true },
    {
      path: "plugins.entries.imagebot-meme-tools.config",
      value: {
        mediaDir: statePath("media", "meme-tools"),
        backgroundJobs: backgroundJobsSharedConfig(settings, "media")
      }
    },
    { path: "plugins.entries.imagebot-memory-search.enabled", value: true },
    { path: "plugins.entries.imagebot-memory-search.hooks", value: lifecycleHookPolicy({ promptInjection: true }) },
    {
      path: "plugins.entries.imagebot-memory-search.config",
      value: {
        appendPromptContext: true
      }
    },
    { path: "plugins.entries.imagebot-knowledge-library.enabled", value: true },
    {
      path: "plugins.entries.imagebot-knowledge-library.config",
      value: {
        storeDir: statePath("knowledge-library"),
        repoRoot
      }
    },
    { path: "plugins.entries.imagebot-persona-search.enabled", value: true },
    { path: "plugins.entries.imagebot-tool-manual-search.enabled", value: true },
    { path: "plugins.entries.imagebot-background-jobs.enabled", value: true },
    { path: "plugins.entries.imagebot-background-jobs.hooks", value: lifecycleHookPolicy({ promptInjection: true }) },
    {
      path: "plugins.entries.imagebot-background-jobs.config",
      value: {
        ...backgroundJobsSharedConfig(settings, "default")
      }
    },
    { path: "plugins.entries.imagebot-turn-observer.enabled", value: true },
    { path: "plugins.entries.imagebot-turn-observer.hooks", value: lifecycleHookPolicy({ promptInjection: true }) },
    {
      path: "plugins.entries.imagebot-turn-observer.config",
      value: {
        storeDir: statePath("turn-observer"),
        maxRecords: 100_000
      }
    },
    { path: "plugins.entries.imagebot-generated-gallery.enabled", value: true },
    {
      path: "plugins.entries.imagebot-generated-gallery.config",
      value: {
        archiveRoot: statePath("media", "archive"),
        storeDir: statePath("generated-gallery"),
        resendDir: statePath("media", "gallery-resend"),
        previewDir: statePath("media", "gallery-preview"),
        maxManifestLines: persistentStorage.galleryManifestLines,
        maxManifestReadBytes: persistentStorage.galleryManifestReadBytes,
        maxVisualIndexEntries: persistentStorage.galleryVisualIndexEntries
      }
    },
    { path: "plugins.entries.imagebot-group-adventure.enabled", value: true },
    {
      path: "plugins.entries.imagebot-group-adventure.config",
      value: {
        storeDir: statePath("group-adventure"),
        timezoneOffsetMinutes: 480,
        world: {
          id: "d20_fantasy",
          label: "D20 Fantasy"
        }
      }
    },
    { path: "plugins.entries.imagebot-media-artifacts.enabled", value: true },
    { path: "plugins.entries.imagebot-media-artifacts.hooks", value: lifecycleHookPolicy({ promptInjection: true }) },
    {
      path: "plugins.entries.imagebot-media-artifacts.config",
      value: {
        strictGeneratedRefs: true,
        appendPromptContext: true,
        dependencyDirs: [
          repoPath("plugins", "imagebot-practical-tools"),
          repoPath("plugins", "imagebot-memory-search")
        ],
        toolResultImageContext: {
          enabled: true,
          maxImages: 6,
          maxSourceBytes: 8 * 1024 * 1024,
          previewMaxBytes: 1250 * 1024,
          previewMaxEdge: 1536
        },
        visionContextGate: {
          loliVisionGuard: {
            enabled: true,
            modelDir: statePath("models", "wd-v1-4-vit-tagger-v2"),
            dependencyDirs: [
              repoPath("plugins", "imagebot-practical-tools"),
              repoPath("plugins", "imagebot-memory-search")
            ],
            modelRepo: "SmilingWolf/wd-v1-4-vit-tagger-v2",
            maxImages: 6,
            loliThreshold: 0.28
          }
        }
      }
    },
    { path: "plugins.entries.imagebot-practical-tools.enabled", value: true },
    {
      path: "plugins.entries.imagebot-practical-tools.config",
      value: {
        backgroundJobs: backgroundJobsSharedConfig(settings, "media"),
        browserPool: browserPoolConfig(settings),
        accountBrowserRisk: accountBrowserRiskConfig(settings)
      }
    },
    { path: "plugins.entries.imagebot-desktop-control.enabled", value: true },
    {
      path: "plugins.entries.imagebot-desktop-control.config",
      value: {
        storeDir: statePath("desktop-control"),
        helperPath: repoPath("scripts", "LOCAL_DESKTOP_MEDIA_CONTROL.ps1"),
        timeoutMs: 15000,
        audit: true
      }
    },
    { path: "plugins.entries.imagebot-sticker-pack.enabled", value: true },
    {
      path: "plugins.entries.imagebot-sticker-pack.config",
      value: {
        mediaDir: statePath("media", "sticker-pack"),
        tokenFile: statePath("secrets", "telegram-imagebot.token"),
        botUsername: settings.botUsernames[0] || "YOUR_BOT_USERNAME"
      }
    },
    { path: "plugins.entries.imagebot-interaction-core.enabled", value: true },
    { path: "plugins.entries.imagebot-interaction-core.hooks", value: lifecycleHookPolicy({ promptInjection: true }) },
    {
      path: "plugins.entries.imagebot-interaction-core.config",
      value: {
        appendInteractionContext: true,
        botUsernames: settings.botUsernames,
        triggerPrefixes: ["Amadeus", "Amaduse", "Makise Kurisu", "Makise", "Kurisu"],
        marsForwardDetector: {
          enabled: true,
          llmReview: true,
          reaction: "🔥",
          scriptReactKinds: ["channel_message", "canonical_url", "telegram_file"],
          storageBackend: "sqlite",
          statePath: statePath("imagebot", "mars-forward-detector.json"),
          sqlitePath: statePath("imagebot", "mars-forward-detector.sqlite"),
          tokenFile: statePath("secrets", "telegram-imagebot.token"),
          mediaDir: statePath("media", "mars-forward"),
          maxMediaBytes: 20 * 1024 * 1024,
          maxMediaTotalBytes: 100 * 1024 * 1024 * 1024,
          pruneIntervalMs: 60 * 1000,
          mediaIndexQueueLimit: 512,
          mediaIndexMaxConcurrent: 1,
          visualHashEnabled: true,
          visualHashMaxDistance: 24,
          dependencyDirs: [
            repoPath("plugins", "imagebot-generated-gallery"),
            repoPath("plugins", "imagebot-practical-tools"),
            repoPath("plugins", "imagebot-sticker-pack")
          ],
          maxEntries: persistentStorage.marsForwardMaxEntries
        },
        loliNsfwVisionGuard: {
          enabled: true,
          mode: "withhold_vision",
          modulePath: repoPath("plugins", "imagebot-shared", "vision-context-gate.mjs"),
          modelDir: statePath("models", "wd-v1-4-vit-tagger-v2"),
          dependencyDirs: [
            repoPath("plugins", "imagebot-practical-tools"),
            repoPath("plugins", "imagebot-memory-search")
          ],
          modelRepo: "SmilingWolf/wd-v1-4-vit-tagger-v2",
          maxImages: 4,
          loliThreshold: 0.28
        }
      }
    },
    { path: "plugins.entries.imagebot-agent-ops.enabled", value: true },
    { path: "plugins.entries.imagebot-agent-ops.hooks", value: lifecycleHookPolicy({ promptInjection: true }) },
    {
      path: "plugins.entries.imagebot-agent-ops.config",
      value: {
        storeDir: statePath("agent-ops"),
        repoRoot,
        windowStorePath: statePath("agents", "imagebot", "sessions", "sessions.json.telegram-imagebot-windows.json"),
        appendModeContext: true,
        appendPersonaContext: true,
        appendRelevantSkills: true,
        failureSlowMs: 25000
      }
    },
    { path: "plugins.entries.imagebot-creative-ops.enabled", value: true },
    { path: "plugins.entries.imagebot-creative-ops.hooks", value: lifecycleHookPolicy({ promptInjection: true }) },
    {
      path: "plugins.entries.imagebot-creative-ops.config",
      value: {
        appendFeedbackHints: true,
        allowMutatingScripts: true,
        backgroundJobs: backgroundJobsSharedConfig(settings, "default"),
        repoRoot
      }
    },
    { path: "plugins.entries.imagebot-feature-core.enabled", value: true },
    {
      path: "plugins.entries.imagebot-feature-core.config",
      value: {
        featuresDir: repoPath("features"),
        storeDir: statePath("feature-core"),
        timezoneOffsetMinutes: 480,
        backgroundJobs: backgroundJobsSharedConfig(settings, "feature"),
        gachaArchive: gachaArchiveConfig(settings)
      }
    },
    { path: "plugins.entries.zhihu-openapi.enabled", value: true },
    { path: "browser", value: browserConfig() },
    { path: "tools.allow", value: settings.allowedTools },
    { path: "tools.deny", value: settings.deniedTools },
    { path: "tools.web.search", value: webSearchConfig(settings) },
    { path: "tools.message.actions.allow", value: ["send"] },
    { path: "agents.list[0].tools.allow", value: settings.allowedTools },
    { path: "agents.list[0].tools.deny", value: settings.deniedTools },
    { path: "agents.list[0].tools.message.actions.allow", value: ["send"] },
    { path: "agents.list[0].tools.loopDetection", value: loopDetection() },
    { path: "agents.defaults.imageModel", value: { primary: "openai/gpt-5.5" } },
    { path: "agents.defaults.imageGenerationModel", value: imageGenerationModelConfig(settings) },
    { path: "agents.defaults.mediaMaxMb", value: model.mediaMaxMb },
    { path: "tools.media.image.timeoutSeconds", value: model.imageTimeoutSeconds },
    { path: "channels.telegram.customCommands", value: customCommands },
    { path: "channels.telegram.accounts.imagebot.customCommands", value: customCommands },
    { path: "channels.telegram.streaming", value: groupStreaming() },
    { path: "channels.telegram.accounts.imagebot.streaming", value: groupStreaming() },
    { path: "channels.telegram.groupPolicy", value: "allowlist" },
    { path: "channels.telegram.accounts.imagebot.groupPolicy", value: "allowlist" }
  ];

  for (const groupId of settings.groupIds) {
    ops.push({ path: `channels.telegram.groups.${groupId}.requireMention`, value: true });
    ops.push({ path: `channels.telegram.accounts.imagebot.groups.${groupId}.requireMention`, value: true });
  }
  return ops;
}

function buildPromptOps(settings, prompt) {
  const ops = [];
  for (const groupId of settings.groupIds) {
    ops.push({ path: `channels.telegram.groups.${groupId}.systemPrompt`, value: prompt });
    ops.push({ path: `channels.telegram.accounts.imagebot.groups.${groupId}.systemPrompt`, value: prompt });
  }
  return ops;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function buildImagebotConfig({ write = false } = {}) {
  const settingsPath = repoPath("config", "imagebot", "settings.json");
  const settings = await readJson(settingsPath);
  const modelState = await readOptionalJson(repoPath("config", "imagebot", "model-state.json"), {});
  settings.modelState = modelState;
  assert.equal(settings.schema, 1);
  const prompt = await buildPrompt(settings);
  const customCommands = await buildCustomCommands(settings);
  const configOps = buildConfigOps(settings, customCommands);
  const promptOps = buildPromptOps(settings, prompt);

  assert.ok(configOps.some((op) => op.path === "tools.allow" && op.value.includes("telegram_media_spoiler")));
  assert.ok(promptOps.length === settings.groupIds.length * 2);

  const outputs = {
    settings,
    prompt,
    configOps,
    promptOps,
    paths: {
      configBatch: path.join(generatedDir, "imagebot-config.batch.json"),
      promptBatch: path.join(generatedDir, "imagebot-prompts.batch.json"),
      legacyBatch: path.join(scriptDir, "APPLY_CHAT_BALANCE_MODE.batch.generated.json")
    }
  };

  if (write) {
    await writeJson(outputs.paths.configBatch, configOps);
    await writeJson(outputs.paths.promptBatch, promptOps);
    await writeJson(outputs.paths.legacyBatch, configOps);
  }

  return outputs;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes("--write");
  const result = await buildImagebotConfig({ write });
  const summary = {
    write,
    configOps: result.configOps.length,
    promptOps: result.promptOps.length,
    promptChars: result.prompt.length,
    configBatch: path.relative(repoRoot, result.paths.configBatch),
    promptBatch: path.relative(repoRoot, result.paths.promptBatch)
  };
  console.log(JSON.stringify(summary, null, 2));
}
