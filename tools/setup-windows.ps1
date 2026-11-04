# One-time setup: schedules the RimBlaze stats build (times are this PC's clock, meant to be Eastern).
#   - every 2 minutes, 7 p.m. to 2 a.m. Monday to Friday nights
#   - every 2 minutes, noon to 2 a.m. on Saturdays and Sundays
#     (live snapshot each run, full stats at most every 25 minutes)
#   - a full run at 4:17 a.m. after the last West Coast game
# Run from the repository folder:  powershell -ExecutionPolicy Bypass -File tools\setup-windows.ps1
# Running it again just updates the schedule. To remove it:
#   Unregister-ScheduledTask -TaskName 'RimBlaze nightly stats' -Confirm:$false

$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'run-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`"" -WorkingDirectory $repo

function GameWindow($days, $start, $hours) {
  $t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $days -At $start
  $t.Repetition = (New-ScheduledTaskTrigger -Once -At $start `
    -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Hours $hours)).Repetition
  return $t
}
$weeknights = GameWindow @('Monday','Tuesday','Wednesday','Thursday','Friday') '7:00PM' 7   # 7 p.m. to 2 a.m.
$weekends   = GameWindow @('Saturday','Sunday') '12:00PM' 14                               # noon to 2 a.m.
$overnight  = New-ScheduledTaskTrigger -Daily -At '4:17AM'

# WakeToRun wakes a sleeping PC; StartWhenAvailable catches up a missed run when the PC is back on;
# IgnoreNew skips a run if the previous one is still going.
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName 'RimBlaze nightly stats' -Action $action -Trigger @($weeknights, $weekends, $overnight) `
  -Settings $settings -Description 'Builds RimBlaze stats from NBA.com and pushes them to GitHub (rimblaze.com).' -Force | Out-Null

$t = Get-ScheduledTask -TaskName 'RimBlaze nightly stats'
Write-Host "Scheduled: '$($t.TaskName)' ($($t.State))"
Write-Host "  - every 2 minutes, 7 p.m. to 2 a.m. on weeknights"
Write-Host "  - every 2 minutes, noon to 2 a.m. on Saturdays and Sundays"
Write-Host "    (live games every run, full stats at most every 25 minutes)"
Write-Host "  - every night at 4:17 a.m."
$tz = (Get-TimeZone).Id
if ($tz -ne 'Eastern Standard Time') { Write-Host "NOTE: this PC's time zone is $tz, not Eastern. The times above follow this PC's clock." -ForegroundColor Yellow }
Write-Host "Your PC needs to be on or asleep (not shut down), with you signed in. Locked is fine."
