!include "nsDialogs.nsh"
!include "WinMessages.nsh"
!include "MUI2.nsh"

Var EasyModelDefaultCheck

!macro SetDefaultModelForExt EXT
  WriteRegStr HKCU "Software\Classes\${EXT}" "" "EasyModel 模型"
!macroend

Function EasyModelFinishShow
  ${NSD_CreateCheckbox} 120u 122u 300u 14u "测试复选框"
  Pop $EasyModelDefaultCheck
FunctionEnd

Function EasyModelFinishLeave
  SendMessage $EasyModelDefaultCheck ${BM_GETCHECK} 0 0 $0
  IntCmp $0 ${BST_CHECKED} 0 finishDone setDefault
  setDefault:
    ${SetDefaultModelForExt} ".stl"
  finishDone:
FunctionEnd

Function .onInit
FunctionEnd
