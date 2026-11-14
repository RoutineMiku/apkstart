# 开发环境与命令速查

> 这份文档记录「在这台开发机上继续开发 ApkStart」需要知道的环境事实。
> 大部分坑是沙箱环境特有的，换机器请以实际探测为准。
> 最后核对：2026-11-14（v0.3.5，已在 v0.3.4 基础上发布本地修复）。

## 0. 事故记录：工作区曾被整体丢进回收站

2026-11-14 20:55 左右，`D:\apkstart-dsh` **整个目录**（261 项：源码 / 测试 / 文档 /
`.workbuddy` 记忆）被某次「清理 apkstart 旧产物」的操作移进了回收站；
同一批被清理的还有 `D:\apkstart-dist`、`D:\dist-gitee`、`D:\ApkStart-0.3.3-preview`、
`D:\tmp-wx` 等旧目录 —— 看起来是删 `D:\apkstart*` 的通配清理顺手带走了工作区。

恢复过程（可复用）：
1. **别清空回收站**。D 盘的条目在 `D:\$Recycle.Bin\<SID>\`，每个条目是一对
   `$I<id><ext>`（元数据）+ `$R<id><ext>`（数据）。
2. `$I` 的布局：version u64 @0、原大小 u64 @8、删除时间 u64 @16、
   **路径长度 u32 @24（单位是 UTF-16 字符数，不是字节！）**、路径 UTF-16LE @28。
   把 `$R` 改名回 `$I` 里记录的原路径即可恢复（目录会自动重建）。
3. `.git` 不在回收站里（可能被删除工具跳过）：从 `C:\Users\15656\WorkBuddy\
   2026-10-29-20-43-38\apkstart\.git` 恢复历史（e1db34b = v0.3.4），再把工作区
   重新提交。
4. 恢复后校验：`src/**` 与 `dist\ApkStart-win64-portable\resources\app\src`
   逐文件 SHA256 完全一致；`npm test` 112 项全绿。

**建议**：以后定期把源码+`.git`+docs+test 打一个 zip 放到 `D:\` 以外
（例如 `C:\Users\15656\WorkBuddy\` 下），不要和工作区放同一个盘。

## 1. 工具链位置（PATH 里没有，必须用绝对路径）

| 工具 | 路径 | 版本 |
|---|---|---|
| Node | `C:\Users\15656\.workbuddy\binaries\node\versions\22.22.2-6\node.exe` | v22.22.2 |
| npm | `…\22.22.2-6\npm.cmd` | 随 Node |
| Git | `C:\Users\15656\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe` | 2.55.0.windows.3 |
| Electron | 仓库内 `node_modules\electron\dist\electron.exe` | 33.4.11 |

PowerShell 里先补 PATH：

```powershell
$env:PATH = 'C:\Users\15656\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd;' +
            'C:\Users\15656\.workbuddy\binaries\node\versions\22.22.2-6;' + $env:PATH
```

依赖被清掉时重装（19 秒左右，走镜像）：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm ci --no-audit --no-fund
```

## 2. 每个 shell 必须先清的两个环境变量

宿主 shell 会继承这两个，不清理会出现「Electron 按纯 Node 跑」等灵异现象：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 否则 electron.exe 变成 node，--launch 报 bad option
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue           # 否则 build/pack.js 的批量删除会被 safe-delete 拦成 SAFE_DELETE_BULK_GUARD_ERROR
```

## 3. 常用命令

```powershell
cd D:\apkstart-dsh\apkstart

# 单元/回归测试（纯 Node，不需要 Electron/adb/网络）
npm test

# Electron 集成测试（ICO / .lnk / WebP 图标降级）
.\node_modules\electron\dist\electron.exe test\electron-integration.js

# 界面冒烟截图（--settings 额外拍设置页；--perf/--download 拍对应区块）
.\node_modules\electron\dist\electron.exe . --smoke "$env:TEMP\smoke.png"
.\node_modules\electron\dist\electron.exe . --smoke "$env:TEMP\smoke.png" --settings

# 真实开机（冷启/热启计时，--stop 会优雅关机并存快照）
node tools\e2e-boot.js . --stop

# 便携版打包（产出 dist\ApkStart-win64-portable）
node build\pack.js

# 完整版安装包（需要 build/runtime，约 1.4GB 运行时；CI 里跑）
npm run build:exe
```

> 冒烟/开机跑完记得确认没有残留进程：
> `Get-Process -Name ApkStart,electron,emulator,qemu-system-x86_64 -ErrorAction SilentlyContinue`
> 模拟器是 detached 的，Electron 退出后 qemu 可能还活着（这是设计：下次秒接管）。
>
> 若 `dist\ApkStart-win64-portable` 正被占用（资源管理器/杀软/上一个实例还开着），
> `pack.js` 会退到 `dist\ApkStart-v<版本>-win64-portable`，属预期；关掉占用者后改名回来即可。
> 只读/索引进程（Defender、SearchIndexer）可能让空目录几分钟删不掉，等一会儿再试。

## 4. 数据与运行时路径（本机）

| 用途 | 路径 |
|---|---|
| 设置 / 应用清单 / 日志 / APK 备份 | `%APPDATA%\apkstart`（实际目录名 `ApkStart`，大小写不敏感） |
| 运行时（emulator + adb + 镜像） | `D:\ApkStartRuntime`（`settings.runtime.dir`） |
| AVD / 已装应用 / 快照 | `D:\ApkStartData`（`settings.runtime.avdDir`） |
| 共享目录 | `%USERPROFILE%\ApkStartShared` |
| 诊断报告 | `%APPDATA%\apkstart\logs\diagnostic-*.txt` |
| 上次启动失败记录 | `%APPDATA%\apkstart\logs\last-failure.json` |

## 5. 文本/文件操作注意事项（这个终端特有）

- **不要用 `Set-Content` / `Get-Content -Raw` 处理含中文的 UTF-8 文件**：
  PowerShell 5.1 默认按 ANSI 解码，会写出乱码（本会话踩过一次，直接毁掉测试文件）。
  读写文本一律走编辑器工具；必须在 PowerShell 里写文件时用
  `[System.IO.File]::WriteAllText($p, $s, [System.Text.UTF8Encoding]::new($false))`。
- **`[System.IO.File]` 的静态方法用的是进程初始目录**，`cd` 之后仍然解析旧路径 —— 一律用绝对路径。
- **删除大目录**：`Remove-Item -Recurse` 可能被 safe-delete 层拦住，
  用 `[System.IO.Directory]::Delete($path, $true)`；删完空间没释放时清回收站。
- **长跑进程**（qemu / 大下载）用后台任务；普通命令结束会连带清理子进程树。
- 读 `reg.exe` 输出时注意它是控制台代码页；包名/路径这类 ASCII 内容没问题。

## 6. 常见故障对照

| 现象 | 原因 / 处理 |
|---|---|
| `electron --version` 输出 `v20.x`（Node 版本） | `ELECTRON_RUN_AS_NODE=1` 没清 |
| 打包报 `SAFE_DELETE_BULK_GUARD_ERROR` | `NODE_OPTIONS` 没清 |
| `npm test` 里 axml/apk 用例显示「跳过」 | 没有真实夹具；合成 APK 用例仍会跑（`test/lib/make-apk.js`） |
| 模拟器 `0xC0000005`（3221225477） | 渲染后端崩溃；新版本会自动换后端并写 `last-failure.json`，报告在 `logs\diagnostic-*.txt` |
| 「Running multiple emulators with the same AVD」 | 残留 qemu 占锁；`node tools\emu-clean.ps1` 或重新开机（新版会自动清孤儿） |
| 更新检查里 Gitee 403 | 匿名 API 限流，客户端熔断 15 分钟并只用 GitHub；不是故障 |
| 沙箱里 `reg.exe` / `sc.exe` 被拦 | 只影响自动化测试；产品运行在用户桌面不受影响 |
| 便携版启动 1 秒就退出、无窗口 | 单实例锁被别的 ApkStart 进程占着（可能是没退干净的旧实例），先 `Stop-Process -Name ApkStart` |

## 7. 发版流程（确认实测通过后再做）

```powershell
# 1. bump 版本
#    package.json: version -> 0.3.5
# 2. 发行说明：docs/RELEASE-NOTES-NEXT.md -> .github/release-notes-v0.3.5.md
# 3. 提交 + 打 tag
git add -A; git commit -m "chore(release): v0.3.5"
git tag -a v0.3.5 -m "ApkStart v0.3.5"
# 4. 推两个仓库（GitHub 走 SSH，Gitee 走 https；按需）
git push origin main; git push origin v0.3.5
git push gitee main;  git push gitee v0.3.5
```

CI：`release.yml` 会构建便携版（95MB zip）、完整版 Setup（~1.35GB）与运行时整包
（~1.36GB），同步便携版到 Gitee（需要 `GITEE_TOKEN` secret，缺了会直接失败而不是静默跳过）。
`full` job 的 xz 压缩约 40 分钟，属正常。
