import { buildSafetyReviewPrompt as buildLoliSafetyReviewPrompt, screenImage, screenMediaBatch as screenLoliMediaBatch } from "./loli-nsfw-vision-guard.mjs";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveLoliGuardConfig(config = {}) {
  const gate = isRecord(config.visionContextGate) ? config.visionContextGate : {};
  const direct = isRecord(config.loliVisionGuard) ? config.loliVisionGuard :
    isRecord(config.loliGuard) ? config.loliGuard :
      isRecord(config.loliNsfwVisionGuard) ? config.loliNsfwVisionGuard : {};
  const nested = isRecord(gate.loliVisionGuard) ? gate.loliVisionGuard :
    isRecord(gate.loliGuard) ? gate.loliGuard :
      isRecord(gate.loliNsfwVisionGuard) ? gate.loliNsfwVisionGuard : {};
  return { ...config, ...gate, ...direct, ...nested };
}

function loliGuardEnabled(config = {}) {
  const guardConfig = resolveLoliGuardConfig(config);
  return guardConfig.enabled !== false;
}

export async function screenVisionContextImage(filePath, input = {}, config = {}) {
  if (!loliGuardEnabled(config)) {
    return {
      allowed: true,
      blocked: false,
      action: "allow",
      reason: "gate_disabled",
      gates: []
    };
  }
  const guardConfig = resolveLoliGuardConfig(config);
  const result = await screenImage(filePath, input, guardConfig);
  return {
    ...result,
    allowed: !result.blocked,
    gates: [{
      name: "loli",
      action: result.action,
      reason: result.reason,
      scores: result.scores,
      signals: result.signals
    }]
  };
}

export async function screenVisionContextMediaBatch({ media = [], text = "", config = {} } = {}) {
  if (!loliGuardEnabled(config)) {
    const allowed = Array.isArray(media) ? media : [];
    return {
      blocked: [],
      allowed,
      checked: 0,
      errors: [],
      blockedCount: 0,
      status: "ok",
      gates: []
    };
  }
  const guardConfig = resolveLoliGuardConfig(config);
  const result = await screenLoliMediaBatch({ media, text, config: guardConfig });
  return {
    ...result,
    gates: ["loli"]
  };
}

export function buildSafetyReviewPrompt(result = {}) {
  return buildLoliSafetyReviewPrompt(result);
}

// Compatibility for the existing OpenClaw runtime bridge.
export const screenMediaBatch = screenVisionContextMediaBatch;
