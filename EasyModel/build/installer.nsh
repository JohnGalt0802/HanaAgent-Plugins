; EasyModel 安装器自定义：自定义完成页（复选框：设为默认打开方式 / 启动）+ 旧版清理
; 实现不依赖 nsDialogs（本环境 NSIS Include 残缺），直接用 System 插件创建控件

Var EasyModelDefaultCheck
Var EasyModelLaunchCheck

; 替代标准完成页（electron-builder assistedInstaller.nsh 官方扩展点）
!macro customFinishPage
  Page custom EasyModelFinishCreate EasyModelFinishLeave
!macroend

Function EasyModelFinishCreate
  ; 说明文字（STATIC）
  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "EasyModel 已安装到您的电脑。", i 0x50000000, i 40, i 40, i 420, i 20, p $HWNDPARENT, i 1002, p 0, p 0)'
  ; 复选框1：设为默认打开方式（默认勾选）
  System::Call 'user32::CreateWindowEx(i 0, t "BUTTON", t "将 EasyModel 设为 STL / OBJ / PLY / GLB / 3MF / STEP / IGES 的默认打开方式", i 0x50000003, i 40, i 110, i 430, i 18, p $HWNDPARENT, i 1001, p 0, p 0) p .r0'
  StrCpy $EasyModelDefaultCheck $0
  System::Call 'user32::SendMessage(p r0, i 0x00F1, i 1, i 0)'
  ; 复选框2：启动 EasyModel（默认勾选）
  System::Call 'user32::CreateWindowEx(i 0, t "BUTTON", t "启动 EasyModel", i 0x50000003, i 40, i 134, i 180, i 18, p $HWNDPARENT, i 1003, p 0, p 0) p .r1'
  StrCpy $EasyModelLaunchCheck $1
  System::Call 'user32::SendMessage(p r1, i 0x00F1, i 1, i 0)'
FunctionEnd

!macro SetDefaultModelForExt EXT
  ; 删除用户级锁定（UserChoice），让系统回落到我们的 ProgID
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\UserChoice"
  ; 确保 ProgID 默认值指向 EasyModel
  WriteRegStr HKCU "Software\Classes\${EXT}" "" "EasyModel 模型"
  ; 加入打开方式候选
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\OpenWithProgids" "EasyModel 模型" 0
!macroend

Function EasyModelFinishLeave
  ; 复选框1：设为默认
  System::Call 'user32::SendMessage(p $EasyModelDefaultCheck, i 0x00F0, i 0, i 0) i .r0'
  IntCmp $0 1 0 skipDefault setDefault
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
    ; 清理旧版 EasySTL 的 ProgID 残留
    DeleteRegKey HKCU "Software\Classes\EasySTL STL 模型"
  skipDefault:
  ; 复选框2：启动 EasyModel
  System::Call 'user32::SendMessage(p $EasyModelLaunchCheck, i 0x00F0, i 0, i 0) i .r0'
  IntCmp $0 1 0 skipLaunch
  ExecShell "" "$INSTDIR\EasyModel.exe"
  skipLaunch:
FunctionEnd

!macro customInstall
  ; 静默卸载旧版 EasySTL（如果存在），避免两个应用并存
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\easystl" "UninstallString"
  StrCmp $0 "" skipOldUninstall
  ExecWait '"$0" /S _?=$INSTDIR'
  skipOldUninstall:
!macroend
