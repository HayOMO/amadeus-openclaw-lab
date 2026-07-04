import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin, { __testing } from "../plugins/imagebot-chat-toolbox/index.js";
import { __testing as manualTesting } from "../plugins/imagebot-tool-manual-search/index.js";

const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-chat-toolbox-test-"));
const tools = new Map();

plugin.register({
  config: { storeDir, timezoneOffsetMinutes: 480 },
  registerTool(tool, opts) {
    tools.set(opts?.name || tool.name, tool);
  }
});

assert.ok(tools.has("chat_toolbox"));
const tool = tools.get("chat_toolbox");
const ctx = { agentId: "imagebot", chatId: "test-group", senderId: "u1", senderName: "Alice", sessionKey: "s1" };
const seenActions = new Set();

assert.deepEqual(tool.parameters.properties.action.enum, __testing.GROUP_ACTIONS);
assert.equal(tool.parameters.properties.action.enum.length, 9);
assert.ok(!tool.parameters.properties.action.enum.includes("todo_add"));
assert.deepEqual([...new Set(__testing.groupCoverage())].sort(), [...__testing.ACTIONS].sort());

const groupedStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-chat-toolbox-group-test-"));
const groupedConfig = { storeDir: groupedStoreDir, timezoneOffsetMinutes: 480 };
for (const params of [
  { action: "task", op: "add", text: "grouped todo" },
  { action: "records", kind: "note", op: "save", text: "grouped note" },
  { action: "schedule", kind: "countdown", op: "run", date: "2026-07-01T00:00:00+08:00" },
  { action: "poll", op: "create", question: "Grouped?", options: ["yes", "no"] },
  { action: "random", kind: "dice", op: "roll", sides: 6 },
  { action: "text", kind: "stats", op: "run", text: "hello grouped world" },
  { action: "wellness", kind: "habit", op: "checkin", name: "hydrate" },
  { action: "social", kind: "karma", op: "inc", target: "Alice" },
  { action: "queue", op: "join", name: "review", target: "Alice" }
]) {
  const result = await __testing.executeAction(groupedConfig, params, ctx);
  assert.equal(result.details.status, "ok", `grouped action should succeed: ${JSON.stringify(params)}`);
}
assert.equal(__testing.resolveAction({ action: "records", kind: "snippet", op: "search" }), "snippet_search");
assert.equal(__testing.resolveAction({ action: "social", kind: "tell", op: "due" }), "tell_due");

async function call(action, params = {}, context = ctx) {
  seenActions.add(action);
  const result = await tool.execute(`test-${action}`, { action, ...params }, undefined, undefined, context);
  assert.equal(result.details.status, "ok", `${action} should succeed: ${result.content?.[0]?.text}`);
  return result;
}

const todo = await call("todo_add", { text: "write docs" });
await call("todo_list");
await call("todo_done", { id: todo.details.item.id });

await call("note_save", { title: "deploy", text: "manual first" });
const noteSearch = await call("note_search", { query: "manual" });
assert.ok(noteSearch.details.results.length >= 1);
await Promise.all(Array.from({ length: 5 }, (_, index) => call("note_save", {
  title: `concurrent-${index}`,
  text: `concurrent note ${index}`
})));
const concurrentNotes = await call("note_search", { query: "concurrent", count: 10 });
assert.equal(concurrentNotes.details.results.length, 5);

await call("faq_add", { question: "How test?", answer: "Use test group." });
const faq = await call("faq_search", { query: "test" });
assert.match(faq.content[0].text, /Use test group/);

await call("quote_add", { quote: "El Psy Kongroo", author: "lab" });
await call("quote_random", { seed: "quote" });

await call("reminder_add", { text: "check due records", dueAt: "2026-06-30T10:00:00+08:00" });
const due = await call("reminder_due", { before: "2026-06-30T10:01:00+08:00" });
assert.ok(due.details.results.length >= 1);

await call("birthday_add", { name: "Kurisu", date: "07-25" });
await call("birthday_next");

await call("event_add", { title: "Prompt test", date: "2026-07-01T20:00:00+08:00" });
await call("event_agenda", { after: "2026-06-30T00:00:00+08:00" });

const poll = await call("poll_create", { question: "A or B?", options: ["A", "B"] });
await call("poll_vote", { id: poll.details.poll.id, option: "A" });
const pollResults = await call("poll_results", { id: poll.details.poll.id });
assert.equal(pollResults.details.counts.A, 1);

await call("choice", { items: ["a", "b"], seed: "choice" });
await call("roll_dice", { sides: 6, count: 2 });
await call("flip_coin");
await call("random_number", { min: 3, max: 5 });
await call("shuffle", { items: ["a", "b", "c"], seed: "shuffle" });
await call("team_split", { items: ["a", "b", "c", "d"], teamCount: 2, seed: "teams" });
await call("draw_lots", { items: ["a", "b", "c"], count: 2, seed: "lots" });
await call("rps", { choice: "rock" });
await call("eight_ball", { question: "ship it?" });

const stats = await call("text_stats", { text: "hello world\nagain" });
assert.equal(stats.details.words, 3);
const links = await call("extract_links", { text: "see https://example.com and http://example.org" });
assert.equal(links.details.links.length, 2);

await call("bookmark_add", { url: "https://example.com", title: "Example" });
await call("bookmark_search", { query: "Example" });

await call("countdown", { date: "2026-07-01T00:00:00+08:00" });

await call("habit_checkin", { name: "hydrate" });
await call("habit_status");

await call("mood_log", { mood: "focused", note: "unit test" });
const moodSummary = await call("mood_summary");
assert.equal(moodSummary.details.counts.focused, 1);

await call("karma_inc", { target: "Alice", delta: 2 });
const karma = await call("karma_leaderboard");
assert.equal(karma.details.results[0].score, 2);

await call("seen_set", { target: "Bob", note: "was here" });
const seen = await call("seen_get", { target: "Bob" });
assert.match(seen.content[0].text, /Bob/);

await call("tell_add", { target: "Carol", text: "bring logs" });
const tells = await call("tell_due", { target: "Carol" });
assert.equal(tells.details.results.length, 1);

const converted = await call("unit_convert", { value: 100, fromUnit: "cm", toUnit: "m" });
assert.equal(converted.details.result, 1);
await call("timezone_convert", { date: "2026-06-30T00:00:00Z", fromOffsetMinutes: 0, toOffsetMinutes: 480 });

await call("glossary_add", { name: "RAG", text: "retrieval augmented generation" });
await call("glossary_search", { query: "retrieval" });

await call("snippet_save", { title: "short reply", text: "status + next action" });
await call("snippet_search", { query: "status" });

await call("queue_join", { name: "review", target: "Alice" });
const queue = await call("queue_list", { name: "review" });
assert.match(queue.content[0].text, /Alice/);

assert.deepEqual([...seenActions].sort(), [...__testing.ACTIONS].sort());

const manuals = await manualTesting.searchManuals({
  query: "chat toolbox poll todo karma seen tell glossary",
  focus: "chat_toolbox",
  count: 3
});
assert.ok(manuals.some((entry) => entry.id === "chat_toolbox"));

const state = await __testing.loadState({ storeDir });
assert.equal(state.todos.length, 1);
assert.equal(state.polls.length, 1);
assert.ok(Object.keys(state.karma).length >= 1);

console.log("chat-toolbox plugin tests passed", { actions: seenActions.size });
