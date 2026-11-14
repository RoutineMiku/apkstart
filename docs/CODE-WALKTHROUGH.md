# ApkStart 代码走读（接手开发用）

> 面向「要在本项目上继续写代码」的工程师。目标不是复述 README，而是回答三个问题：
> **代码分成哪几层、每个关键动作真实走了哪条链路、改哪里最容易踩坑**。
>
> 生成时间：2026-11-14 · 对应版本 **v0.3.4**（commit `e1db34b`）· 仓库 `RoutineMiku/apkstart`
> 走读基线：`src/**` 共 41 个文件、约 14,845 行（js/html/css/ps1），`npm test` = **70 通过 / 0 失败**。
>
> **怎么读这套文档**
> - 先读本文（总览 + 关键调用链 + 问题地图，约 360 行）；
> - 要改「装包 / 解析 / 图标 / 快捷方式」→ `CODE-WALKTHROUGH-PARSE.md`；
> - 要改「下载 / 部署 / 换源 / 在线更新 / 路径规则」→ `CODE-WALKTHROUGH-RUNTIME.md`；
> - 要改「开机 / 窗口嵌入 / 鼠标键位」→ 本文 2.3~2.6 + `docs/ARCHITECTURE.md`。

---

## 0. 一页纸速览

| 问题 | 答案 |
|---|---|
| 这是什么 | Windows 上的「安卓应用运行器」：Electron 壳 + 自带 Android 运行时（Google Android Emulator / QEMU 全系统虚拟化），把每个安卓应用装成桌面图标、开成独立 Windows 窗口 |
| 一句话架构 | **Electron 主进程做编排，`core/*` 做领域能力，PowerShell 窗口代理做 Win32 脏活，渲染层只做 UI** |
| 不做什么 | 不自己写 hypervisor、不做 Linux 内核/GPU 转译、不挂载 NTFS（共享目录用同步代替）、不依赖第三方模拟器 |
| 关键依赖 | 运行时零第三方依赖手写解析（zip/AXML/ARSC/PNG/ICO）；仅 `@napi-rs/lzma`（解 .xz 镜像）+ Electron |
| 数据在哪 | 代码 `%APPDATA%\apkstart`（settings.json / apps.json / icons / apks / logs）、运行时 `runtime.dir`（可换盘）、AVD `runtime.avdDir`（可换盘） |
| 版本从哪来 | `package.json:version`，`app.getVersion()` 读它；CI 按 tag `v*` 触发发版 |

---

## 1. 仓库结构

```
apkstart/
├─ src/
│  ├─ main.js                1790 行  Electron 主进程：窗口/托盘/单实例/CLI/IPC/生命周期
│  ├─ preload.js              130 行  contextBridge 安全桥（渲染层唯一入口）
│  ├─ ui/                            渲染层（原生 HTML/CSS/JS，无框架）
│  │  ├─ index.html / app.js         主界面（应用列表 + 设置弹窗），app.js 1490 行
│  │  ├─ shell.html / shell.js/css   应用窗口外壳（38px 标题栏 + 启动遮罩）
│  │  └─ assets/                     logo / appicon.ico / 二维码
│  └─ core/                          领域层（无 Electron 依赖的尽量纯 Node）
│     ├─ 编排    installer.js engine.js container.js
│     ├─ 运行时  emulator.js provision.js userdata.js doctor.js layers.js
│     ├─ 设备    adb.js android.js sharer.js notify.js display.js
│     ├─ 窗口    appwin.js agent.js win/agent.ps1 win/priority.ps1 windowctl.js pointer.js
│     ├─ 解析    zip.js axml.js arsc.js apk.js png.js shortcut.js assoc.js
│     └─ 下载/更新 download.js sources.js updater.js store.js logfile.js
├─ build/                    打包流水线（pack.js / prepare-runtime.js / slim-runtime.js / zip.js / seed/）
├─ test/                     run-tests.js(8) + engine-test.js(11) + auto-test.js(53) + 一堆实机探针脚本
├─ tools/                    发布与实机检查脚本（publish-gitee.js、check-*.js、e2e-boot.js）
├─ docs/                     ARCHITECTURE.md、images/、promo/、本文
├─ engine/                   运行时下载缓存（gitignored，只有 README）
└─ .github/workflows/        ci.yml（双 Node 测试）、release.yml（便携版 + 完整版 + Gitee 同步）
```

**分层调用方向**（只允许上层依赖下层）：

```
ui/*  ──preload(contextBridge)──▶  main.js
main.js ──▶ installer.js / engine.js / appwin.js / updater.js / sharer.js …
installer.js ──▶ apk.js ──▶ zip.js / axml.js / arsc.js / png.js / shortcut.js
engine.js ──▶ emulator.js ──▶ provision.js(路径/磁盘守卫) + userdata.js(ext4) + adb.js
appwin.js ──▶ agent.js ──TCP JSON──▶ win/agent.ps1(C# P/Invoke)
所有层 ──▶ store.js（设置/清单持久化）
```

