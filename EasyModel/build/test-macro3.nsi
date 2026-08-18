!include "MUI2.nsh"
!macro FooBar
  WriteRegStr HKCU "Software\Classes\test2" "" "x"
!macroend
Function F
  !insertmacro FooBar
FunctionEnd
Function .onInit
FunctionEnd
