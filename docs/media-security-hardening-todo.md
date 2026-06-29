# Media Security Hardening TODO

This note records the media parsing hardening work found during a quick review of `amadeus-openclaw-lab` on 2026-06-25.

Goal: keep the bot's current media features, but reduce risk from untrusted Telegram images, videos, audio, GIFs, and PDFs. Do not do a broad refactor unless a specific item below requires it.

## Threat model

The bot receives user-controlled media and then parses it with native libraries and external tools:

- `sharp` / libvips for image transform and previews.
- `ffprobe` and `ffmpeg` for video/audio probing, keyframes, compression, audio extraction, and GIF conversion.
- `opencv` / browser `BarcodeDetector` for QR decode.
- `pypdfium2` and Pillow for PDF page rendering.
- Chromium/Playwright for web snapshots and browser-side QR fallback.

The main concern is not `file.jpg` magically executing as malware. The realistic risks are:

- resource exhaustion: decompression bombs, huge decoded pixel counts, long videos, pathological PDFs;
- parser vulnerabilities in native media libraries;
- accidental expansion of allowed filesystem paths;
- unsafe command invocation if future changes accidentally switch to shell-string execution.

## Current good parts to preserve

- `video_keyframes` and `av_media` use `spawn(command, args)` / argument arrays, not shell-string concatenation.
- Media tools reject remote URLs for local media transforms.
- Inputs are restricted to bot media directories.
- There are file-size limits and command timeouts.
- Output names are generated/sanitized instead of trusting user filenames.

Preserve these properties while hardening.

## Priority 0: remove unlimited image pixel decoding

### Problem

`plugins/imagebot-practical-tools/index.js` currently disables sharp's input pixel guard in at least two places:

```js
sharp(filePath, { animated: false, limitInputPixels: false })
sharp(input.path, { animated: false, limitInputPixels: false }).rotate()
```

This increases DoS risk from small compressed images that expand to huge decoded pixel counts.

### Suggested change

Add a shared constant near the existing media constants:

```js
const MAX_IMAGE_INPUT_PIXELS = 50_000_000;
```

Then replace `limitInputPixels: false` with an explicit limit:

```js
const SHARP_INPUT_OPTIONS = {
  animated: false,
  limitInputPixels: MAX_IMAGE_INPUT_PIXELS,
  failOn: "warning"
};
```

Use it consistently:

```js
const preview = await sharp(filePath, SHARP_INPUT_OPTIONS)
  .rotate()
  .resize({
    width: TOOL_RESULT_IMAGE_PREVIEW_MAX_EDGE,
    height: TOOL_RESULT_IMAGE_PREVIEW_MAX_EDGE,
    fit: "inside",
    withoutEnlargement: true
  })
  .jpeg({ quality: 82, mozjpeg: true })
  .toBuffer();
```

```js
const base = sharp(input.path, SHARP_INPUT_OPTIONS).rotate();
```

### Acceptance checks

- No remaining `limitInputPixels: false` in the repository.
- A normal jpg/png/webp still transforms correctly.
- A very large decoded image fails with a clear tool error instead of exhausting memory.

## Priority 1: add metadata limits after `sharp().metadata()`

Even with a pixel limit, fail early with a user-facing error where possible.

After reading metadata in `runMediaTransform`, validate dimensions/pages:

```js
function assertImageMetadataSafe(metadata = {}) {
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  const pages = Number(metadata.pages || 1);
  if (!width || !height) throw new Error("unable to read image dimensions");
  if (width * height > MAX_IMAGE_INPUT_PIXELS) {
    throw new Error("image dimensions are too large; send a smaller image");
  }
  if (pages > 1) {
    throw new Error("animated/multipage images are not supported by this transform; send a still image");
  }
}
```

Call it immediately after metadata is available:

```js
const metadata = await base.clone().metadata();
assertImageMetadataSafe(metadata);
```

If GIF/WebP animation support is intentionally desired later, implement a separate bounded path. Do not silently decode arbitrary animation frames in the generic image transform.

## Priority 2: tighten audio/video probing limits

### Problem

`runAvMedia` currently allows up to 100 MB and has a 90s ffmpeg timeout. That is useful but coarse. A small file can still be too long, too high-resolution, or contain too many streams.

### Suggested limits

Add constants near the AV limits:

```js
const MAX_AV_DURATION_SECONDS = 180;
const MAX_AV_PIXELS = 1920 * 1080;
const MAX_AV_STREAMS = 8;
```

After `probeAv(input.path)` and `avSummary(meta)`, validate:

```js
function assertAvMetadataSafe(meta = {}, summary = {}) {
  const streams = Array.isArray(meta.streams) ? meta.streams : [];
  if (streams.length > MAX_AV_STREAMS) {
    throw new Error("media has too many streams");
  }

  const duration = Number(summary.duration || meta.format?.duration || 0);
  if (Number.isFinite(duration) && duration > MAX_AV_DURATION_SECONDS) {
    throw new Error("media duration is too long; send a shorter clip");
  }

  const width = Number(summary.width || 0);
  const height = Number(summary.height || 0);
  if (width > 0 && height > 0 && width * height > MAX_AV_PIXELS) {
    throw new Error("video resolution is too large; send a smaller clip");
  }
}
```