---

## 2. 关键调用链（改代码前先看这几条）

### 2.1 双击 APK → 装好并生成桌面图标

```
Explorer 双击 .apk
 → HKCU\Software\Classes\ApkStart.apk (assoc.js 注册，免管理员)
 → ApkStart.exe "C:\x\a.apk"
 → main.js parseArgs() → runInstall(filePath)              main.js:537
     ├ 防重入：installBusy（连点/拖多次只跑一次）           main.js:540
     ├ installer.install()                                 installer.js:141
     │   ├ /\.(apks|xapk)$/ → parseBundle()（解分片到临时目录）installer.js:26
     │   ├ parseApk()  →  zip.js → axml.js → arsc.js        apk.js:75
     │   ├ isArmOnly(meta) && 无 Play 镜像 →
     │   │     ensureCompatImage() + switchToCompat()        installer.js:159
     │   └ runtime.ensure()  → 见 2.3
     ├ installer.finishInstall()                            installer.js:179
     │   ├ emulator.invalidateSnapshot()（装完旧快照作废）
     │   ├ adb install -r -g -t（失败 NO_MATCHING_ABIS 自动切兼容镜像重试）
     │   ├ 图标落盘 PNG + iconToIco()（WebP 交给渲染进程解码） main.js:213 decodeIcon
     │   ├ 备份 APK 到 apks/（日后自动重装用）
     │   ├ resolveLauncher()：以系统解析的 LAUNCHER 为准    adb.js
     │   ├ store.upsertApp()
     │   └ createShortcut()：桌面 + 开始菜单两份 .lnk        installer.js:286
     └ 通知 / 刷新资源管理器图标缓存
```

**为什么 `resolveLauncher` 必须在装完后跑**：APK 里解析到的「主 Activity」经常不是真正的 LAUNCHER（红果短剧是 `SplashActivity` 而不是 `MainFragmentActivity`），用错入口会跳过初始化 → 3~8 秒后闪退。见 `docs/ARCHITECTURE.md`。

### 2.2 双击桌面图标 → 应用窗口出现

```
<应用名>.lnk → ApkStart.exe --launch <pkg>（lnk 由 shortcut.js 写，带 AppUserModelId）
 → main.js parseArgs() 只认 com.foo.bar 形式              main.js:201
 → 已有实例？second-instance → runLaunch()                 main.js:1477
 → runLaunch(pkg)                                          main.js:606
     ├ openAppWindow()：立刻开一个只有标题栏的窗口 + 启动遮罩 main.js:286
     ├ armAgent()：先给窗口代理下发 scope 并开「常驻压制」  main.js:1547
     ├ installer.launch()                                  installer.js:385
     │   ├ runtime.ensure()（见 2.3）
     │   ├ beforeStart → prepareForeground()（沉浸式/关动画/收锁屏）
     │   ├ 应用不在当前运行时里？从备份 APK 自动重装        installer.js:404
     │   ├ grantRuntimePermissions()
     │   └ startApp() + staysAlive()（25s 窗口 / 连续存活 4s）
     │        失败重试 3 次 → pm clear + 补权限 → 再拉一次
     │        崩溃带 evidence(APP_CRASHED) → 自动切兼容镜像重来
     ├ appWin.embed()：SetParent 把模拟器窗口嵌进来        appwin.js:213
     └ runtime.beginApp(pkg)：停其他 App、提优先级、开同步/通知  engine.js:901
```

**嵌入不是把画面「投屏」**，而是把模拟器自己的 Qt 子窗口 `SetParent` 到 Electron 宿主窗口，再按客户区矩形 `SetWindowPos`。因此：
- 画面是原生渲染、原生 60fps，鼠标键盘直接进 guest；
- 必须 `app.disableHardwareAcceleration()`，否则 Chromium 的 DirectComposition 图层会盖在子窗口上（`main.js:72`）；
- 关窗口时必须**先 park（SetParent(NULL)+SW_HIDE）再 destroy 宿主**，否则 Windows 会把子窗口重挂到桌面（`appwin.js:318` / `agent.ps1:990`）。

### 2.3 `runtime.ensure()`：一次开机到底做了什么

`engine.js:796 _ensureInner()`，按顺序尝试，**任何一步成功就返回**：

1. `client.isOnline()` → 已有设备在线：直接 `prepare()` 复用；
2. `adoptExisting()`（`engine.js:708`）→ 扫还活着的模拟器端口（`tasklist` + `netstat` 找 qemu 的监听端口，不靠猜 5554），`adb kill-server` 后逐个 `connect` + `getprop sys.boot_completed`，能接管的直接复用；
3. `adb devices` 里已有 `emulator-NNNN` → 复用；
4. 进程在但设备离线 → `emulator.stop()` 后重来；
5. `engine.mode === 'attach'` → 探测 WSA/MuMu/LDPlayer/Nox/MEmu 的常用端口（高级路径）；
6. 默认路径：
   - `provisioner.materializeImages()` 展开 `.xz/.gz` 系统镜像（已展开秒过）；
   - `checkEnv()` 判断 adb/emulator/sysimg 是否齐备；
   - `killOrphanEmulators()` 清掉残留 qemu（否则 AVD 锁 FATAL）；
   - `bootEmulator()` → `emulator.start()`（见 2.4）→ 成功后 `prepare()`（ensureFreeform + 看门狗）→ 20s 后空闲存快照。

