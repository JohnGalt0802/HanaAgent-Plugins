!include "MUI2.nsh"

!macro FooNoArg
  WriteRegStr HKCU "Software\Classes\test1" "" "x"
!macroend

!macro FooNumArg
  WriteRegStr HKCU "Software\Classes\${1}" "" "x"
!macroend

!macro FooNamedArg EXT
  WriteRegStr HKCU "Software\Classes\${EXT}" "" "x"
!macroend

Function F
  ${FooNoArg}
  ${FooNumArg} ".stl"
  ${FooNamedArg} ".obj"
FunctionEnd

Function .onInit
FunctionEnd
