# One-time setup: schedules the RimBlaze stats build.
#   - every 10 minutes from noon to 1:30 a.m. (live snapshot each time, full stats every 30 minutes)
#   - a full run at 4:17 a.m. after the last West Coast game
# Run from the repository folder:  powershell -ExecutionPolicy Bypass -File tools\setup-windows.ps1
# Running it again just updates the schedule. To remove it:
#   Unregister-ScheduledTask -TaskName 'RimBlaze nightly stats' -Confirm:$false

$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'run-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`"" -WorkingDirectory $repo

$gameNight = New-ScheduledTaskTrigger -Daily -At '12:00PM'
$gameNight.Repetition = (New-ScheduledTaskTrigger -Once -At '12:00PM' `
  -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Hours 13 -Minutes 30)).Repetition
$overnight = New-ScheduledTaskTrigger -Daily -At '4:17AM'

# WakeToRun wakes a sleeping PC; StartWhenAvailable catches up a missed run when the PC is back on;
# IgnoreNew skips a run if the previous one is still going.
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName 'RimBlaze nightly stats' -Action $action -Trigger @($gameNight, $overnight) `
  -Settings $settings -Description 'Builds RimBlaze stats from NBA.com and pushes them to GitHub (rimblaze.com).' -Force | Out-Null

$t = Get-ScheduledTask -TaskName 'RimBlaze nightly stats'
Write-Host "Scheduled: '$($t.TaskName)' ($($t.State))"
Write-Host "  - every 10 minutes from noon to 1:30 a.m. (live games every run, full stats every 30 minutes)"
Write-Host "  - every night at 4:17 a.m."
Write-Host "Your PC needs to be on or asleep (not shut down), with you signed in. Locked is fine."
