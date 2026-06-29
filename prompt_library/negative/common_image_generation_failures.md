---
id: negative.common_image_generation_failures
title: Common Image Generation Failures
type: negative
tags: image, negative, quality, prompt, text, layout, realism
aliases: negative_image, avoid_image_failures, common_image_failures, generation_failures
tools: image_generate
---

Use as a short targeted negative card when a request needs quality control.
Do not paste a giant universal negative list into every generation.

General avoid list:

- Blurry or low-detail subject.
- Wrong subject identity or wrong reference image identity.
- Cropped important body parts or product edges.
- Extra fingers, fused hands, floating objects, impossible grip.
- Unreadable tiny text, misspelled labels, random watermark-like marks.
- Cluttered layout, too many unrelated props, confusing focal point.
- Color used as the only meaning channel in diagrams.
- Over-smoothed skin, plastic texture, uncanny eyes for realistic portraits.
- Random style drift from an older unrelated image.

Use narrow negatives:

- For anime: wrong hair/eye color, random outfit, extra fingers.
- For photos: plastic skin, impossible shadows, fake camera artifacts.
- For academic figures: decorative clutter, tiny labels, invented data.
- For product assets: gibberish text, bad logo placement, warped packaging.

Source basis:

- InvokeAI warning to keep negatives short and targeted:
  https://invoke.ai/concepts/prompting-guide/
- Harvard data visualization accessibility notes:
  https://accessibility.huit.harvard.edu/data-viz-charts-graphs
