---
id: recipe.image_editing_reference
title: Image Editing From Replied Media
type: recipe
tags: image, edit, reference, telegram, media
aliases: edit_image, replied_image_edit, reference_edit
tools: image, image_generate, media_artifact_lineage
---

Use when the user replies to an image or delivers an image and asks to modify,
redraw, continue, restyle, repair, or use it as reference.

Workflow:

1. Decide whether the user wants an edit/reference or a fresh generation.
2. If the wording means edit/reference, pass the current/replied media handle to
   `image_generate.image` or `image_generate.images`.
3. If the wording means fresh generation, do not pass previous images.
4. For a replied generated image, use lineage handles only when the user wants
   to redo from the original source rather than edit the generated output.

Prompt shape:

- Keep the original identity/composition only when requested.
- State exact changes first.
- Preserve untouched areas only when the user asks for preservation.
- Keep output count low unless the user requests variants.
