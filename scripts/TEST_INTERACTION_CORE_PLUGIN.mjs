import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import interactionCore, { __testing } from "../plugins/imagebot-interaction-core/index.js";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-interaction-core-"));
const marsStatePath = path.join(tmpRoot, "mars-forward-detector.json");

const tools = new Map();
const hooks = new Map();

interactionCore.register({
  config: {
    botUsernames: ["YOUR_BOT_USERNAME"],
    triggerPrefixes: ["助手", "amadeus", "kurisu"],
    appendInteractionContext: true,
    marsForwardDetector: {
      statePath: marsStatePath,
      tokenFile: path.join(tmpRoot, "telegram.token")
    }
  },
  registerTool(tool, opts) {
    tools.set(opts?.name || tool.name, tool);
  },
  registerHook(name, handler) {
    const list = hooks.get(name) || [];
    list.push(handler);
    hooks.set(name, list);
  }
});

assert.ok(tools.has("interaction_pipeline"));
assert.ok(tools.has("mars_forward_lookup"));
assert.ok(hooks.has("before_prompt_build"));

const ignored = await tools.get("interaction_pipeline").execute("ignored", {
  action: "evaluate",
  text: "普通群消息",
  isGroup: true,
  userId: 10001,
  chatId: "-100test"
});
assert.equal(ignored.details.status, "ok");
assert.equal(ignored.details.result.shouldRespond, false);
assert.equal(ignored.details.result.identity.userId, "tg:10001");
assert.equal(ignored.details.result.version, "middleware-v2");
assert.ok(ignored.details.result.pipeline.some((item) => item.name === "decision" && item.status === "ignore"));

const prefixed = await tools.get("interaction_pipeline").execute("prefix", {
  action: "evaluate",
  text: "助手 签到",
  isGroup: true,
  userId: "10001",
  chatId: "-100test"
});
assert.equal(prefixed.details.result.shouldRespond, true);
assert.equal(prefixed.details.result.reason, "trigger_prefix");
assert.equal(prefixed.details.result.normalizedText, "签到");
assert.equal(prefixed.details.result.window.mode, "sender_window");
assert.ok(prefixed.details.result.pipeline.some((item) => item.name === "trigger_prefix" && item.status === "matched"));

const mentioned = await tools.get("interaction_pipeline").execute("mention", {
  action: "evaluate",
  text: "@YOUR_BOT_USERNAME 画一张猫",
  isGroup: true,
  botUsername: "YOUR_BOT_USERNAME",
  userId: "10002",
  chatId: "-100test"
});
assert.equal(mentioned.details.result.shouldRespond, true);
assert.equal(mentioned.details.result.reason, "bot_mention");
assert.equal(mentioned.details.result.normalizedText, "画一张猫");

const command = await tools.get("interaction_pipeline").execute("command", {
  action: "evaluate",
  text: "/amstatus@YOUR_BOT_USERNAME",
  isGroup: true,
  userId: "10003",
  chatId: "-100test"
});
assert.equal(command.details.result.shouldRespond, true);
assert.equal(command.details.result.reason, "control_command");
assert.equal(command.details.result.command, "/amstatus");
assert.equal(command.details.result.normalizedText, "");

const reply = await tools.get("interaction_pipeline").execute("reply", {
  action: "evaluate",
  text: "我也进来看看",
  isGroup: true,
  isReplyToBot: true,
  replySessionKey: "window:A",
  userId: "10004",
  chatId: "-100test"
});
assert.equal(reply.details.result.shouldRespond, true);
assert.equal(reply.details.result.reason, "reply_to_bot");
assert.equal(reply.details.result.window.mode, "reply_window");
assert.equal(reply.details.result.window.key, "window:A");
assert.ok(reply.details.result.pipeline.some((item) => item.name === "window_route" && item.status === "reply_window"));

const standaloneAfterReply = await tools.get("interaction_pipeline").execute("standalone-after-reply", {
  action: "evaluate",
  text: "助手 my own window",
  isGroup: true,
  activeSessionKey: "window:A",
  userId: "10004",
  chatId: "-100test"
});
assert.equal(standaloneAfterReply.details.result.shouldRespond, true);
assert.equal(standaloneAfterReply.details.result.reason, "trigger_prefix");
assert.equal(standaloneAfterReply.details.result.window.mode, "sender_window");
assert.equal(standaloneAfterReply.details.result.window.key, "tg:-100test:user:tg:10004");
assert.ok(standaloneAfterReply.details.result.pipeline.some((item) => item.name === "window_route" && item.status === "sender_window"));