`ensure()` 外层是**幂等 Promise**（`engine.js:787`）：预热和用户点击同时发生时只开一台机器，避免抢 AVD 锁。

### 2.4 `emulator.start()`：自动降级的开机循环

`emulator.js` 的核心是「`doctor.planVariants()` 生成最多 4 组参数 → 逐组尝试 → 每组用 probe 判定 → 进程崩溃/致命日志就换下一组」：

- 参数由 `doctor.chooseProfile()` 推导（内存/核数/LCD/GPU/data 分区/端口），`liteMode` 会把 vCPU 收到物理核的 1/4（2~3）；
- `gpuMode=auto` 按 emulator 版本挑后端（37.x 用 `host`，老版本 `swiftshader_indirect`），保底 `software`；
- `badGpu` 记忆「上次拉起就崩」的后端（key 带 emulator 版本，升级自动失效）；
- 每轮 probe 只发**一条** adb 命令（`getprop sys.boot_completed; pm path android`），连错 6 轮自动 `resetAdbServer()` 自愈；
- **`/data` 分区是 ApkStart 自己造的**（`userdata.js` + `ensureDataPartition()`，`emulator.js:348`）：官方镜像里的 `userdata.img` 只是 1MB 全零占位，直接拉 `emulator.exe` 会跳过格式化 → guest 掉进 recovery 重启循环。所以首次启动会手写 4KB block 的 ext4（带 `FILETYPE|ENCRYPT`、`ext_attr`），再用自带的 `qemu-img resize` + `resize2fs` 撑到配置容量。

### 2.5 存储/路径规则（换盘相关 issue 都在这）

| 概念 | 代码位置 | 默认 | 可换盘 |
|---|---|---|---|
| 代码数据目录 `DATA_DIR` | `store.js:10` | `%APPDATA%\apkstart` | 否（缓存会在 C 盘紧张时被 `relocateUserDataIfCrowded()` 挪到 AVD 盘，`main.js:50`） |
| 运行时根 `paths().root` | `provision.js` | `DATA_DIR\runtime` | 是：`runtime.dir` |
| AVD 目录 `paths().avdHome` | `provision.js` | `DATA_DIR\avd` | 是：`runtime.avdDir` |
| 系统镜像展开目录 `paths().sysImgRoot` | `provision.js` | `DATA_DIR\system-images` | 跟随运行时根（**必须与 `materializeImages` 的 destRoot 同一套规则**，曾因此 C 盘存两份） |
| 共享目录 | `store.js:99` | `%USERPROFILE%\ApkStartShared` | 是：`sharedDir` |

### 2.6 窗口代理（`agent.ps1`）：为什么要有它

Node 的 `windowsHide` 管不到 emulator 自己 detached 出来的 `qemu` / `netsimd` 控制台窗口（窗口属于 `conhost.exe`，pid 对不上）。所以有一个**常驻 PowerShell 进程**内嵌 C# + P/Invoke，通过本机 TCP 一行一个 JSON 指挥：

| 命令 | 作用 |
|---|---|
| `scope {dirs, pid}` | 声明「哪些目录里的进程才算我们的」+ 主进程 pid。**没有 scope 就一个窗口都不碰** |
| `embed {host,x,y,w,h}` | `SetParent` + `SetWindowPos` 嵌进宿主窗口；宿主 pid 不是主进程就拒绝（`host-not-ours`） |
| `fit` | 跟随宿主窗口 resize/move 重排子窗口 |
| `park` | 摘下 + 藏好（宿主销毁前必须先做） |
| `boothide on/off` | 常驻压制：周期性把模拟器主窗/工具栏/控制台黑窗 `ShowWindow(0)`，跳过已嵌入的那个 |
| `hook on/off {right,wheel,side}` | 全局鼠标钩子（右键返回 / 滚轮合并 / 侧键），**只在应用窗口前台装，失焦即卸** |
| `rotate` / `hide` / `show` / `probe` / `windows` / `consoles` / `quit` | 其余 |

**v0.3.4 的核心教训：类名不是身份，进程路径才是。** 旧版用 `QWindowIcon` 认窗口，而微信 4.x 就是 Qt6、类名一模一样 → 「打开 ApkStart，微信窗口消失」。现在所有判定先过 `IsOurs(pid)`（`agent.ps1:168`），控制台黑窗走 conhost 父进程链 + 标题含 scope 目录（`agent.ps1:219`）。

---

## 3. 各层职责与关键接口

### 3.1 `main.js`（主进程编排）