Call it before any transcode action:

```js
const meta = await probeAv(input.path);
const summary = avSummary(meta);
assertAvMetadataSafe(meta, summary);
if (action === "probe") return { action, input, meta, summary };
```

### Acceptance checks

- Short Telegram clips still work.
- Long/high-resolution videos fail before ffmpeg transcode.
- `probe` returns only for media that passes the same safety gate, unless you explicitly decide to allow probe-only over-limit media.

## Priority 3: make PDF render scale bounded before rendering

### Problem

The PDF renderer script renders each page with fixed `scale=2.0` and only thumbnails after rendering:

```py
pil = page.render(scale=2.0).to_pil().convert("RGB")
pil.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
```

A pathological page size can allocate too much memory before `thumbnail()` runs.

### Suggested change

Compute page dimensions before rendering and choose a bounded scale. Keep final output quality roughly similar for normal PDFs.

Sketch:

```py
def safe_render_scale(page, max_edge):
    width, height = page.get_size()
    longest = max(float(width), float(height), 1.0)
    # render somewhat larger than final thumbnail, but never absurdly large
    target = min(max_edge * 1.25, 2200)
    return max(0.2, min(2.0, target / longest))

for pno in pages:
    page = pdf[pno - 1]
    scale = safe_render_scale(page, max_edge)
    pil = page.render(scale=scale).to_pil().convert("RGB")
    pil.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
```

Also consider rejecting huge page counts or absurd page dimensions explicitly if `pypdfium2` exposes them cheaply.

### Acceptance checks

- Common PDFs still render clearly.
- Very large page-size PDFs fail or render at bounded memory.
- The 6-page maximum remains in place.

## Priority 4: verify installed native parser versions

The repo uses installer packages for ffmpeg/ffprobe in `plugins/imagebot-video-utils/package.json`:

```json
{
  "@ffmpeg-installer/ffmpeg": "^1.1.0",
  "@ffprobe-installer/ffprobe": "^2.1.2"
}
```

Codex should inspect the actual lockfile/runtime before changing this. The important thing is the binary version, not just npm package semver.

Add or run a diagnostic command:

```bash
node -e "console.log(require('@ffmpeg-installer/ffmpeg').path)"
node -e "console.log(require('@ffprobe-installer/ffprobe').path)"
ffmpeg -version
ffprobe -version
npm ls sharp @ffmpeg-installer/ffmpeg @ffprobe-installer/ffprobe
```

If the installer packages are stale or hard to update, prefer either:

- a known current ffmpeg binary shipped by the app/tooling;
- or a documented system ffmpeg dependency checked at startup.

Do not blindly bump without verifying Windows behavior.

## Priority 5: add regression tests for media safety gates

Add small tests around pure functions where possible:

- `assertImageMetadataSafe` rejects huge dimensions and multipage input.
- `assertAvMetadataSafe` rejects long duration, huge resolution, too many streams.
- `resolveAllowedBotFile` still rejects remote URLs and paths outside allowed media roots.
- `runProcess` / ffmpeg wrappers still use argument arrays, not shell strings.

If full integration media fixtures are annoying, add unit tests for metadata validation first. That alone prevents later regressions.

## Priority 6: sandbox or privilege-reduce media parsers when practical

This is optional but useful if the bot is exposed to semi-random users.

Preferred direction:

- Run OpenClaw/bot under a non-admin OS user.
- Keep media temp/output directories separate from source code and secrets.
- Avoid placing tokens/configs under allowed media roots.
- Consider a job-worker process for media parsing with lower privileges and stricter resource limits.
- If containerized later, give the media worker no Docker socket, no host mounts except media input/output, and no unnecessary network.

## Things not to do

- Do not accept arbitrary URLs in `media_transform`, `pdf_render`, or `av_media`.
- Do not switch from `spawn(command, args)` to `exec("...")` or shell-string commands.
- Do not add broad `allowedMediaRoots` pointing at the user home, project root, downloads directory, or desktop.
- Do not re-enable `limitInputPixels: false` to make one bad image pass.
- Do not treat file extension checks as sufficient magic-byte validation. Extension checks are useful but not a complete content-type proof.

## Suggested Codex prompt

Use this repository note as the source of truth. Implement media parser hardening in `plugins/imagebot-practical-tools/index.js` and `plugins/imagebot-video-utils/index.js` without changing public tool behavior except for rejecting oversized/pathological media earlier with clear errors.

Required changes:

1. Replace all `limitInputPixels: false` usage with a shared explicit sharp pixel limit.
2. Add image metadata safety validation.
3. Add AV metadata safety validation after ffprobe.
4. Make PDF rendering choose scale from page dimensions before rendering.
5. Add or update tests for the new validation helpers.
6. Keep all subprocess calls using argument arrays, not shell strings.

After implementation, run the existing test scripts from `package.json` if the environment supports them.
