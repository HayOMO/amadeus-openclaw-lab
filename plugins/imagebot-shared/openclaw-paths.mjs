import os from "node:os";
import path from "node:path";

function expandHome(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "~") return os.homedir();
  if (text.startsWith(`~${path.sep}`) || text.startsWith("~/") || text.startsWith("~\\")) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

export function openclawHomeDir() {
  const configured = expandHome(process.env.OPENCLAW_HOME);
  return path.resolve(configured || os.homedir());
}

export function openclawStateDir() {
  const configured = expandHome(process.env.OPENCLAW_STATE_DIR);
  return path.resolve(configured || path.join(openclawHomeDir(), ".openclaw"));
}

export function openclawStatePath(...parts) {
  return path.join(openclawStateDir(), ...parts);
}