| 区块 | 行 | 说明 |
|---|---|---|
| 启动前决策 | 40-72 | `relocateUserDataIfCrowded()`（C 盘紧张挪缓存）、`disableHardwareAcceleration()` |
| 完整版自动接管 | 97-171 | exe 旁边有 `runtime/` + 任意完整镜像 → 自动写 `runtime.dir`、开兼容模式；要求 `sameTree`（只认本次 EXE 目录树下），防便携版移动后继续用旧包 |
| 单实例 + 参数 | 196-209, 1473-1482 | `--launch <pkg>` / `<path.apk>` / `--autostart`；second-instance 分发给已运行实例 |
| 托盘 | 468-530 | 前 8 个应用直达、全屏切换、重建快捷方式、检查更新、退出 |
| 安装 | 537-573 | `runInstall()`：防重入 + 错误只弹一次系统通知 |
| 启动 | 606-662 | `runLaunch()`：见 2.2 |
| 更新 | 579-604 | `runUpdate()`：`updater.prepare()` → `apply()` → 退出让脚本接管 |
| IPC | 702-1469 | 约 120 个 channel，按域分组（apps/apk/settings/display/runtime/provision/doctor/android/update/window/shell） |
| 生命周期 | 1484-1790 | `whenReady` 里装配所有对象；`before-quit` 分两段退出（先 park 窗口再真正退出） |

**IPC 命名约定**：`域:动作`；渲染层只能通过 `preload.js` 暴露的 `window.apkstart.*` 调用，事件推送在白名单里（`preload.js:120`）。

### 3.2 `core/engine.js`（运行时生命周期）

导出 `class Runtime`：`ensure / prewarm / boot / stop / adoptExisting / beginApp / endApp / status / diagnostics / cleanup / dispose`。
关键不变量：

- `ensure()` 与 `prewarm()` 都是幂等 Promise；
- `dispose()` **绝不强杀 qemu**（强杀会截断正在写的 quickboot 快照 → 下次只能冷启动）；
- 接管来的实例没有本地 proc 句柄，`vmRunning` 必须同时看 `adb isOnline()`，否则看门狗永远回收不掉；
- 闲置回收看门狗 60s 一轮：`idleShutdownMinutes` 到期且没有活跃 App 才停。

### 3.3 `core/emulator.js`（模拟器适配）

职责：AVD 创建/参数生成/进程拉起/probe/快照/优先级/端口/孤儿清理/数据分区。对外：`start/stop/running/scheduleSnapshotSave/saveSnapshotNow/cancelSnapshotSave/invalidateSnapshot/ensureDataPartition/resizeDataPartition/dataInfo/setPriority/killOrphanProcesses/resetAdbServer/versions`。
坑点集中在文件头注释（`emulator.js:330-347`）：block size 必须 4096、`encrypt` 位必须最后补、`ram.bin` vs `ram.img`、`emulator.exe` 只是启动器。

### 3.4 `core/adb.js`（设备操作）

`class AdbClient`：`isOnline/shell/exec/install/installMultiple/uninstall/startApp/forceStop/clearData/runningPackages/wmSize/setOrientation/keyBack/keyForward/input/prepareForeground/grantRuntimePermissions/dismissPermissionDialog/resolveLauncher/ensureFreeform/devices/connect/killServer`。
性能关键：**常驻 `adb shell` 输入通道**（`input()` 用 `echo __APKSTART_<id>__` 做回包/背压），右键返回与滚轮不再每格 spawn 一个 adb 进程。

### 3.5 `core/installer.js`

见 2.1。额外两个「自动修复」路径值得记住：`switchToCompat()`（切镜像后把已装应用从备份 APK 重灌回去）和 `ensureShortcuts()`（启动时补齐老版本漏建的图标/快捷方式）。

### 3.6 `src/ui/`

- `app.js`：单文件状态机（`state` 对象 + 一堆 render 函数），没有框架；所有后端调用都 `await window.apkstart.xxx()`；
- 安装进度：`installFiles()` 里 sticky toast + `install:progress` 事件，**失败时先 `off()` 再 `dismiss()`**（曾经的「失败信息一直循环」就是这个）；
- `shell.html/js`：应用窗口外壳，只有旋转/最小化/最大化/关闭四个按钮 + 启动遮罩。

### 3.7 持久化 `core/store.js`

`getSettings()` 每次 `deepMerge(DEFAULT_SETTINGS, 磁盘值)` 并**强制迁移**三项历史配置（`headless=false` / `hideAfterLaunch=false` / `freeform=false`）；
`saveSettings()` 写 tmp + rename（原子写），并处理 `resourceMode` → `liteMode/priorityMode/renderSize` 的翻译。
`apps.json` 是数组 `{ apps: [...] }`，`upsertApp` 按 `package` 合并。

---

## 4. 构建 / 发布流水线

