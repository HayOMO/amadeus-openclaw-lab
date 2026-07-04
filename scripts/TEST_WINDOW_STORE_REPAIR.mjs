import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repairWindowStore } from "./REPAIR_IMAGEBOT_WINDOW_STORE.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-window-store-repair-test-"));

try {
  const storePath = path.join(root, "windows.json");
  const broken = `{
  "version": 3,
  "activeByUser": {
    "tg:100": {
      "windowId": "window-A",
      "ownerUserKey": "tg:100",
      "chatId": "-1001"
    }
  },
  "byBotMessage": {
    "-1001:10": { "windowId": "window-A", "ownerUserKey": "tg:100" },
    "-1001:11": { "windowId": "window-B", "ownerUserKey": "tg:200" }
  },
  "users": {
    "tg:100": {
      "id": "100",
      "currentName": "Alice
bad",
      "names": ["Alice
bad"]
    }
  },
  "windows": {
    "window-A": {
      "windowId": "window-A",
      "ownerUserKey": "tg:100",
      "chatId": "-1001",
      "sessionKey": "agent:imagebot:telegram:group:-1001:sender:100:window:window-A",
      "openedAt": "2026-06-24T00:00:00.000Z",
      "lastActivityAt": "2026-06-24T00:00:00.000Z",
      "participants": {
        "tg:100": { "id": "100", "name": "Alice
bad" }
      },
      "recent": []
    },
    "window-B": {
      "windowId": "window-B",
      "ownerUserKey": "tg:200",
      "chatId": "-1001",
      "sessionKey": "agent:imagebot:telegram:group:-1001:sender:200:window:window-B",
      "openedAt": "2026-06-24T00:00:00.000Z",
      "lastActivityAt": "2026-06-24T00:00:00.000Z",
      "participants": {
        "tg:200": { "id": "200", "name": "Bob" }
      },
      "recent": []
    }
  }
}`;
  await fs.writeFile(storePath, broken, "utf8");

  const repaired = await repairWindowStore(storePath);
  assert.equal(repaired.changed, true);
  assert.equal(repaired.repairedSyntax, true);
  assert.equal(repaired.reset, false);
  assert.equal(repaired.activeUsers, 1);
  assert.equal(repaired.windows, 2);
  assert.ok(repaired.backupPath);

  const parsed = JSON.parse(await fs.readFile(storePath, "utf8"));
  assert.equal(parsed.version, 3);
  assert.equal(parsed.activeByUser["tg:100"].windowId, "window-A");
  assert.equal(parsed.windows["window-A"].closedAt, undefined);
  assert.equal(parsed.windows["window-A"].participants["tg:100"].name, "Alice bad");
  assert.ok(parsed.windows["window-B"].closedAt);
  assert.equal(parsed.windows["window-B"].closedReason, "inactive-window-routing-pruned");
  assert.equal(parsed.byBotMessage["-1001:10"].windowId, "window-A");
  assert.equal(parsed.byBotMessage["-1001:11"], undefined);

  const secondRun = await repairWindowStore(storePath);
  assert.equal(secondRun.changed, false);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("window store repair tests passed");
