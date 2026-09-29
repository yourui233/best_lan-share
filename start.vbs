' lan-share - start the server in a hidden window (Windows)
'
' Double-click this file, or drop a shortcut to it into
'   shell:startup
' to launch the share server automatically at logon.
'
' Everything is resolved relative to THIS file, so the folder can live anywhere.
Option Explicit

Dim fso, sh, here, nodeExe, serverJs, shareDir, dataDir, port

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)

' Use a full path if node.exe is not on your PATH, e.g.
'   nodeExe = "C:\Program Files\nodejs\node.exe"
nodeExe = "node.exe"

serverJs = fso.BuildPath(here, "share-server.js")
shareDir = fso.BuildPath(here, "shared")          ' the folder that gets served
dataDir  = fso.BuildPath(here, "shared-data")     ' bookkeeping, kept OUTSIDE the share
port     = "8080"

sh.CurrentDirectory = here
' 0 = hidden window, False = do not wait
sh.Run """" & nodeExe & """ """ & serverJs & """ """ & shareDir & """ " & port & " """ & dataDir & """", 0, False
