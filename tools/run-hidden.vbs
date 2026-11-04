' Starts the RimBlaze stats run with no window, so the half-hourly game-night runs
' don't flash a PowerShell window on screen. Task Scheduler calls this file.
Set fso = CreateObject("Scripting.FileSystemObject")
script = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "run-nightly.ps1")
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & script & """", 0, True
