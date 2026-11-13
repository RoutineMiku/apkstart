# 架构

## 分层

```
┌─────────────────────────────────────────────────────────────┐
│ 表现层  src/ui (HTML/CSS/JS)  ←→  preload (contextBridge)   │
├─────────────────────────────────────────────────────────────┤
│ 编排层  src/main.js（窗口/托盘/CLI 分发）                     │
│         installer.js（安装流水线）                            │
├─────────────────────────────────────────────────────────────┤
│ 域层    engine.js（运行时生命周期/探测/空闲回收）             │
│         adb.js（设备操作）  sharer.js（文件互通）            │
├─────────────────────────────────────────────────────────────┤
│ 离线解析  zip.js → axml.js / arsc.js → apk.js                │
│           png.js / shortcut.js（图标与快捷方式）             │
├─────────────────────────────────────────────────────────────┤
│ 引擎适配  自带 QEMU(WHPX/TCG) │ 系统镜像导入 │ 已有运行时(可选) │
└─────────────────────────────────────────────────────────────┘
```

## 关键流程

### 1. 双击 APK 安装

```
Explorer 双击 .apk
  → HKCU\Software\Classes\ApkStart.apk\shell\open\command
  → ApkStart.exe "C:\...\xxx.apk"
  → main.js parseArgs → runInstall
      1. apk.js：离线解析（zip → manifest AXML → arsc 还原 label/icon）
      2. engine.ensure()：运行时未就绪则自动拉起/探测
      3. adb install -r -g -t
      4. 图标 → PNG（icons/）+ 多尺寸 ICO（icons/*.ico）
      5. shell.writeShortcutLink 生成桌面 .lnk（--launch <pkg>）
      6. store.upsertApp 记录元数据
```

### 2. 桌面图标启动（原生体验）

```
双击 <应用名>.lnk
  → ApkStart.exe --launch <pkg>
  → 单实例锁合并到已运行实例（或静默拉起新实例）
  → adb am start --windowingMode 5 -n <pkg>/<activity>
  → 独立 freeform 窗口
  → 壳层窗口自动隐藏/退出，不留多余界面
```

### 3. 数据互通

```
本机 %USERPROFILE%\ApkStartShared  ⇄  安卓 /sdcard/ApkStartShared
  增量双向同步（mtime+size 判定），8s 轮询 + 关键动作触发
```

## 为什么不用现成库

| 需求 | 常规做法 | ApkStart 的做法 | 理由 |
|---|---|---|---|
| 读 APK 元数据 | aapt2 / apk-parser | 手写 zip+AXML+ARSC | 体积零依赖、免安装 SDK、启动无外部进程 |
| 图标转 ICO | ImageMagick/sharp | nativeImage 缩放 + 手写 ICO 容器 | 避免 80MB 原生依赖 |
| 文件关联 | 安装器写 HKLM | HKCU + SHChangeNotify | 免管理员、可随时在设置里开关 |
| 模拟器 | 打包整套 VirtualBox | 引擎适配层 | 复用已有运行时零成本；QEMU 路线保留可控的系统镜像方案 |

## 稳定性设计

- 所有 adb 调用带超时与错误归一化（AdbError）。
- 运行时探测并行进行，4s 超时，失败自动降级。
- QEMU 空闲看门狗：无前台应用且超过设定分钟数才回收，有应用在跑永不回收。
- 设置/应用清单写入采用 tmp+rename 原子写。

## 应用级容器模型（性能）

### 与「真容器」的边界

华为卓易通 / WSA / Anbox 属于**容器或兼容层**：宿主内核与 guest 共享，
系统服务按需拉起，理论上可以只为某个 App 加载它依赖的那几个服务。
ApkStart 的底座是 Google Android Emulator（QEMU 全系统虚拟化），
Linux 内核、zygote、system_server 必须整包引导一次，**做不到「只加载某个 App
需要的系统服务」**，这一点无法靠上层代码绕过。

但用户感受到的「重」并不来自这些常驻服务，而来自另外四件事。
把它们解决掉，体验上就等价于「每次只开 App 需要的环境」：

| 真正的负担 | 处理方式 | 实现位置 |
| --- | --- | --- |
| 每开一个 App 都重新引导完整 Android（40~142s，CPU/磁盘打满） | 环境只引导一次并常驻；detached qemu 在 ApkStart 退出后仍活着，下次 `adoptExisting()` 接管 + quickboot 快照，点开只做 `am start` + 挂窗口 | `engine.js` / `emulator.js` |
| 之前开过的 App 全留在后台吃内存、拉网络 | 打开新 App 时 `am force-stop` 其他用户 App；关掉最后一个窗口时 `am kill-all` + `deviceidle force-idle` | `container.js` / `Runtime.beginApp()` / `endApp()` |
| qemu 以 Normal 优先级和 Windows 桌面抢 CPU | 启动后降到 `BelowNormal`，容器停放时降到 `Idle`；vCPU 收敛到物理核的 1/4（2~3 核） | `win/priority.ps1` / `doctor.liteProfile()` |
| 没有 App 时同步、通知、窗口巡检仍全速轮询 | 文件同步与通知桥只在有应用窗口时开；窗口巡巡检限在 embed 后 8 秒内；socket 主循环改 50ms 短轮询 | `main.js` / `win/agent.ps1` |

