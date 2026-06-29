param(
  [ValidateSet("status", "play", "pause", "toggle", "next", "previous", "stop")]
  [string]$Action = "status",

  [ValidateSet("current", "netease", "any")]
  [string]$Target = "current"
)

$ErrorActionPreference = "Stop"

function Write-JsonResult {
  param([Parameter(Mandatory = $true)] [object]$Value)
  $Value | ConvertTo-Json -Depth 8 -Compress
}

function Await-AsyncOperation {
  param(
    [Parameter(Mandatory = $true)] [object]$Operation,
    [Parameter(Mandatory = $true)] [type]$ResultType
  )

  $methods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and
    $_.IsGenericMethodDefinition -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  }

  if (-not $methods -or $methods.Count -lt 1) {
    throw "System.WindowsRuntimeSystemExtensions.AsTask(IAsyncOperation<T>) was not found"
  }

  $task = $methods[0].MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  return $task.GetAwaiter().GetResult()
}

function Convert-TimeSpanSeconds {
  param([object]$Value)
  try {
    if ($null -eq $Value) { return $null }
    return [math]::Round(([TimeSpan]$Value).TotalSeconds, 3)
  } catch {
    return $null
  }
}

function Read-MediaProperties {
  param([Parameter(Mandatory = $true)] [object]$Session)

  $mediaType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  try {
    $props = Await-AsyncOperation -Operation $Session.TryGetMediaPropertiesAsync() -ResultType $mediaType
    if ($null -eq $props) { return $null }
    $artists = @()
    try { $artists = @($props.Artist) } catch { $artists = @() }
    return [ordered]@{
      title = [string]$props.Title
      artist = [string]$props.Artist
      albumTitle = [string]$props.AlbumTitle
      albumArtist = [string]$props.AlbumArtist
      trackNumber = $props.TrackNumber
    }
  } catch {
    return [ordered]@{
      error = $_.Exception.Message
    }
  }
}

function New-SessionView {
  param([Parameter(Mandatory = $true)] [object]$Session)

  $source = ""
  try { $source = [string]$Session.SourceAppUserModelId } catch {}

  $playbackStatus = ""
  $controls = [ordered]@{}
  try {
    $playback = $Session.GetPlaybackInfo()
    if ($null -ne $playback) {
      $playbackStatus = [string]$playback.PlaybackStatus
      if ($null -ne $playback.Controls) {
        $controls = [ordered]@{
          play = [bool]$playback.Controls.IsPlayEnabled
          pause = [bool]$playback.Controls.IsPauseEnabled
          stop = [bool]$playback.Controls.IsStopEnabled
          next = [bool]$playback.Controls.IsNextEnabled
          previous = [bool]$playback.Controls.IsPreviousEnabled
          seek = [bool]$playback.Controls.IsPlaybackPositionEnabled
        }
      }
    }
  } catch {}

  $timeline = [ordered]@{}
  try {
    $time = $Session.GetTimelineProperties()
    if ($null -ne $time) {
      $timeline = [ordered]@{
        positionSeconds = Convert-TimeSpanSeconds $time.Position
        startSeconds = Convert-TimeSpanSeconds $time.StartTime
        endSeconds = Convert-TimeSpanSeconds $time.EndTime
        minSeekSeconds = Convert-TimeSpanSeconds $time.MinSeekTime
        maxSeekSeconds = Convert-TimeSpanSeconds $time.MaxSeekTime
      }
    }
  } catch {}

  return [ordered]@{
    sourceAppUserModelId = $source
    playbackStatus = $playbackStatus
    media = Read-MediaProperties -Session $Session
    controls = $controls
    timeline = $timeline
  }
}

function Test-NeteaseSession {
  param([Parameter(Mandatory = $true)] [object]$View)

  $haystack = @(
    $View.sourceAppUserModelId
    $View.media.title
    $View.media.artist
    $View.media.albumTitle
  ) -join "`n"

  return $haystack -match "(?i)(netease|cloudmusic|cloud music|orpheus)"
}

