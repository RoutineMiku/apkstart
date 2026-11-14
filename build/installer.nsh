; ApkStart 自定义 NSIS 脚本
; 作用：卸载开始前，先结束可能仍在后台驻留的运行时进程，
; 否则它们会锁住安装目录里的文件，导致卸载不干净、第三方粉碎工具也删不掉。
;
; ApkStart 退出后仍可能留下 detached 的 qemu（为了下次秒开），
; 所以卸载环节必须自己兜底清一遍。

!macro customUnInstall
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
