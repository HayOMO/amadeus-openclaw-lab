---
id: recipe.photoreal_scene
title: Photoreal Scene Or Portrait
type: recipe
tags: image, photoreal, photo, portrait, sanciyuan, realistic
aliases: photoreal, real_photo, sanciyuan, portrait_photo, realistic_scene
tools: image_generate, image_skill_lookup, prompt_library
---

Use for realistic portraits, candid scenes, documentary images, product/lifestyle
photos, and "three-dimensional" / real-world looks.

Prompt shape:

- Say "photorealistic" or "real photograph" when realism matters.
- Subject and action: who/what, body framing, gaze, gesture, interaction with
  objects, scale relative to surroundings.
- Scene: location, time, weather, background activity, environmental details.
- Camera/composition: close-up, waist-up, full body, top-down, eye-level,
  low-angle, wide shot, shallow depth of field, flash, film-like grain.
- Lighting/color: soft window light, overcast daylight, golden hour, hard
  flash, neon, low-light, monochrome, etc.
- Constraints: no beauty-filter smoothness if natural skin texture is wanted;
  keep hands/objects physically plausible.

Use camera words as look cues, not strict physics. The model may follow the
visual intent better than exact lens math.

Useful phrase:

"photorealistic, real camera look, natural proportions, believable lighting,
grounded physical interaction, no plastic skin"

Source basis:

- OpenAI GPT Image Models Prompting Guide:
  https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide
- InvokeAI prompt workflow:
  https://invoke.ai/concepts/prompting-guide/
- Hugging Face Diffusers prompting guide:
  https://huggingface.co/docs/diffusers/en/using-diffusers/weighted_prompts
