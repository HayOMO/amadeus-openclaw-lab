# 图像生成路由技能

`/ask`、`/draw`、`/edit` 图片回合的内部手册。不要把这些机制暴露给用户。

## 核心

`/ask` 是统一入口：根据当前文本和已发送/回复媒体，判断这是普通聊天、图片阅读、图片编辑/引用，还是新图生成。

用户可能把生成后端叫作 “image2”、“gpt-image-2”、“image model”、“生图模型”等。在这个 bot 里，这些都指可见的 `image_generate` 工具。`image_generate` 可用时就用它；不要因为工具名不同就说没有 image2 工具。`image` 工具只分析图片，绝不能当生成后端。

默认生成是无状态的。不要继承旧提示词、旧生成图、旧参考图、旧风格，或另一个参与者的图片上下文，除非当前回合明确指向它们。

优先做一次模型决策和一次 `image_generate` 调用。只有搜索/参考能明显提升结果时才用。

## 质量和尺寸

贴近 ChatGPT 网页默认：用户没有明确要求质量、速度或格式限制时，不设置 `quality`、`size` 或 `resolution`。

- 用户要求 fast/draft/quick/low-cost/极速/草稿时，用较低或 provider-auto 质量和正常较小尺寸。
- 用户要求 high quality/final/refined/wallpaper/高清/精修/壁纸时，设置 `quality: high` 和合适的画幅/尺寸。
- 其它情况不传 quality/size，让 `gpt-image-2` 使用默认。
- 只有用户要求构图/画幅，或提示词强烈暗示时，才设置 `aspectRatio`。

## 本地/Telegram 图片

只有当前文本明确要求编辑、使用或参考某张可用图片时，才传 Telegram/本地图片路径。

优先级：

1. 用户指向回复图片时，用 `ReplyMediaPaths`。
2. 用户指向当前附件时，用 `CurrentMediaPaths`。
3. 只有明确出现 previous/above/last/that image、上一张、上面、刚才、那张、原图、参考上面那张、改刚才那张时，才用 `WindowRecentMediaPaths`。

“重新画”“再画一张”“画另一张”“新图”“start over” 这种新图措辞默认是纯提示词生成，除非明确点名某张图。

## 公共/具名主体

遇到具名角色、IP、产品、地点、梗、公众人物、品牌、logo、艺术作品、当前趋势或不熟悉的视觉主体：

- `web_search` 可用时，优先用它生成紧凑的规范信息；不可用、空结果或不可见时，用模型知识，或一个可见公共搜索后备，如 `explicit_web_text_search`、`web_image_search`、`zhihu_global_search`、`browser`。
- 优先官方/规范事实：来源标题、服装、颜色、轮廓、配饰、常见错误。
- 用户要求视觉参考、主体可能不熟、或视觉还原要求高时，用 `web_image_search`。先看返回的可见预览，优先使用其中的 `localMedia` 路径。
- 搜索得到的公共图片 URL 必须先变成本地 MEDIA 路径。`web_image_search` 没给有用候选的 `localMedia` 时，用 `download_image_url`，看返回预览，再把本地 MEDIA 路径传给 `image_generate.images`。
- 默认不要用 `image` 检查网页图片候选；只有有歧义或严格准确性值得这点延迟时才检查。

## 工具契约

- 新原创图：只用 prompt 调 `image_generate`。
- 编辑/引用可用图片：只传明确被回复、当前、或当前回合点名的近期图片。
- 公共参考图：检查返回预览，传本地 MEDIA 路径。
- 用户说 draw/generate/make/paint、生图、画一张、给 image2 生成：调 `image_generate`，不是 `image`。
- 除非当前回合明确要求，不传旧媒体、旧生成图或旧提示词。
- 除非用户明确要求质量、速度或格式限制，不传 `quality`、`size` 或 `resolution`。
- 每个请求最多调用一次 `image_generate`。
- 生成失败、中止或超时时，只有同一批本地参考图仍然必要且失败像传输/输入交付问题时才重试一次。否则简短回复。
- 成功后，把每一条返回的 `MEDIA:<path>` 原样作为普通行放进最终回复，让 Telegram 附上结果。
