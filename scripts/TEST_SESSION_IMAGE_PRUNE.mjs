import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pruneSessionFile, pruneSessions } from "./PRUNE_IMAGEBOT_SESSION_IMAGES.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-session-prune-test-"));

try {
  const sessionsDir = path.join(root, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const sessionPath = path.join(sessionsDir, "session-a.jsonl");
  const imageData = "a".repeat(5000);
  const lines = [
    JSON.stringify({ type: "session", id: "session-a" }),
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        content: [
          { type: "text", text: "WEB_SNAPSHOT ok\nMEDIA: `C:\\Users\\Bot\\.openclaw\\media\\practical-tools\\web-snapshots\\shot.png`" },
          { type: "image", data: imageData, mimeType: "image/png", fileName: "shot.png" }
        ]
      }
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "MEDIA:C:\\Users\\Bot\\.openclaw\\media\\downloaded\\20260621\\card.jpg" }
        ]
      }
    })
  ];
  await fs.writeFile(sessionPath, `${lines.join("\n")}\n`, "utf8");

  const result = await pruneSessionFile(sessionPath, { minDataChars: 1024 });
  assert.equal(result.changed, true);
  assert.equal(result.pruned, 1);
  assert.ok(result.bytesSaved >= imageData.length);

  const pruned = await fs.readFile(sessionPath, "utf8");
  assert.doesNotMatch(pruned, new RegExp(imageData.slice(0, 100)));
  assert.match(pruned, /saved image preview pruned from session history/);
  assert.match(pruned, /MEDIA: `C:\\\\Users\\\\Bot\\\\.openclaw\\\\media\\\\practical-tools\\\\web-snapshots\\\\shot\.png`/);
  assert.match(pruned, /MEDIA:C:\\\\Users\\\\Bot\\\\.openclaw\\\\media\\\\downloaded\\\\20260621\\\\card\.jpg/);

  const lockedPath = path.join(sessionsDir, "session-b.jsonl");
  await fs.writeFile(lockedPath, `${JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      content: [{ type: "image", data: "b".repeat(5000), mimeType: "image/jpeg", fileName: "locked.jpg" }]
    }
  })}\n`, "utf8");
  await fs.writeFile(`${lockedPath}.lock`, "", "utf8");

  const lockedResult = await pruneSessions({
    sessionsDir,
    lockStaleSeconds: 900,
    minDataChars: 1024,
    maxFiles: 10
  });
  assert.ok(lockedResult.files.some((item) => item.filePath === lockedPath && item.skipped && item.reason === "active-lock"));
  const lockedText = await fs.readFile(lockedPath, "utf8");
  assert.match(lockedText, /bbbbbbbbbbbbbbbb/);

  const staleTime = new Date(Date.now() - 3600 * 1000);
  await fs.utimes(`${lockedPath}.lock`, staleTime, staleTime);
  const staleResult = await pruneSessions({
    sessionsDir,
    lockStaleSeconds: 900,
    minDataChars: 1024,
    maxFiles: 10
  });
  assert.ok(staleResult.files.some((item) => item.filePath === lockedPath && item.pruned === 1));
  const staleText = await fs.readFile(lockedPath, "utf8");
  assert.doesNotMatch(staleText, /bbbbbbbbbbbbbbbb/);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("session image prune tests passed");
