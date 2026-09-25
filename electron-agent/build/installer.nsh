!macro customInit
  nsExec::ExecToLog 'sc.exe stop RemoteCodexAgentService'
  Sleep 3000
!macroend

!macro customInstall
  nsExec::ExecToLog 'sc.exe config RemoteCodexAgentService start= delayed-auto'
  nsExec::ExecToLog 'sc.exe start RemoteCodexAgentService'
!macroend

!macro customUnInstallCheck
  nsExec::ExecToLog 'sc.exe stop RemoteCodexAgentService'
  Sleep 3000
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'sc.exe stop RemoteCodexAgentService'
  Sleep 2000
  nsExec::ExecToLog 'sc.exe delete RemoteCodexAgentService'
  SetShellVarContext all
  RMDir /r "$APPDATA\Remote Codex Agent"
!macroend
