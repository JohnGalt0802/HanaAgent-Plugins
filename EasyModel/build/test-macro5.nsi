!include "nsDialogs.nsh"
Var CheckHwnd
Function F
  !insertmacro NSD_CreateCheckbox 120u 122u 300u 14u "test"
  Pop $CheckHwnd
FunctionEnd
Function .onInit
FunctionEnd
