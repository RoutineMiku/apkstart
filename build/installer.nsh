; ApkStart 自定义 NSIS 脚本
; 作用：卸载开始前，先结束可能仍在后台驻留的运行时进程，
; 否则它们会锁住安装目录里的文件，导致卸载不干净、第三方粉碎工具也删不掉。
;
; ApkStart 退出后仍可能留下 detached 的 qemu（为了下次秒开），
; 所以卸载环节必须自己兜底清一遍。

; 安装收尾：再兜一层桌面图标。
; electron-builder 的 createDesktopShortcut 走的是它自己的 CreateShortcuts 流程，
; 个别环境（桌面被 OneDrive 重定向、快捷方式被安全软件回滚）里会生成失败，
; 用户装完发现桌面上什么都没有。这里用 NSIS 原生的 CreateShortcut 再写一次：
; $DESKTOP 走 SHGetFolderPath，能正确跟随桌面的重定向路径；写成幂等操作，
; 和 electron-builder 的重复执行也只是覆盖同一个 .lnk。
!macro customInstall
  DetailPrint "正在创建桌面快捷方式…"
  CreateShortcut "$DESKTOP\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkStart — 在电脑上直接运行安卓应用"
  CreateDirectory "$SMPROGRAMS\ApkStart"
  CreateShortcut "$SMPROGRAMS\ApkStart\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkStart — 在电脑上直接运行安卓应用"
!macroend

!macro customUnInstall
  ; 先删自己写的快捷方式入口（未安装 ApkStart 时也应无残留）
  Delete "$DESKTOP\ApkStart.lnk"
  Delete "$SMPROGRAMS\ApkStart\ApkStart.lnk"
  RMDir "$SMPROGRAMS\ApkStart"

  DetailPrint "正在结束 ApkStart 残留进程…"
  ; /F 强杀 /T 连带子进程。进程不存在时 taskkill 返回 128，忽略即可。
  nsExec::Exec 'taskkill.exe /F /T /IM ApkStart.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-x86_64.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-i386.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator-check.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM adb.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM netsimd.exe'
  ; 给一点时间让进程真正退出、释放文件句柄
  Sleep 1500
!macroend
