Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = scriptDir & "\start-bot.bat"
WshShell.CurrentDirectory = scriptDir
WshShell.Run "cmd.exe /c """ & batPath & """", 0, False
