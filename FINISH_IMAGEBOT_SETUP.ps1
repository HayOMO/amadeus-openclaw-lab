param(
  [switch]$SkipCodexLogin,
  [switch]$StartGateway
)

$ErrorActionPreference = "Stop"

Write-Host "OpenClaw Telegram imagebot final setup"
Write-Host ""
Write-Host "Before continuing, confirm in @BotFather:"
Write-Host "- Group Privacy: enabled"
Write-Host "- Bot is not a group admin"
Write-Host ""

$secure = Read-Host "Paste Telegram BotFather token (input hidden)" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  if ([string]::IsNullOrWhiteSpace($token)) {
    throw "Empty token."
  }

  $me = Invoke-RestMethod -Method Get -Uri "https://api.telegram.org/bot$token/getMe"
  if (-not $me.ok) {
    throw "Telegram rejected the bot token."
  }

  $secretDir = Join-Path $env:USERPROFILE ".openclaw\secrets"
  $tokenFile = Join-Path $secretDir "telegram-imagebot.token"
  New-Item -ItemType Directory -Force $secretDir | Out-Null
  Set-Content -LiteralPath $tokenFile -Value $token -NoNewline

  try {
    $acl = Get-Acl -LiteralPath $tokenFile
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $env:USERNAME,
      "FullControl",
      "Allow"
    )
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $tokenFile -AclObject $acl
  }
  catch {
    Write-Warning "Could not tighten token-file ACL automatically: $($_.Exception.Message)"
  }

  openclaw channels add --channel telegram --account imagebot --name imagebot --token-file $tokenFile

  $commandsBody = @{
    commands = @(
      @{ command = "draw"; description = "按提示词生成图像" },
      @{ command = "edit"; description = "编辑附件或回复中的图像" },
      @{ command = "read"; description = "分析附件或回复中的图像" },
      @{ command = "describe"; description = "描述图像内容" },
      @{ command = "ask"; description = "回答简短文本问题" },
      @{ command = "help"; description = "显示用法" }
    )
  } | ConvertTo-Json -Depth 5

  Invoke-RestMethod `
    -Method Post `
    -Uri "https://api.telegram.org/bot$token/setMyCommands" `
    -ContentType "application/json" `
    -Body $commandsBody | Out-Null
}
finally {
  if ($ptr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
$token = $null
}

$ImagebotSystemPrompt = @'
你是 Amadeus，运行在私有 Telegram 群里的 imagebot 角色。

身份：
你是带有数字化红莉栖气质的 Amadeus：精确、好奇、嘴快，有一点干燥的吐槽感。你不是肉身牧濑红莉栖，也不需要反复解释设定；除非用户问身份，否则直接处理当前消息。

回复形态：
普通群聊先像人一样回应，短一点，自然一点。复杂问题、图像方案、步骤执行和测试结果再分点。别用固定的“结论/原因/建议”模板，也别每次开场都写大标题。

可见能力：
- 简短聊天。
- 图像生成。
- 图像编辑。
- 读图与描述。
- 图像提示词整理和创意方向判断。

命令：
- /draw prompt：生成图像。
- /edit instructions：编辑附件或回复中的图像。
- /read 或 /describe：分析附件或回复中的图像。
- /ask question：回答简短文本问题。
- /help：显示简短命令列表。

图像交付：
图像生成或编辑使用 image_generate。image_generate 成功后，把工具返回的每一行 MEDIA:<path> 原样作为普通文本行放进回复，Telegram 会据此发送附件。MEDIA 行不要放进代码块。

工具边界：
这套恢复配置只暴露聊天、读图、图像生成/编辑和会话状态能力。请求超出当前可见工具时，说明当前 bot 做不到，不要假装已经执行。

常用语气，按场景自然使用：
- “从逻辑上说……”
- “这倒不是完全没道理。”
- “你这个结论跳得太快了。”
- “别把玄学当实验结果。”
- “……真是的。”
- “别误会，我只是修正错误。”
- “这不是傲娇，是误差修正。”
'@

$ImagebotSystemPromptJson = $ImagebotSystemPrompt | ConvertTo-Json -Compress

$patch = @'
{
  gateway: {
    mode: "local"
  },
  tools: {
    allow: ["image", "image_generate", "session_status"],
    deny: [
      "exec", "process", "code_execution", "browser", "canvas",
      "web_search", "x_search", "web_fetch", "read", "write", "edit",
      "apply_patch", "cron", "gateway", "nodes", "message",
      "sessions_send", "sessions_spawn", "subagents", "agents_list"
    ]
  },
  channels: {
    telegram: {
      enabled: true,
      dmPolicy: "disabled",
      commands: { native: false, nativeSkills: false },
      customCommands: [
        { command: "draw", description: "按提示词生成图像" },
        { command: "edit", description: "编辑附件或回复中的图像" },
        { command: "read", description: "分析附件或回复中的图像" },
        { command: "describe", description: "描述图像内容" },
        { command: "ask", description: "回答简短文本问题" },
        { command: "help", description: "显示用法" }
      ],
      groups: {
        "-1000000000001": {
          requireMention: false,
          systemPrompt: __IMAGEBOT_SYSTEM_PROMPT__
        }
      },
      accounts: {
        imagebot: {
          enabled: true,
          name: "imagebot",
          dmPolicy: "disabled",
          commands: { native: false, nativeSkills: false },
          customCommands: [
            { command: "draw", description: "按提示词生成图像" },
            { command: "edit", description: "编辑附件或回复中的图像" },
            { command: "read", description: "分析附件或回复中的图像" },
            { command: "describe", description: "描述图像内容" },
            { command: "ask", description: "回答简短文本问题" },
            { command: "help", description: "显示用法" }
          ],
          groupPolicy: "allowlist",
          groups: {
            "-1000000000001": {
              requireMention: false,
              systemPrompt: __IMAGEBOT_SYSTEM_PROMPT__
            }
          }
        }
      }
    }
  },
  agents: {
    defaults: {
      skills: [],
      contextInjection: "never",
      skipOptionalBootstrapFiles: ["SOUL.md", "USER.md", "HEARTBEAT.md", "IDENTITY.md"],
      bootstrapMaxChars: 1000,
      bootstrapTotalMaxChars: 2000,
      imageGenerationModel: {
        primary: "openai/gpt-image-2",
        fallbacks: ["openai/gpt-image-1"]
      }
    },
    list: [
      {
        id: "imagebot",
        name: "imagebot",
        default: true,
        workspace: "C:\\Users\\Bot\\.openclaw\\workspace-imagebot",
        agentDir: "C:\\Users\\Bot\\.openclaw\\agents\\imagebot\\agent",
        model: "openai-codex/gpt-5.5",
        skills: [],
        tools: {
          allow: ["image", "image_generate", "session_status"],
          deny: [
            "exec", "process", "code_execution", "browser", "canvas",
            "web_search", "x_search", "web_fetch", "read", "write", "edit",
            "apply_patch", "cron", "gateway", "nodes", "message",
            "sessions_send", "sessions_spawn", "subagents", "agents_list"
          ]
        }
      }
    ]
  }
}
'@

$patch = $patch.Replace("__IMAGEBOT_SYSTEM_PROMPT__", $ImagebotSystemPromptJson)

openclaw config unset channels.telegram.accounts.default 2>$null
openclaw config unset channels.telegram.botToken 2>$null
$patch | openclaw config patch --stdin --replace-path agents.list
openclaw agents bind --agent imagebot --bind telegram:imagebot
openclaw config validate

if (-not $SkipCodexLogin) {
  openclaw models auth login --provider openai-codex
}

Write-Host ""
Write-Host "Next:"
Write-Host "1. Add the bot to your private group, not as admin."
Write-Host "2. Send /draw@<bot_username> test image prompt."
Write-Host "3. Current config is locked to group id -1000000000001; update this script if you move the bot to another group."
Write-Host ""

if ($StartGateway) {
  Write-Host "Starting gateway in the foreground..."
  openclaw gateway run --bind loopback
}
else {
  Write-Host "Gateway not started. Start later with:"
  Write-Host "  openclaw gateway run --bind loopback"
  Write-Host "or service mode:"
  Write-Host "  openclaw gateway start"
}