### 关于「APK 转译成 x86」

这一步**不是每次打开时做的**，也已经内置：
- 系统镜像是 x86_64 的，x86 原生 APK 直接跑；
- ARM-only 的 APK 依赖镜像里的 native bridge（Google Play 镜像自带的
  ARM→x86 二进制转译层）在**安装时**完成，运行期按需调用；
- 因此 ApkStart 不需要、也不应该在每次启动时重新「转译」一次。
  「每次打开都转译」反而是最慢的设计。

### 鼠标漂移 / 整机卡顿的根因（已修）

`win/agent.ps1` 曾用 `WH_MOUSE_LL` 全局低级鼠标钩子实现「侧键返回」，
却把它安装在同时阻塞于 `sock.Poll(4000)` 的窗口服务线程上。
Windows 的每一次鼠标事件都要同步等这个线程回来，最长 4 秒；
窗口关闭也不卸载，只要 ApkStart 活着就一直拖慢整个系统。
叠加 `.xz` 展开 / `e2fsck` / `resize2fs` 的首次初始化 I/O 峰值，
前台几乎抢不到资源。

修复：
- 钩子不再无条件常驻：只装到**专用消息线程**（`GetMessage` 循环）上，且只在
  应用窗口处于前台、至少一项鼠标映射开启时安装；失焦/关闭立即卸载；回调只处理
  7 个目标消息，其余（含所有左键事件）一次 `CallNextHookEx` 直接放行；
- 服务主循环 `Poll(4000)` → `Poll(50)`；
- `EnumWindows` + `SetWindowPos(SWP_FRAMECHANGED)` 从「每 2 秒永久」改为
  「embed 后 8 秒内，且不再强制重算非客户区」；
- 首次部署延后 20 秒，避免与冷启动抢 I/O。

### 鼠标键位（左键确认 / 右键返回 / 滚轮滑动）

应用窗口里嵌的是模拟器的 Qt 子窗口，原生映射如下：

| 输入 | Qt 原生行为 | ApkStart 的处理 |
| --- | --- | --- |
| 左键 | 手指点击 / 按住拖动 = 滑动 | **完全不拦截**，直接放行；这就是「确认」 |
| 右键 | 也被当成一次点击，容易误触 | 拦下 `WM_RBUTTONDOWN/UP/DBLCLK`，发 `input keyevent 4`（返回） |
| 滚轮 | 每格单独发一次触摸事件，画面抽搐 | 拦下 `WM_MOUSEWHEEL/MOUSEHWHEEL`，按 60~90ms 窗口合并成一条 `input swipe` |
| 侧键 | 无 | 可选：映射为返回 / 前进（默认关） |

滚轮的合并发生在 `win/agent.ps1`（`PushWheel` / `FlushWheel`），翻译发生在
`core/pointer.js`（`WheelRouter` → `wheelToSwipe`）。注入走 `AdbClient.input()`
的**常驻 `adb shell`**，用 `echo __APKSTART_<id>__` 做回包与背压，
不会每格滚动都 `execFile` 一个 adb 进程，也不会让滑动命令在 shell 里排长队。
坐标按光标在 LCD 内的归一化位置映射，横滚生成水平滑动，转屏后自动刷新分辨率。

钩子只在应用窗口前台时安装，切回桌面或关窗口即卸载；把右键返回、平滑滚轮、
侧键三项全关掉，就一个全局钩子都不装。

### 可配置项（设置 → 鼠标键位 / 性能与轻量容器）

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `engine.mouseRightBack` | `true` | 右键 = 安卓返回；关掉则恢复 Qt 的「右键也当点击」 |
| `engine.mouseWheelMode` | `smooth` | `smooth` 合并注入 / `native` 交给 Qt 逐格处理 / `off` 不拦截 |
| `engine.mouseSideButtons` | `false` | 侧键返回 / 前进；三项全关时不安装全局钩子 |
| `engine.liteMode` | `true` | 收敛 vCPU 配额；关掉后按机器配置自动分配更多核心 |
| `engine.priorityMode` | `balanced` | `performance` 时 qemu 用 Normal 优先级 |
| `engine.deepTrim` | `false` | 额外 `pm disable-user` 一批系统后台包；关闭时自动 `pm enable` 恢复 |

深度裁剪刻意不动 `gms` / `systemui` / webview / 输入法等必需组件
（见 `container.NEVER_TRIM`），避免依赖推送与登录的 App 反复弹错。

### 一次会话的生命周期

```
冷启动（仅首次，或 AVD 被删后）
  materializeImages → e2fsck/resize2fs → boot_completed → saveSnapshot
        ↓
打开 App A：ensure() 接管常驻环境 → am start A → 挂窗口
            → beginApp(A)：停掉其他用户 App、提升优先级、开同步/通知
        ↓
切换到 App B：beginApp(B) → am start B（不重启 Android）
        ↓
关掉最后一个窗口：endApp() → force-stop → am kill-all → deviceidle
            → qemu 降 Idle → 停同步/通知（容器停放，不关机）
        ↓
空闲超过 idleShutdownMinutes：看门狗关掉运行时
（接管来的实例以前因没有本地 proc 句柄而无法回收，已修）
```
