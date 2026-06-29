---
id: recipe.academic_figure
title: Academic Figure Or Scientific Diagram
type: recipe
tags: image, academic, scientific, figure, diagram, infographic, paper
aliases: academic_figure, scientific_figure, xueshutu, paper_diagram, teaching_diagram
tools: image_generate, prompt_library
---

Use for conceptual scientific figures, paper-style diagrams, visual abstracts,
lecture diagrams, explanatory infographics, and clean educational figures.

Prompt shape:

- Purpose and audience: paper figure, slide diagram, poster, visual abstract,
  classroom explanation, or grant summary.
- Main claim: one sentence describing what the figure should teach.
- Layout: panel count, reading order, arrows/flow, legend/callout locations,
  and whether it should be portrait, landscape, or square.
- Visual language: clean vector, restrained scientific illustration, flat
  schematic, limited palette, high contrast, readable labels.
- Labels: list exact short labels if text is required; keep label count small.
- Accessibility: direct labels where possible, color not as the only signal,
  sufficient contrast, generous white space.

Hard rules:

- Do not invent quantitative data, axis values, formulas, or citations.
- For exact charts from real data, use code/chart tooling first; use
  `image_generate` only for conceptual or illustrative diagrams.
- If exact text matters, keep text short and inspect the result before treating
  it as final.

Useful phrase:

"clean publication-style scientific schematic, one clear message, generous
white space, direct labels, high contrast, restrained palette, no decorative
clutter"

Source basis:

- OpenAI image prompting guide examples include infographics and educational
  diagrams:
  https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide
- Harvard data visualization accessibility:
  https://accessibility.huit.harvard.edu/data-viz-charts-graphs
- Ten Simple Rules for Better Figures:
  https://pmc.ncbi.nlm.nih.gov/articles/PMC4161295/