| 命令 | 脚本 | 产物 |
|---|---|---|
| `npm run pack` | `build/pack.js` | `dist/ApkStart-win64-portable/`（~226MB 解压后，首次启动再下运行时） |
| `node build/zip.js <dir> <zip>` | `build/zip.js` | 7-Zip `-mx=9` 压包 + 用自家 zip 解析器自校验；**超 100MiB 直接失败**（Gitee 单文件上限） |
| `npm run runtime` | `build/prepare-runtime.js` | `build/runtime/`（emulator 瘦身 + 镜像 xz/gz + `build/seed/userdata.img.gz`） |
| `npm run build:exe` | 上面两步 + `electron-builder --win nsis` | `dist/release/ApkStart-<ver>-Setup.exe`（~1.32GB，内置运行时） |
| `npm test` | `run-tests.js` + `engine-test.js` + `auto-test.js` | 70 项纯 Node 测试 |
| `npm run test:boot` | `test/boot-test.js` | Alpine guest 真引导，验证 QEMU 参数/建盘/优雅关机 |
| `npm run selftest` | `scripts/selftest.js` | 对已装设备端到端验收（adb/版本/freeform/共享目录，`--apk` 走完整安装→启动→截图） |

`.github/workflows/ci.yml`：Windows × Node 20/22 跑 `npm test` + `test/pointer-hook-logic.ps1`（防止鼠标键位被改坏）。
`.github/workflows/release.yml`：tag `v*` → `build` job（便携版 zip → GitHub Release → 同步 Gitee，缺 `GITEE_TOKEN` 直接失败而不是静默跳过）+ `full` job（组装运行时 → xz → NSIS Setup → 上传 Release + 运行时整包 zip）。

**发版检查清单**（从历史踩坑总结）：
1. `package.json` 版本号必须 bump（否则客户端判「已是最新」）；
2. 写 `.github/release-notes-<tag>.md` 就用它，否则 `--generate-notes`；
3. `full` job 要 ~40 分钟（xz 压缩 1.1GB）；
4. Gitee 用 `tools/publish-gitee.js`，整包优先、超限才切分；
5. 发完核实「发行包 == 代码」：查 zip 内 `agent.ps1` 是否含 `SetScope`/`IsOurs`、`package.json` 版本。

---

## 5. 测试与实机验证工具

- **纯 Node 回归**（CI 必跑）：`test/auto-test.js` 覆盖 doctor 参数矩阵、容器状态机、下载器/双源、pointer 逻辑、日志滚动等；
- **实机探针**（本机手动跑，沙箱里跑不了）：`tools/check-windows.js`（开机全窗口泄漏）、`check-console.js`（黑窗）、`check-launch-clean.js`（装+开+嵌）、`check-quit-clean.js`（退出残留）、`check-update.js`（真 GitHub API）、`e2e-boot.js`（冷启/热启计时）；
- **界面冒烟**：`electron . --smoke out.png`，配合 `--settings` / `--perf` / `--download` 分别拍设置页各区；
- **PS 逻辑测试**：`test/pointer-hook-logic.ps1` 反射驱动钩子回调；`agent-compile.ps1` 只验证 C# 能编译。

> 本机（该开发机）实测环境：**Node 22.22.2 / npm（`.workbuddy/binaries/node`）**、**PortableGit 2.55**、Electron 33.4.11（`node_modules/electron/dist`）、运行时 `D:\ApkStartRuntime`（emulator 37.3.9.0 + AEHD Operational）、AVD `D:\ApkStartData`、数据 `%APPDATA%\apkstart`。

---

## 6. 现在的问题地图（接手时最值得先看的）

### 6.1 已知热点 bug（对应 GitHub issue）

| Issue | 现象 | 已定位的代码位置 |
|---|---|---|
| #21 安装 2GB+ 卡住 | 大 APK 报错且「右下角一直转圈」 | `apk.js:78` `fs.readFileSync(filePath)` 整包读，撞 Node 单 Buffer 上限；应改用 `zip.js` 里已有的 `ZipFile`（fd 流式读中央目录） |
| #20 / #25 无法开机（0xC0000005） | emulator 打印完 Userspace boot properties 后 `exit 3221225477` | 两例都是 NVIDIA + emulator 37.3.9.0 + `-gpu host`；本机运行时版本相同，可原地复现 |
| #26 安装太慢/卡在准备运行时 | 首次部署停在下载 | `provision.installRuntimePack()` / 官方源逐件下载路径；Gitee 限流熔断 |
| #23 便携版设了运行时目录仍下到 AppData | 路径规则不一致 | `paths().root` 与 `materializeImages` / `sysImgRoot` 的联动（见 2.5） |
| #27 / #28 微信、UU 远程被藏窗口 | 已在 v0.3.4 修复（scope/IsOurs） | `agent.ps1:168`，用户升级即可 |
| PR #18 / #22 | 与已合并实现重复 | #18 被 `b3fc7c2` 取代；#22 的 `_qemuImg` 参数顺序已在 `emulator.js:403` 修正 |

### 6.2 已确认的实现缺陷（走读时逐行核对出来的，未修）

