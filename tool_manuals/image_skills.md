---
id: image_skills
tools: image_skill_lookup, image_skill_save_reference, image_skill_note_preference, image_skill_recent, image_generate, download_image_url, web_image_search
keywords: image skill, character cache, reference cache, local reference, reuse reference, official character, style memory, 角色参考, 本地参考, 画过的角色, 角色缓存
when_to_read: Before generating a named character/style that may already have local references or when saving useful references/preferences for future image generation.
---

# Image Skills

## Purpose

Image skills are lightweight local notes for image generation. They store:

- character/style aliases;
- bot-local reference image paths;
- compact visual traits and style hints;
- lightweight per-user preferences.

They are not a heavy skill framework and do not replace `image_generate`.

## Lookup

Use `image_skill_lookup` before searching the web when the user asks for a named
character, repeated style, or subject the bot has drawn/referenced before.

Lookup uses aliases plus lightweight fuzzy/CJK token matching. Short Chinese
fragments such as a character nickname can match a saved skill if the alias was
stored before.

The result may include `MEDIA:` reference lines. Use those bot-local images as
generation references when they match the user's request.

If lookup is empty or unrelated, fall back to ordinary reference search.

## Save Reference

Use `image_skill_save_reference` after a reference image is clearly useful:

- official/canonical character art found and downloaded;
- user-supplied reference they want reused later;
- a generated result the user approves as a stable style/character reference.

Input must be bot-local media, not an external URL. The tool copies it into the
local skill store and deduplicates by hash.

## Preference Notes

Use `image_skill_note_preference` for compact, durable preferences:

- original outfit;
- sharper expression;
- avoid chibi;
- softer color;
- preferred aspect/composition.

Keep notes short and factual. Preferences guide future image prompts; they do
not override the user's current request.

## Recent

Use `image_skill_recent` for debugging or when the user asks what image skills
are currently saved.