const fresh = await tools.get("interaction_pipeline").execute("fresh", {
  action: "evaluate",
  text: "/amnew",
  isGroup: true,
  userId: "10005",
  chatId: "-100test"
});
assert.equal(fresh.details.result.reason, "new_window");
assert.equal(fresh.details.result.window.mode, "new_window");

const identity = await tools.get("interaction_pipeline").execute("identity", {
  action: "identity",
  user: { id: 123, username: "alice", name: "Alice" },
  chat: { id: "-100test", title: "Test" }
});
assert.equal(identity.details.identity.userId, "tg:123");
assert.equal(identity.details.identity.publicLabel, "Alice");

const blocked = await tools.get("interaction_pipeline").execute("blocked", {
  action: "evaluate",
  text: "助手 hello",
  isGroup: true,
  userId: "999",
  chatId: "-100test",
  allowFrom: ["tg:123"]
});
assert.equal(blocked.details.result.shouldRespond, false);
assert.equal(blocked.details.result.reason, "sender_not_allowed");
assert.ok(blocked.details.result.pipeline.some((item) => item.name === "permission" && item.status === "blocked"));

const rateLimitedFirst = await tools.get("interaction_pipeline").execute("rate-first", {
  action: "evaluate",
  text: "助手 hello",
  isGroup: true,
  userId: "rate-user",
  chatId: "-100rate",
  rateLimit: { enabled: true, windowMs: 60000, maxPerUser: 1, maxPerChat: 10 },
  recordRateLimit: true,
  enforceRateLimit: true
});
assert.equal(rateLimitedFirst.details.result.shouldRespond, true);
const rateLimitedSecond = await tools.get("interaction_pipeline").execute("rate-second", {
  action: "evaluate",
  text: "助手 hello again",
  isGroup: true,
  userId: "rate-user",
  chatId: "-100rate",
  rateLimit: { enabled: true, windowMs: 60000, maxPerUser: 1, maxPerChat: 10 },
  recordRateLimit: true,
  enforceRateLimit: true
});
assert.equal(rateLimitedSecond.details.result.shouldRespond, false);
assert.equal(rateLimitedSecond.details.result.reason, "rate_limited");
assert.ok(rateLimitedSecond.details.result.pipeline.some((item) => item.name === "rate_limit" && item.status === "limited"));

const rules = await tools.get("interaction_pipeline").execute("rules", { action: "rules" });
assert.match(rules.content[0].text, /middleware-v2/);
assert.match(rules.content[0].text, /receive -> identity -> command/);

const ctx = { agentId: "imagebot", sessionKey: "telegram:window:A", userId: "10004", chatId: "-100test" };
const promptPieces = [];
for (const handler of hooks.get("before_prompt_build") || []) {
  const result = await handler({ prompt: "hello" }, ctx);
  if (result?.appendContext) promptPieces.push(result.appendContext);
}
assert.match(promptPieces.join("\n"), /interaction context/);
assert.equal(__testing.parseCommand("/amnew@YOUR_BOT_USERNAME hi", ["amaduse_bot"]).command, "/amnew");

await fs.writeFile(marsStatePath, `${JSON.stringify({
  schema: 1,
  scopes: {
    "-100test": {
      "channel:-100source:42": {
        matchKeys: ["channel:-100source:42", "url:abc123", "media:photo-unique-large-a"],
        first: {
          chatId: "-100test",
          messageId: "501",
          timestampMs: 1780000000000,
          timestamp: "2026-06-01T00:00:00.000Z",
          senderName: "Alice",
          preview: "first forwarded post",
          source: { from: "Source Channel", fromType: "channel", fromId: "-100source", fromMessageId: "42" },
          match: {
            key: "channel:-100source:42",
            keys: ["channel:-100source:42", "url:abc123", "media:photo-unique-large-a"],
            kind: "channel_message",
            urls: ["https://example.com/post"],
            mediaIds: ["photo-unique-large-a"]
          },
          media: [{
            kind: "photo",
            fileUniqueId: "photo-unique-large-a",
            fileId: "photo-large-a",
            localPath: "C:\\mars\\first.webp",
            cacheStatus: "cached",
            visualHashStatus: "ready",
            visualHash: {
              algorithm: "ahash8+dhash8+phash32",
              ahash: "ffffffffffffffff",
              dhash: "0000000000000000",
              phash: "aaaaaaaaaaaaaaaa"
            }
          }]
        },
        last: {
          chatId: "-100test",
          messageId: "777",
          timestampMs: 1780000100000,
          timestamp: "2026-06-01T00:01:40.000Z",
          senderName: "Bob",
          preview: "duplicate forwarded post",
          source: { from: "Source Channel", fromType: "channel", fromId: "-100source", fromMessageId: "42" },
          match: {
            key: "url:abc123",
            keys: ["channel:-100source:42", "url:abc123", "media:photo-unique-large-a"],
            kind: "canonical_url",
            urls: ["https://example.com/post"],
            mediaIds: ["photo-unique-large-a"]
          },
          media: [{ kind: "photo", fileUniqueId: "photo-unique-large-a", fileId: "photo-large-b" }]
        },
        hitCount: 2,
        lastSeenAt: 1780000100000
      }
    }
  }
}, null, 2)}\n`, "utf8");

