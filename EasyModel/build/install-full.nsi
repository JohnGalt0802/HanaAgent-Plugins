; EasyModel 完整安装器（独立 NSIS 脚本，不依赖 electron-builder 生成）
Unicode true
!include "MUI2.nsh"

Name "EasyModel"
OutFile "C:\HanaAgentWorks\stl-viewer-app\release\EasyModel-1.1.0-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\EasyModel"
InstallDirRegKey HKCU "Software\EasyModel" "InstallDir"
RequestExecutionLevel user

!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
; 自定义完成页：复选框（设为默认打开方式）
Page custom EasyModelFinishShow EasyModelFinishLeave "安装完成"
!insertmacro MUI_LANGUAGE "SimpChinese"

Var EasyModelDefaultCheck

; ================= 宏：注册/注销文件关联 =================
!macro RegisterExt EXT
  WriteRegStr HKCU "Software\Classes\${EXT}" "" "EasyModel 模型"
  WriteRegStr HKCU "Software\Classes\EasyModel 模型\DefaultIcon" "" "$INSTDIR\EasyModel.exe,0"
  WriteRegStr HKCU "Software\Classes\EasyModel 模型\shell\open\command" "" '"$INSTDIR\EasyModel.exe" "%1"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\OpenWithProgids" "EasyModel 模型" 0
!macroend

!macro UnregisterExt EXT
  ; 默认值若指向我们才删除（StrCmp 不等时跳到下一行，即跳过删除）
  ReadRegStr $0 HKCU "Software\Classes\${EXT}" ""
  StrCmp $0 "EasyModel 模型" 0 +2
  DeleteRegValue HKCU "Software\Classes\${EXT}" ""
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\OpenWithProgids" "EasyModel 模型"
!macroend

!macro SetDefaultModelForExt EXT
  ; 删除用户级锁定（UserChoice），让系统回落到我们的 ProgID
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\UserChoice"
  WriteRegStr HKCU "Software\Classes\${EXT}" "" "EasyModel 模型"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\OpenWithProgids" "EasyModel 模型" 0
!macroend

; ================= 自定义完成页（复选框） =================
Function EasyModelFinishShow
  ; 用 MapDialogRect 把 DLU 坐标转像素，精确放在完成页按钮上方
  System::Alloc 16
  Pop $1
  System::Call "*$1(i 120, i 118, i 400, i 14)"
  System::Call "user32::MapDialogRect(p $HWNDPARENT, i $1)"
  System::Call "*$1(i .r2, i .r3, i .r4, i .r5)"
  System::Free $1
  ; WS_CHILD(0x40000000) | WS_VISIBLE(0x10000000) | BS_AUTOCHECKBOX(0x3)
  System::Call 'user32::CreateWindowEx(i 0, t "BUTTON", t "将 EasyModel 设为 STL / OBJ / PLY / GLB / 3MF / STEP / IGES 的默认打开方式", i 0x50000003, i r2, i r3, i r4, i r5, p $HWNDPARENT, i 1001, p 0, p 0) p .r0'
  StrCpy $EasyModelDefaultCheck $0
  System::Call 'user32::SendMessage(p r0, i 0x00F1, i 1, i 0)'
FunctionEnd

Function EasyModelFinishLeave
  ; 复选框：设为默认打开方式
  System::Call 'user32::SendMessage(p $EasyModelDefaultCheck, i 0x00F0, i 0, i 0) i .r0'
  IntCmp $0 1 0 finishDone setDefault
  setDefault:
    !insertmacro SetDefaultModelForExt ".stl"
    !insertmacro SetDefaultModelForExt ".obj"
    !insertmacro SetDefaultModelForExt ".ply"
    !insertmacro SetDefaultModelForExt ".glb"
    !insertmacro SetDefaultModelForExt ".gltf"
    !insertmacro SetDefaultModelForExt ".3mf"
    !insertmacro SetDefaultModelForExt ".step"
    !insertmacro SetDefaultModelForExt ".stp"
    !insertmacro SetDefaultModelForExt ".iges"
    !insertmacro SetDefaultModelForExt ".igs"
    DeleteRegKey HKCU "Software\Classes\EasySTL STL 模型"
  finishDone:
FunctionEnd

; ================= 安装 =================
Section "安装" SEC_MAIN
  SetOutPath "$INSTDIR"
  File /r "C:\HanaAgentWorks\stl-viewer-app\release\win-unpacked\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; 快捷方式
  CreateDirectory "$SMPROGRAMS\EasyModel"
  CreateShortCut "$SMPROGRAMS\EasyModel\EasyModel.lnk" "$INSTDIR\EasyModel.exe"
  CreateShortCut "$DESKTOP\EasyModel.lnk" "$INSTDIR\EasyModel.exe"

  ; 卸载信息
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EasyModel" "DisplayName" "EasyModel"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EasyModel" "DisplayVersion" "1.1.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EasyModel" "Publisher" "Leo"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EasyModel" "DisplayIcon" "$INSTDIR\EasyModel.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EasyModel" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EasyModel" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EasyModel" "NoRepair" 1
  WriteRegStr HKCU "Software\EasyModel" "InstallDir" "$INSTDIR"

  ; 文件关联
  !insertmacro RegisterExt ".stl"
  !insertmacro RegisterExt ".obj"
  !insertmacro RegisterExt ".ply"
  !insertmacro RegisterExt ".glb"
  !insertmacro RegisterExt ".gltf"
  !insertmacro RegisterExt ".3mf"
  !insertmacro RegisterExt ".step"
  !insertmacro RegisterExt ".stp"
  !insertmacro RegisterExt ".iges"
  !insertmacro RegisterExt ".igs"

  ; 静默卸载旧版 EasySTL（如果存在）
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\easystl" "UninstallString"
  StrCmp $0 "" skipOldUninstall
  ExecWait '"$0" /S _?=$INSTDIR'
  skipOldUninstall:
SectionEnd

; ================= 卸载 =================
Section "Uninstall"
  Delete "$SMPROGRAMS\EasyModel\EasyModel.lnk"
  RMDir "$SMPROGRAMS\EasyModel"
  Delete "$DESKTOP\EasyModel.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EasyModel"
  DeleteRegKey HKCU "Software\EasyModel"
  !insertmacro UnregisterExt ".stl"
  !insertmacro UnregisterExt ".obj"
  !insertmacro UnregisterExt ".ply"
  !insertmacro UnregisterExt ".glb"
  !insertmacro UnregisterExt ".gltf"
  !insertmacro UnregisterExt ".3mf"
  !insertmacro UnregisterExt ".step"
  !insertmacro UnregisterExt ".stp"
  !insertmacro UnregisterExt ".iges"
  !insertmacro UnregisterExt ".igs"
  DeleteRegKey HKCU "Software\Classes\EasyModel 模型"
  RMDir /r "$INSTDIR"
SectionEnd
