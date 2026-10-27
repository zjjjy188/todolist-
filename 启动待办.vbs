Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir & "\node_modules\electron\dist\electron.exe"

On Error Resume Next
sh.Environment("Process")("ELECTRON_RUN_AS_NODE") = ""
On Error Goto 0

If Not fso.FileExists(exe) Then
  MsgBox "找不到程序文件。" & vbCrLf & "请把整个 TodoApp 文件夹一起发给对方，不要只发这一个启动器。", 16, "jiujiu 待办"
  WScript.Quit
End If

sh.Run """" & exe & """ """ & dir & """", 0, False
