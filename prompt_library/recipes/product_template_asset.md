---
id: recipe.product_template_asset
title: Product Template Or Marketing Asset
type: recipe
tags: image, template, product, ad, poster, mockup, layout, text
aliases: product_mockup, marketing_asset, template_image, poster_template, commercial_asset
tools: image_generate, prompt_library
---

Use for reusable template-like images: product shots, ad concepts, brochure
panels, social posts, UI mockups, thumbnails, packaging directions, and branded
layout drafts.

Prompt shape:

- Asset purpose and format: product hero, square social tile, widescreen banner,
  brochure panel, UI mockup, package label, poster, thumbnail.
- Product/object: exact visible object, materials, finish, scale, and use case.
- Layout zones: where title, subtitle, logo, CTA, product, annotations, or empty
  space should sit.
- Brand feel: restrained/minimal, luxury, playful, technical, editorial,
  nostalgic, cyberpunk, clean SaaS, etc.
- Text: keep it short and list exact wording. Ask for blank space instead when
  the final text will be added elsewhere.
- Output: transparent background only for icons/cutouts/stickers; otherwise use
  an opaque composition.

Avoid:

- Asking for too many text blocks in one image.
- Mixing incompatible design systems.
- Using one-note palettes unless the brand requires it.
- Treating generated mockup text as final without inspection.

Source basis:

- OpenAI image model prompting guide production examples:
  https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide
- OpenAI image API parameters for quality, size, format, and transparency:
  https://developers.openai.com/api/reference/resources/images/methods/generate
- Midjourney parameter docs as a mature pattern for putting format controls
  outside the descriptive core:
  https://docs.midjourney.com/hc/en-us/articles/32859204029709-Parameter-List