| # | 位置 | 缺陷 | 影响 |
|---|---|---|---|
| 1 | `apk.js:78` / `installer.js:27` | `fs.readFileSync` 整包读 APK | 2GB+ 必炸（issue #21）；低内存机解析大包也危险 |
| 2 | `zip.js` 全文 | **没有 Zip64**（`zip.js:29-30,37,161-162,180`） | 条目数 >65535 静默丢条目；单条目 >4GiB 直接 `RangeError`（系统镜像/更新包迟早撞上） |
| 3 | `assoc.js:62-63` | 注释承诺的「保留用户原有关联」并不存在，卸载时无条件清空 `.apk` 默认值 | 用户原本的 APK 关联被抹掉；模块零测试 |
| 4 | `logfile.js:19-21` | `bak === file` 时先删后 rename | 非 `*.log` 文件名会丢日志（`appLog` 恰好是 `app.log`，所以没暴雷） |
| 5 | `provision.js:531` + `sources.js:412` | 部署刚开始固定 `percent:1`，随后**串行**测速每个地址最多 9s | 4 个候选 = 30s+ 零进度 → 用户以为「卡在准备运行时」（issue #26） |
| 6 | `provision.js:575-576` / `:790` | `.xz` 展开失败被两层 `catch` 吞掉 | 进度停在 99% 后又跳回「改用官方源补齐」，白下一套 1.4GB |
| 7 | `provision.js:262-277` | `guardDisk` 的 `need` 表缺 `'runtime'` 项，只估 1536MB | 整包+展开实际约 5GB，守卫通过后仍可能撑爆盘 |
| 8 | `updater.js:80` | 便携版兜底 `/\.zip$/i` | 某版本只有 `ApkStart-runtime-*.zip` 时会被误当更新包解压进程序目录 |
| 9 | `main.js:165-168` | `bootstrapBundledRuntime()` 在「便携版目录带 runtime」时直接覆盖用户设的 `runtime.dir` | 「设了运行时目录还是下到 AppData」（issue #23） |
| 10 | `main.js:213` / `shortcut.js:120` | WebP 图标依赖隐藏 BrowserWindow 解码 | 纯 Node / 无 GUI 场景静默降级成品牌占位图，且「解码失败」与「没有图标」不可区分 |
| 11 | `apk.js:29,67` | 图标格式白名单只有 `.png`/`.webp`，不递归 XML `<bitmap>` | `.jpg` 图标、adaptive-icon 组合会抽错图 |
| 12 | `arsc.js:65-77` | config 打分是拍出来的常数（`anydpi` 罚 500、`language` 罚 40） | 中文应用可能拿到英文名；三种 entry 编码零测试，出错时静默回退默认值 |

### 6.3 结构性问题（下一阶段可做）

1. **大文件路径统一**：`apk.js` / `installer.parseBundle()` 换成现有的 `ZipFile`（fd 流式，`zip.js:128` 起）——峰值内存从「文件大小」降到「几 MB」，顺带解决 2GB 上限。注意两个类的 `read()` 语义不同（`ZipArchive` 返回 null / `ZipFile` 抛错），替换时要补 `has()` 判断；
2. **补 Zip64**：EOCD 出现 `0xffff/0xffffffff` 时定位 Zip64 EOCD（`0x06064b50`）与 locator（`0x07064b50`），把 4 个字段换成 u64；
3. **拆大文件**：`main.js` 1790 行的 IPC 注册按域拆到 `src/main/ipc/*.js`；`emulator.js` 1064 行按「参数矩阵 / 快照 / 数据分区」三块拆；
4. **诊断能力不足**（#20/#25 的报告里 `attempts: []`、`bootLog: []`）：失败时把 `emulator.attempts` 与 emulator.log 尾部写进诊断报告，并把退出码翻译成中文（`3221225477` = 0xC0000005 访问冲突）；
5. **GPU 兼容层**：`-gpu host` 在部分 NVIDIA 驱动 + emulator 37.3.9 上崩，可在 `badGpu` 机制上扩一条「退出码 0xC0000005 → 自动降级并记住」；
6. **测试缺口**（按风险排序）：AXML/ARSC 无合成字节用例（真实 APK 夹具缺失时整段跳过 → CI 零覆盖）、`arsc.resolve()` 零断言、`.apks/.xapk` 无用例、`assoc.js` 零覆盖、`pngToIco`/`writeShortcut` 不在 `npm test` 里；
7. **Gitee 资产与 GitHub 不一致**（v0.3.4 Gitee 只有便携包）：发布流程已有 `publish-gitee.js`，但 CI 需要 `GITEE_TOKEN` secret 才不失败。

### 6.4 部署链上最容易出问题的环节（11 条速查）

