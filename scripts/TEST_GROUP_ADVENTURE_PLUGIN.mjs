import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin, { __testing } from "../plugins/imagebot-group-adventure/index.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-group-adventure-test-"));
const storeDir = path.join(root, "store");

const tools = new Map();
plugin.register({
  config: {
    storeDir,
    timezoneOffsetMinutes: 480,
    world: {
      id: "unit_world",
      label: "Unit Test Realm",
      encounters: [
        { id: "unit_rat_cellar", title: "Unit Rat Cellar", dc: 10, xp: 30, gold: 7, risk: 2, tag: "cellar" }
      ],
      loot: ["unit copper spoon"],
      complications: ["unit paperwork curse"]
    }
  },
  registerTool(tool, meta) {
    tools.set(meta.name, tool);
  }
});

assert.ok(tools.has("group_adventure"));
const groupAdventure = tools.get("group_adventure");

const first = await groupAdventure.execute("adv-first", {
  action: "adventure",
  userId: "tg:10001",
  userName: "alice",
  displayName: "Alice",
  chatId: "-100test"
});
assert.equal(first.details.status, "ok");
assert.equal(first.details.action, "adventure");
assert.equal(first.details.result.kind, "group_adventure_result");
assert.equal(first.details.result.alreadyAdventured, false);
assert.equal(first.details.result.world.label, "Unit Test Realm");
assert.equal(first.details.result.adventure.encounter.title, "Unit Rat Cellar");
assert.ok(first.details.result.adventure.roll >= 1 && first.details.result.adventure.roll <= 20);
assert.ok(first.details.result.user.totalAdventures >= 1);
assert.match(first.content[0].text, /GROUP_ADVENTURE result/);
assert.match(first.content[0].text, /Unit Rat Cellar/);

const repeat = await groupAdventure.execute("adv-repeat", {
  action: "adventure",
  userId: "10001",
  displayName: "Alice",
  chatId: "-100test"
});
assert.equal(repeat.details.status, "ok");
assert.equal(repeat.details.result.alreadyAdventured, true);
assert.equal(repeat.details.result.adventure.roll, first.details.result.adventure.roll);
assert.equal(repeat.details.result.user.totalAdventures, first.details.result.user.totalAdventures);

const profile = await groupAdventure.execute("profile", {
  action: "profile",
  userId: "tg:10001"
});
assert.equal(profile.details.status, "ok");
assert.equal(profile.details.result.kind, "group_adventure_profile");
assert.equal(profile.details.result.user.userId, "tg:10001");
assert.match(profile.details.result.replyText, /character sheet/);

const bob = await groupAdventure.execute("adv-bob", {
  action: "adventure",
  userId: "tg:10002",
  displayName: "Bob",
  chatId: "-100test"
});
assert.equal(bob.details.status, "ok");

const party = await groupAdventure.execute("party", {
  action: "party",
  chatId: "-100test",
  count: 5
});
assert.equal(party.details.status, "ok");
assert.equal(party.details.result.kind, "group_adventure_party");
assert.equal(party.details.result.users.length, 2);
assert.match(party.details.result.replyText, /adventuring party/);

const log = await groupAdventure.execute("log", {
  action: "log",
  chatId: "-100test",
  count: 5
});
assert.equal(log.details.status, "ok");
assert.equal(log.details.result.kind, "group_adventure_log");
assert.equal(log.details.result.events.length, 2);
assert.match(log.details.result.replyText, /adventure log/);

const missingProfile = await groupAdventure.execute("missing-profile", {
  action: "profile",
  userId: "tg:99999"
});
assert.equal(missingProfile.details.status, "ok");
assert.equal(missingProfile.details.result.user, null);
assert.match(missingProfile.details.result.replyText, /No adventurer profile/);

const state = JSON.parse(await fs.readFile(__testing.statePath({ storeDir }), "utf8"));
assert.equal(Object.keys(state.users).length, 2);
assert.ok(Array.isArray(state.events));
assert.equal(state.events.length, 2);

assert.equal(__testing.outcomeFor({ roll: 20, total: 20, dc: 99 }), "critical_success");
assert.equal(__testing.outcomeFor({ roll: 1, total: 99, dc: 10 }), "critical_failure");
assert.ok(__testing.rankUsers(Object.values(state.users))[0].level >= 1);

console.log("group adventure plugin tests passed");
