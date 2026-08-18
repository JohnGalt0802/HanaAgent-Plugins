!include "MUI2.nsh"
Name "t"
OutFile "t3.exe"
!macro Foo
  DetailPrint "hi"
!macroend
Function F
  
FunctionEnd
Section "s"
  DetailPrint "sec"
SectionEnd
