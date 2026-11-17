<#
 Installs the RM print agent as a Windows scheduled task that starts at boot and restarts on failure.
 Requirements: Node.js 20+ installed, this folder copied to the machine, run PowerShell as Administrator:
   .\install-windows.ps1 -ApiUrl "https://api.example.com/api/v1" -Token "rmagt_..."
 Remove with: Unregister-ScheduledTask -TaskName "RM Print Agent" -Confirm:$false
#>
param(
  [Parameter(Mandatory = $true)][string]$ApiUrl,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$TaskName = "RM Print Agent"
)
$ErrorActionPreference = "Stop"
$node = (Get-Command node -ErrorAction Stop).Source
$agent = Join-Path $PSScriptRoot "src\agent.js"
$wrapper = Join-Path $PSScriptRoot "run-agent.cmd"

# Credentials live in a wrapper readable only by SYSTEM and Administrators.
@"
@echo off
set RM_API_URL=$ApiUrl
set RM_AGENT_TOKEN=$Token
"$node" "$agent"
"@ | Set-Content -Path $wrapper -Encoding ASCII
icacls $wrapper /inheritance:r /grant:r "SYSTEM:(R)" "Administrators:(F)" | Out-Null

$action = New-ScheduledTaskAction -Execute $wrapper
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Task '$TaskName' installed and started."