| 现象（用户视角） | 代码位置 | 机理 |
|---|---|---|
| 卡在「准备运行时」1~3% | `provision.js:531` + `sources.js:412` | 串行测速，无字节进度 |
| 停在 99% 又跳回「改用官方源」 | `provision.js:575-576,790` | `.xz` 展开失败被吞 |
| 「设了运行时目录还是下 AppData」 | `provision.js:217-224,726` + `main.js:165-168` | `sysImgRoot` 三分支沿用老目录 + 完整版接管覆盖设置 |
| 磁盘够却报空间不足 | `provision.js:262-277` | guard 只估 1.5GB |
| 进度卡 95% | `download.js:446-503` | 慢源拖尾块；已加低速换源 + 保证 settle |
| 连接中断后整个下载作废 | `download.js:155,188-191` | 见半截文件会降级单流 |
| 更新卡在「正在替换程序」 | `updater.js:271,280-285,315-323` | 覆盖脚本**不能 detached**，安全软件会拦 |
| 程序目录多出 1.5GB 文件 | `updater.js:80` | 运行时整包被当更新包 |
| Gitee 某版本没安装包 | `release.yml` + `sources.js:172-204` | 缺 token 直接失败；分片必须 part1..N 连续 |
| 换源后仍走老地址 | `main.js:819-825` | `provision._cache.*` 无失效入口，需重启 |
| AVD 判定「已被占用」 | `layers.js:87-90` + `engine.js:856` | 残留 `*.lock`，清理面板可回收 |

> **给接手者的三条「先看这里」**
> 1. 只看一个函数就能解释八成部署问题：`Provisioner.checkEnv()`（`provision.js:367`）；
> 2. 路径规则只有一处：`Provisioner.paths()`（`provision.js:197`），新代码落运行时文件必须从这拿路径；
> 3. 下载策略都收敛在 `Sources` + `downloadMulti`，不要在 `provision.js` 里另写一套。

### 6.5 本地修复记录（v0.3.5-dev，未发布、未 push）

2026-11-14 第二轮开发：只改本地工作区，`npm test` 由 **98 项增至 110 项全绿**
（run-tests 3→8 + engine-test 25 + auto-test 70→77，新增合成 APK / .xapk 拆分包 /
materializeImages / Zip64 / 更新资产 / 0xC0000005 / 日志边界 / 失败落盘等回归用例），
并跑了一次真实冷启（25s）/ 热启（5s，命中快照）/ 优雅关机（快照已存）端到端验证；
**实测 2.15GB 的合成 APK：解析 18ms、进程 RSS 47MB**（旧路径需要约 2.2GB 连续内存），
`assoc` 用本机真实注册表做过「备份 → 注册 → 注销 → 还原」闭环
（本机原关联 `MuMuPlayer.apk`，已原样还原）。

| # | 修了什么 | 位置 | 为什么 |
|---|---|---|---|
| 1 | `parseApk` / `parseBundle` 改文件版 ZIP 流式读 | `apk.js:80-95`、`installer.js:27-60` | 2GB+ APK 不再撞 Node 单 Buffer 上限；拆分包的每个分片也流式落盘 |
| 2 | ZIP 支持 Zip64（EOCD locator + extra id=0x0001） | `zip.js:9-92`、`zip.js:151-236` | 条目数 >65535 不再静默截断；超大条目不再越界/丢偏移 |
| 3 | `adb install` 超时按包体放大（封顶 20 分钟） | `adb.js:105-114` | 2GB 包 push + dexopt 会超过固定 4 分钟 |
| 4 | 部署：测速改为带进度（第 i/n 个源，6s/源） | `sources.js:408-424` | 「卡在准备运行时」不再是一段 30 秒无进度 |
| 5 | 镜像展开失败不再被吞、改 `.part` + 原子改名；「已展开」判定改为不小于压缩包大小（半截镜像会被重解） | `provision.js:766-826` | 旧版停 99% 后跳回官方源再下 1.4GB；半截 system.img 会被当已完成 |
| 6 | `guardDisk('runtime')` 补 5000MB 估算 | `provision.js:262-268` | 整包 + 展开峰值约 4.7GB，旧估算只 1.5GB |
| 7 | 用户手设的运行时目录不再被 bundled runtime 覆盖 | `main.js:136-162` | issue #23「设了目录还下到 AppData」 |
| 8 | 更新器兜底 `.zip` 排除 `ApkStart-runtime-*.zip` | `updater.js:73-88` | 防止某次发布缺便携包时把 1.5GB 运行时整包当程序包解压 |
| 9 | 0xC0000005 诊断规则 + 自动降 GPU + 失败落盘 | `doctor.js:320-330`、`emulator.js`（`describeExitCode` / `_persistFailure` / `lastFailure` / `tailLogFile`）、`engine.js:diagnostics` | issue #20/#25：报告里 `attempts: []`、`bootLog: []`、UNKNOWN 的根因是数据只在内存里 |
| 10 | `assoc` 卸载时还原用户原有 `.apk` 关联 | `assoc.js:40-135` | 旧实现无条件清空默认值（注释承诺的保护不存在） |
| 11 | 日志滚动 `bak === file` 边界守卫 | `logfile.js:15-30` | 非 `.log` 文件名会被先删后 rename 导致丢日志 |
| 12 | 图标：白名单加 jpg、XML 图标递归 3 层、占位图可区分并给软警告 | `apk.js:27-115`、`shortcut.js:109-140`、`installer.js:210-235,289-300` | `.jpg`/adaptive-icon/layer-list 图标不再一律变占位图；真解不出来时告诉用户 |
| 13 | 安装失败 UI：错误提示统一由 `install:error` 收口并清掉「正在安装」转圈 | `ui/app.js:469-520,1446-1460`、`main.js:566` | issue #21 里「报错了右下角还在加载」 |
| 14 | 新增「合成 APK」回归测试：自造 AXML 清单 + PNG 图标 + ABI 目录，覆盖 `attributeStart` 基准、非命名空间 `package`、整数属性、启动 Activity 解析；`.xapk` 拆分包与 `materializeImages`（展开/跳过/坏镜像不留半截）另有专门用例 | `test/lib/make-apk.js`、`test/run-tests.js`、`test/auto-test.js` | 真实 APK 夹具缺失时 CI 上 axml/apk 零覆盖；镜像展开是部署最脆的一步 |

