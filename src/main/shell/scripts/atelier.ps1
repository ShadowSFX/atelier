# Atelier shell integration for Windows PowerShell 5.1 and PowerShell 7.
# Dot-sourced after the user's profile. ASCII only: PowerShell 5.1 reads BOM-less scripts in the ANSI code page.
# Powerline prompt ported from RDMan's SSH session prompt.

if ($global:__AtelierLoaded) { return }
$global:__AtelierLoaded = $true

try {
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [Console]::OutputEncoding = $utf8
  [Console]::InputEncoding = $utf8
  $global:OutputEncoding = $utf8
} catch { }

if ($env:ATELIER_CWD) {
  try { Set-Location -LiteralPath $env:ATELIER_CWD -ErrorAction Stop } catch { }
  Remove-Item Env:ATELIER_CWD -ErrorAction SilentlyContinue
}

$global:__Atelier = @{
  E = [string][char]27
  Bel = [string][char]7
  Arrow = [string][char]0xE0B0
  Thin = [string][char]0xE0B1
  Branch = [string][char]0xE0A0
  Cross = [string][char]0x2718
  Clock = [string][char]0xF017
  More = [string][char]0x2026
  LastHistory = $(Get-History -Count 1).Id
  HasGit = [bool](Get-Command git -CommandType Application -ErrorAction SilentlyContinue)
  Host = $env:COMPUTERNAME
  IsAdmin = $false
  UserPrompt = $function:prompt
}
try {
  $__id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $global:__Atelier.IsAdmin = (New-Object Security.Principal.WindowsPrincipal $__id).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

# ANSI index 0-15 -> SGR code (foreground 30-37/90-97, background 40-47/100-107): the prompt follows the scheme.
function global:__AtelierSgr([int]$index, [bool]$background) {
  $base = if ($background) { 40 } else { 30 }
  if ($index -gt 7) { $base += 60 }
  return $base + ($index % 8)
}

# Appends one powerline segment to $st (a hashtable: ps = text so far, bg = last background or -1).
function global:__AtelierSeg($st, [int]$bg, [int]$fg, [string]$text) {
  $e = $global:__Atelier.E
  if ($st.bg -ge 0) {
    $st.ps += "$e[$(__AtelierSgr $st.bg $false);$(__AtelierSgr $bg $true)m" + $global:__Atelier.Arrow
  }
  $st.ps += "$e[$(__AtelierSgr $fg $false);$(__AtelierSgr $bg $true)m $text "
  $st.bg = $bg
}

# file://host/C:/x or file://host//server/share/x (UNC), each segment percent-encoded.
function global:__AtelierUrl([string]$path) {
  $p = $path -replace '\\', '/'
  if ($p -notmatch '^/') { $p = '/' + $p }
  $segments = $p.Split('/') | ForEach-Object { [Uri]::EscapeDataString($_) -replace '%3A', ':' }
  return 'file://' + $global:__Atelier.Host + ($segments -join '/')
}

function global:__AtelierPowerline([string]$location, [int]$exit, $elapsed) {
  $a = $global:__Atelier
  $st = @{ ps = ''; bg = -1; branch = '' }

  if ($a.IsAdmin) { __AtelierSeg $st 1 15 $env:USERNAME } else { __AtelierSeg $st 8 15 $env:USERNAME }
  __AtelierSeg $st 0 7 $a.Host
  if ($env:VIRTUAL_ENV) { __AtelierSeg $st 6 0 (Split-Path -Leaf $env:VIRTUAL_ENV) }

  $userHome = $env:USERPROFILE
  $rest = ''
  if ($userHome -and $location.Equals($userHome, [StringComparison]::OrdinalIgnoreCase)) {
    __AtelierSeg $st 4 0 '~'
  } elseif ($userHome -and $location.StartsWith($userHome + '\', [StringComparison]::OrdinalIgnoreCase)) {
    __AtelierSeg $st 4 0 '~'
    $rest = $location.Substring($userHome.Length + 1)
  } elseif ($location -match '^(\\\\[^\\]+\\[^\\]+)\\?(.*)$') {
    __AtelierSeg $st 4 0 $Matches[1]
    $rest = $Matches[2]
  } elseif ($location -match '^([A-Za-z]:)\\?(.*)$') {
    __AtelierSeg $st 4 0 $Matches[1]
    $rest = $Matches[2]
  } else {
    __AtelierSeg $st 4 0 $location
  }
  if ($rest) {
    $parts = @($rest.Split('\') | Where-Object { $_ })
    if ($parts.Count -gt 3) { $parts = @($a.More) + $parts[-2..-1] }
    __AtelierSeg $st 0 15 ($parts -join " $($a.Thin) ")
  }

  if ($a.HasGit) {
    $status = & git --no-optional-locks status --porcelain=v2 --branch --untracked-files=no 2>$null
    if ($LASTEXITCODE -eq 0 -and $status) {
      $branch = $null; $oid = $null; $dirty = $false
      foreach ($line in @($status)) {
        if ($line.StartsWith('# branch.head ')) { $branch = $line.Substring(14) }
        elseif ($line.StartsWith('# branch.oid ')) { $oid = $line.Substring(13) }
        elseif ($line -and -not $line.StartsWith('#')) { $dirty = $true }
      }
      if ($branch -eq '(detached)' -and $oid) { $branch = $oid.Substring(0, [Math]::Min(7, $oid.Length)) }
      $st.branch = $branch
      if ($branch) {
        if ($dirty) { __AtelierSeg $st 3 0 "$($a.Branch) $branch *" } else { __AtelierSeg $st 2 0 "$($a.Branch) $branch" }
      }
    }
  }

  if ($exit -ne 0) { __AtelierSeg $st 1 15 "$($a.Cross) $exit" }
  if ($null -ne $elapsed -and $elapsed -ge 2) { __AtelierSeg $st 5 0 "$($a.Clock) $($elapsed)s" }
  if ($a.IsAdmin) { __AtelierSeg $st 8 15 '#' } else { __AtelierSeg $st 8 15 '$' }

  $e = $a.E
  # The branch, for Atelier's sidebar (VS Code's property sequence).
  $props = "$e]633;P;GitBranch=$($st.branch)$($a.Bel)"
  return $props + $st.ps + "$e[0;$(__AtelierSgr $st.bg $false)m" + $a.Arrow + "$e[0m "
}

function global:prompt {
  # $? must be read first: anything else overwrites it.
  $ok = $?
  $code = $global:LASTEXITCODE
  $a = $global:__Atelier
  $e = $a.E
  $bel = $a.Bel

  $last = Get-History -Count 1
  $ran = $last -and $last.Id -ne $a.LastHistory
  $elapsed = $null
  $exit = 0
  if ($ran) {
    $a.LastHistory = $last.Id
    $elapsed = [int][Math]::Floor(($last.EndExecutionTime - $last.StartExecutionTime).TotalSeconds)
    if (-not $ok) { $exit = if ($code -and $code -ne 0) { $code } else { 1 } }
  }

  $out = ''
  if ($ran) { $out += "$e]133;D;$exit$bel" }
  $loc = $ExecutionContext.SessionState.Path.CurrentLocation
  $fs = $loc.Provider.Name -eq 'FileSystem'
  if ($fs) { $out += "$e]7;$(__AtelierUrl $loc.ProviderPath)$bel" }
  $out += "$e]133;A$bel"

  if ($env:ATELIER_POWERLINE) {
    $location = if ($fs) { $loc.ProviderPath } else { $loc.Path }
    $out += __AtelierPowerline $location $exit $elapsed
  } elseif ($a.UserPrompt) {
    $out += [string](& $a.UserPrompt)
  } else {
    $out += "PS $($loc.Path)> "
  }
  $out += "$e]133;B$bel"

  $global:LASTEXITCODE = $code
  return $out
}

# `claude` inside Atelier talks to the sessions of this project only (see the Atelier hub).
# --mcp-config takes several values: --settings after it ends that list, so a prompt or a subcommand (attach) isn't
# read as one more config file.
if ($env:ATELIER_CLAUDE_SETTINGS) {
  function global:claude {
    $exe = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $exe) { Write-Error 'claude: command not found'; return }
    $passthrough = @('mcp', 'config', 'update', 'doctor', 'install', 'plugin', 'setup-token', 'migrate-installer', '-v', '--version', '-h', '--help')
    if ($args.Count -gt 0 -and $passthrough -contains $args[0]) {
      & $exe.Source @args
    } else {
      & $exe.Source --mcp-config $env:ATELIER_CLAUDE_MCP --settings $env:ATELIER_CLAUDE_SETTINGS @args
    }
  }
}