function Find-SelectedSession {
  param(
    [Parameter(Mandatory = $true)] [object]$Manager,
    [Parameter(Mandatory = $true)] [string]$Target
  )

  $current = $Manager.GetCurrentSession()
  if ($Target -eq "current") {
    if ($null -eq $current) { return $null }
    return [ordered]@{ session = $current; view = New-SessionView -Session $current }
  }

  if ($Target -eq "any") {
    if ($null -ne $current) { return [ordered]@{ session = $current; view = New-SessionView -Session $current } }
    foreach ($session in @($Manager.GetSessions() | ForEach-Object { $_ })) {
      return [ordered]@{ session = $session; view = New-SessionView -Session $session }
    }
    return $null
  }

  if ($Target -eq "netease") {
    if ($null -ne $current) {
      $currentView = New-SessionView -Session $current
      if (Test-NeteaseSession -View $currentView) {
        return [ordered]@{ session = $current; view = $currentView }
      }
    }
    foreach ($session in @($Manager.GetSessions() | ForEach-Object { $_ })) {
      $view = New-SessionView -Session $session
      if (Test-NeteaseSession -View $view) {
        return [ordered]@{ session = $session; view = $view }
      }
    }
  }

  return $null
}

function Invoke-MediaAction {
  param(
    [Parameter(Mandatory = $true)] [object]$Session,
    [Parameter(Mandatory = $true)] [string]$Action
  )

  if ($Action -eq "play") {
    return Await-AsyncOperation -Operation $Session.TryPlayAsync() -ResultType ([bool])
  }
  if ($Action -eq "pause") {
    return Await-AsyncOperation -Operation $Session.TryPauseAsync() -ResultType ([bool])
  }
  if ($Action -eq "next") {
    return Await-AsyncOperation -Operation $Session.TrySkipNextAsync() -ResultType ([bool])
  }
  if ($Action -eq "previous") {
    return Await-AsyncOperation -Operation $Session.TrySkipPreviousAsync() -ResultType ([bool])
  }
  if ($Action -eq "stop") {
    return Await-AsyncOperation -Operation $Session.TryStopAsync() -ResultType ([bool])
  }
  if ($Action -eq "toggle") {
    $status = ""
    try { $status = [string]$Session.GetPlaybackInfo().PlaybackStatus } catch {}
    if ($status -eq "Playing") {
      return Await-AsyncOperation -Operation $Session.TryPauseAsync() -ResultType ([bool])
    }
    return Await-AsyncOperation -Operation $Session.TryPlayAsync() -ResultType ([bool])
  }

  throw "Unsupported media action: $Action"
}

try {
  if ($env:OS -notmatch "Windows") {
    Write-JsonResult ([ordered]@{
      ok = $false
      status = "unsupported_platform"
      action = $Action
      target = $Target
      error = "Windows media session control is only available on Windows."
    })
    exit 0
  }

  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $manager = Await-AsyncOperation -Operation $managerType::RequestAsync() -ResultType $managerType
  $sessionObjects = @($manager.GetSessions() | ForEach-Object { $_ })
  $sessions = @($sessionObjects | ForEach-Object { New-SessionView -Session $_ })
  $current = $manager.GetCurrentSession()
  $currentView = $null
  if ($null -ne $current) {
    $currentView = New-SessionView -Session $current
  }

  if ($Action -eq "status") {
    Write-JsonResult ([ordered]@{
      ok = $true
      status = "ok"
      action = $Action
      target = $Target
      sessionCount = $sessions.Count
      current = $currentView
      sessions = $sessions
    })
    exit 0
  }

  $selected = Find-SelectedSession -Manager $manager -Target $Target
  if ($null -eq $selected) {
    Write-JsonResult ([ordered]@{
      ok = $false
      status = "no_session"
      action = $Action
      target = $Target
      sessionCount = $sessions.Count
      sessions = $sessions
      error = "No matching Windows media session was found."
    })
    exit 0
  }

  $success = Invoke-MediaAction -Session $selected.session -Action $Action
  Start-Sleep -Milliseconds 120

  Write-JsonResult ([ordered]@{
    ok = [bool]$success
    status = $(if ($success) { "ok" } else { "not_available" })
    action = $Action
    target = $Target
    selected = New-SessionView -Session $selected.session
    operation = [ordered]@{
      success = [bool]$success
    }
  })
} catch {
  Write-JsonResult ([ordered]@{
    ok = $false
    status = "failed"
    action = $Action
    target = $Target
    error = $_.Exception.Message
  })
  exit 0
}
