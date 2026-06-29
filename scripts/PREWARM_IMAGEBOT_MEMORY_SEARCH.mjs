import { __testing as memorySearch } from "../plugins/imagebot-memory-search/index.js";

const force = process.argv.includes("--force");
const startedAt = Date.now();

try {
  const result = await memorySearch.prewarmSemanticIndex({ force });
  console.log(JSON.stringify({
    ...result,
    force,
    durationMs: Date.now() - startedAt
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: "failed",
    force,
    durationMs: Date.now() - startedAt,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
}