> 仍未做（留给下一轮）：`main.js` IPC 拆分、`emulator.js` 拆分、`arsc` config 打分可配置化、
> `main.js` 1790 行里的托盘/更新菜单抽离、`arsc.js` 的合成字节用例（`axml.js`/`apk.js`
> 已由 `test/run-tests.js` 里的「合成 APK」用例覆盖，不再依赖外部夹具）。

---

## 7. 附录：模块速查

### 7.1 `src/core` 导出签名

| 模块 | 主要导出 |
|---|---|
| `store.js` | `DATA_DIR/ICON_DIR/APK_DIR`、`getSettings/saveSettings/getApps/saveApps/upsertApp/removeApp/getApp/iconPath/apkPath/ensureDirs/DEFAULT_SETTINGS` |
| `engine.js` | `class Runtime`、`MONITOR_PORT` |
| `emulator.js` | `class EmulatorEngine` |
| `provision.js` | `class Provisioner`（`paths/checkEnv/installAdb/installEmulator/installSystemImage/installPlayImage/installAehd/installQemu/materializeImages/installRuntimePack/guardDisk/emulatorAccel/hypervisor`） |
| `installer.js` | `class Installer`、`accentOf` |
| `adb.js` | `class AdbClient`、`friendlyInstallError`、`friendlyLaunchError` |
| `apk.js` | `parseApk` |
| `zip.js` | `class ZipArchive`（整包内存）、`class ZipFile`（fd 流式） |
| `appwin.js` | `class AppWindow`、`TITLEBAR_H` |
| `agent.js` | `class WinAgent`、`AGENT_SCRIPT` |
| `doctor.js` | `hostInfo/freeDiskMB/gpuCandidates/lcdFor/shortPath/liteProfile/chooseProfile/overridesFromSettings/autoProfile/planVariants/isPortFree/snapshotKey/imageIdentity/diagnose/describeProfile/writeReport/vcRedistOk` |
| `updater.js` | `class Updater`（`check/prepare/apply`、`repoUrl`） |
| `sources.js` | 双源列举/测速/缓存/熔断（详见 `_wip-provision-stack.md`） |
| `download.js` | `downloadMulti` / 单流 / 断点续传 / 看门狗（详见同上） |
| `container.js` | `nextSessionState/buildSessionCommands/buildIdleCommands/buildRestoreCommands/NEVER_TRIM` |
| `pointer.js` | `pointerOptions/hookOptions/wheelToSwipe/WheelRouter/isInputCommand` |
| `layers.js` | `summary/prune`（容器分层盘点与回收） |

### 7.2 相关文档

- `docs/ARCHITECTURE.md`：面向用户的架构与设计取舍（含「容器模型」「鼠标键位」章节）；
- `docs/CODE-WALKTHROUGH-PARSE.md`：**离线解析栈逐文件走读**（zip / AXML / ARSC / PNG / apk / shortcut / assoc / version / logfile / display），含每个文件的接口签名、行号级坑点、调用点、测试覆盖与内存画像；
- `docs/CODE-WALKTHROUGH-RUNTIME.md`：**下载/部署/更新栈逐文件走读**（sources / download / provision / updater / store / layers / notify / android），含双源选优、分块混源、断点续传、路径规则、更新覆盖脚本，以及 14 条部署问题速查表。

### 7.3 需要实机才能验证的部分（沙箱/CI 覆盖不到）

- 开机全流程与窗口不泄漏：`tools/check-windows.js`、`check-console.js`、`check-launch-clean.js`、`check-quit-clean.js`；
- 冷启/热启计时：`tools/e2e-boot.js`（历史数据：冷启 ~23s、命中快照 ~5s、含前置探测端到端 30.7s / 13.7s）；
- 更新链路：`tools/check-update.js`（真 GitHub API + 真覆盖脚本）；
- 鼠标键位、嵌入、转屏：`test/pointer-hook-logic.ps1`、`test/embed-probe*.ps1`、`test/win-*.ps1`。