const marsLookup = await tools.get("mars_forward_lookup").execute("mars-lookup", {
  action: "lookup",
  messageId: "777"
}, null, null, { agentId: "imagebot", chatId: "-100test", messageId: "777" });
assert.equal(marsLookup.details.status, "ok");
assert.equal(marsLookup.details.results[0].first.messageId, "501");
assert.deepEqual(marsLookup.details.results[0].matchKeys, ["channel:-100source:42", "url:abc123", "media:photo-unique-large-a"]);
assert.equal(marsLookup.details.results[0].first.match.urls[0], "https://example.com/post");
assert.equal(marsLookup.details.results[0].first.media[0].fileUniqueId, "photo-unique-large-a");
assert.equal(marsLookup.details.results[0].first.media[0].cacheStatus, "cached");
assert.equal(marsLookup.details.results[0].first.media[0].visualHashStatus, "ready");
assert.match(marsLookup.content[0].text, /first forwarded post/);
assert.match(marsLookup.content[0].text, /cache=cached/);
assert.match(marsLookup.content[0].text, /visual=ready/);

const marsForwardDryRun = await tools.get("mars_forward_lookup").execute("mars-forward", {
  action: "forward_first",
  dryRun: true
}, null, null, { agentId: "imagebot", chatId: "-100test", messageId: "999" });
assert.equal(marsForwardDryRun.details.status, "ok");
assert.equal(marsForwardDryRun.details.method, "dry_run");
assert.equal(marsForwardDryRun.details.first.messageId, "501");
assert.equal(marsForwardDryRun.details.first.chatId, "-100test");

const marsSqlitePath = path.join(tmpRoot, "mars-forward-detector.sqlite");
const marsDb = new DatabaseSync(marsSqlitePath);
marsDb.exec(`
  CREATE TABLE mars_forward_records (
    scope_key TEXT NOT NULL,
    match_key TEXT NOT NULL,
    record_key TEXT NOT NULL,
    record_json TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL DEFAULT 0,
    first_timestamp_ms INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, match_key)
  );
`);
const sqliteMarsRecord = {
  matchKeys: ["channel:-100source:99", "url:def456"],
  first: {
    chatId: "-100test",
    messageId: "601",
    timestampMs: 1780000200000,
    timestamp: "2026-06-01T00:03:20.000Z",
    senderName: "Carol",
    preview: "sqlite first forwarded post",
    source: { from: "SQLite Source", fromType: "channel", fromId: "-100source", fromMessageId: "99" },
    match: { key: "channel:-100source:99", keys: ["channel:-100source:99", "url:def456"], kind: "channel_message" }
  },
  last: {
    chatId: "-100test",
    messageId: "888",
    timestampMs: 1780000300000,
    timestamp: "2026-06-01T00:05:00.000Z",
    senderName: "Dave",
    preview: "sqlite duplicate forwarded post",
    match: { key: "url:def456", keys: ["channel:-100source:99", "url:def456"], kind: "canonical_url" }
  },
  hitCount: 2,
  lastSeenAt: 1780000300000
};
marsDb.prepare(`
  INSERT INTO mars_forward_records
    (scope_key, match_key, record_key, record_json, last_seen_at, first_timestamp_ms, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run("-100test", "channel:-100source:99", "-100test:601", JSON.stringify(sqliteMarsRecord), 1780000300000, 1780000200000, Date.now());
marsDb.close();

const marsSqliteLookup = await tools.get("mars_forward_lookup").execute("mars-sqlite-lookup", {
  action: "lookup",
  messageId: "888"
}, null, null, { agentId: "imagebot", chatId: "-100test", messageId: "888" });
assert.equal(marsSqliteLookup.details.status, "ok");
assert.equal(marsSqliteLookup.details.results[0].first.messageId, "601");
assert.equal(marsSqliteLookup.details.results[0].first.source.from, "SQLite Source");

await fs.rm(tmpRoot, { recursive: true, force: true });

console.log("interaction-core plugin tests passed");
