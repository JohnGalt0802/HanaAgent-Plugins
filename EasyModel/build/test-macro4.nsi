!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"
Var CheckHwnd
Function F
  !insertmacro NSD_CreateCheckbox 120u 122u 300u 14u "??"
  Pop $CheckHwnd
  SendMessage $CheckHwnd 0x00F1 1 0
FunctionEnd
Function .onInit
FunctionEnd
