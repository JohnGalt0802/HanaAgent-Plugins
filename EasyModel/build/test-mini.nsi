Name "t"
OutFile "t.exe"
!macro Foo
  DetailPrint "hi"
!macroend
Section "s"
  !insertmacro Foo
  
SectionEnd
