# ApkStart

<p align="center"><img src="docs/images/logo.png" alt="ApkStart Logo" width="160" /></p>

[![CI](https://github.com/RoutineMiku/apkstart/actions/workflows/ci.yml/badge.svg)](https://github.com/RoutineMiku/apkstart/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/RoutineMiku/apkstart?include_prereleases&sort=semver)](https://github.com/RoutineMiku/apkstart/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D6.svg)](#)

**Windows 上的安卓应用运行器 —— 让安卓应用像 Windows 原生软件一样被安装和使用。**

- 🖱️ **双击 .apk 即安装**：注册 .apk 文件关联后，在资源管理器里双击 APK，自动解析 → 安装 → 生成桌面图标，全程无需打开任何模拟器界面。
- 🧩 **每个应用一个桌面图标**：图标从 APK 内部离线提取并转为多尺寸 ICO，双击桌面图标 = 直接启动该应用，与打开一个原生 Windows 软件的体验一致。
- 🪟 **应用就是一个窗口**：运行时以**带窗口**模式启动（无头模式下 Android 不出 VSYNC，应用进程活着但屏幕上是空的），ApkStart 把这块窗口改标题、换真实应用图标、按竖屏比例摆好位置，就是一个独立应用窗口；**全屏**铺满屏幕高度并居中，**窗口模式**可自由拖动缩放且按应用记忆尺寸。
- 🔍 **能被 Windows 搜到**：安装后同时创建桌面 + 开始菜单（`程序\ApkStart\`）快捷方式，按应用名在开始菜单搜索即可直达，任务栏按应用分组。
- 📁 **数据互通**：`%USERPROFILE%\ApkStartShared` ↔ 安卓内 `/sdcard/ApkStartShared` 持续双向同步，安卓应用存下的文件直接出现在本机。
- 🪶 **极致轻量**：壳层本身零第三方依赖（连 ZIP / PNG / ICO / AXML 解析都是手写的），运行时按需拉起，空闲自动回收；也可以完全复用你机器上已有的安卓运行时，额外占用为零。

![主界面](docs/images/app.png)

```
┌────────────────────────────────────────────────────────────┐
│  桌面图标（真实应用图标 .lnk）                              │
│      │  双击                                               │
│      ▼                                                     │
│  ApkStart.exe --launch <包名>                              │
│      │  运行时未启动？→ 自动拉起（Android Emulator + API34）│
│      ▼                                                     │
│  按系统解析出的 LAUNCHER 入口启动（不是 APK 里的主 Activity）│
│      │  存活观察 18 秒，闪退自动重试 / 重置数据 / 补权限     │
│      ▼                                                     │
│  模拟器窗口 = 应用窗口（改标题、换图标、竖屏比例、全屏居中） │
└────────────────────────────────────────────────────────────┘
```

## 下载即用（不想编译）

到 [Releases](https://github.com/RoutineMiku/apkstart/releases) 下载安装包：

- **`ApkStart-v*-Setup.exe`**（约 1.0~1.1 GB）：**一个 EXE 包含全部运行时**（adb / Android Emulator / 系统镜像），装完首次启动自动把镜像展开到用户目录，**之后不再联网下载任何东西**。装到当前用户目录、不要求管理员权限。
- 另有轻量版 `ApkStart-v*-win64-portable.zip`（约 100 MB）：首次启动才在后台下载运行时。

**开箱即有的默认行为**（不用去设置里找）：

- 开机自动启动，常驻托盘；双击桌面图标直接进应用。
- 安装 APK 后自动创建**桌面 + 开始菜单**两份快捷方式，Windows 搜索能直接搜到应用名；老版本漏建的会在启动时自动补齐。
- 应用窗口是原生渲染（非投屏）：**全屏**铺满屏幕高度并居中、保持手机比例不变形；**窗口模式**保持竖屏，可自由拖动缩放，每个应用的尺寸单独记忆。随时按 `F11` 或右键托盘切换。
- 安装后自动授予应用申请的运行时权限，不会卡在系统授权框；应用闪退会自动重试、必要时重置应用数据后再拉起。
- **网络直接用主机的网络**：安卓侧走 QEMU 用户态 NAT，出口复用主机的物理网卡，**不会在 Windows 上创建任何虚拟网卡 / 虚拟交换机**（不需要装驱动、也不多一个网络适配器）。不需要联网下载、不需要改任何网络设置。

## 从源码构建

```powershell
# 1. 安装依赖（含 Electron 运行时）
npm install

# 2. 启动并完成运行时部署（一次性下载 adb / Android Emulator / 系统镜像）
npm start

# 3.（可选）注册 .apk 双击安装
npm run assoc:on

# 4. 打包便携版（免安装，可直接分发）
npm run pack
# 产出 dist/ApkStart-win64-portable/ApkStart.exe
```

### 单文件 EXE（内置完整运行时，装完不再联网）

如果希望「一个 EXE 发出去，对方双击就能跑，不用等下载」，用这条：

```powershell
# 先把 engine/ 整理成可分发运行时（system.img 压成 .gz，3.1GB → 约 580MB；
# 同时裁掉 emulator 里用不到的部分：arm64 的 QEMU、Vulkan 后端、多语言包，约 -190MB）
npm run runtime

# 再打成安装版 EXE（electron-builder nsis 目标，装到当前用户目录）
npm run build:exe
# 产出 dist/release/ApkStart-<版本>-Setup.exe
```

体积构成（实测）：Electron 约 180MB、emulator 瘦身后约 340MB、系统镜像压缩后约 580MB，
最终安装包约 1.0～1.1GB。能再压的硬下限就在 system.img 那条（它就是安卓系统本身，无法再裁）。
网络默认走主机 NAT，不创建虚拟网卡，所以也不依赖任何额外驱动。

首次启动会把 `.gz` 镜像展开到 `%APPDATA%\apkstart\system-images`（约 1 分钟，只做一次），
之后每次直接复用。AVD 与已装应用固定存放在 `%APPDATA%\apkstart\avd`，
即使便携版每次解压到临时目录也不会丢。

## 运行时说明：完全独立，不依赖任何第三方模拟器

ApkStart 是一个**自持**的项目，运行时组件全部由自己下载、校验和管理（位于 `%APPDATA%\apkstart\runtime`）：

| 组件 | 来源 | 大小 | 用途 |
|---|---|---|---|
| adb（platform-tools） | dl.google.com 官方源 | ~8 MB | 安装/启动安卓应用 |
| Android Emulator | dl.google.com 官方源（8 线程并行下载） | ~440 MB | 运行时引擎（自带设备模型与 GPU 转译） |
| Android 14 通用系统镜像（Google Play x86_64） | dl.google.com 官方源 | ~1.5 GB | 唯一的基础层：x86 应用、仅含 ARM 库的应用、GMS 都能跑，镜像即系统，无需安装 |
| AEHD 驱动（可选） | dl.google.com 官方源 | ~0.2 MB | 硬件加速（或用 Windows「虚拟机平台」WHPX） |

首次使用时，「运行时」页会引导完成以上部署（**一键部署**）：
1. adb 与运行时引擎、系统镜像自动下载（官方源实测 10+ MB/s）；
2. 部署完成后**自动开机**，之后双击桌面图标自动拉起，全程无感。

![运行时部署向导](docs/images/setup.png)

**设备兼容性（自动处理，无需干预）**

- 没有硬件加速时自动回退软件模拟；启动失败按「渲染后端 → 加速方式 → 内存/冷启动」最多 4 组参数自动重试。
- `-gpu` 按引擎版本自动选择（37.x 用 `software`，老版本用 `swiftshader_indirect`），不再使用已弃用的模式。
- 内存/核心数按物理内存自动推导（2–4 GB / 2–4 核），数据分区从 16 GB 降到 4 GB；端口动态挑空闲的，中文路径自动转短路径，AVD 锁文件自动清理。
- 失败原因会翻译成中文并附上修复建议；设置里可「导出诊断报告」。
- 大文件下载默认 **8 线程分块 + 断点续传**，不支持 Range 的源自动回退单流。
- 高级用户也可以在设置里切换为「连接已有运行时」（复用 WSA 等的 adb 端口），但这只是可选项，不是依赖。
- 高级路径：也可以在设置里「连接已有运行时」，复用你机器上其它模拟器（WSA / MuMu 等）已经跑起来的 adb 端口。

**容器式低成本运行**

- **只读基础层**：`system-images/` 全机一份，所有应用共享，不再同时存 AOSP + 兼容两套镜像。
- **薄可写层**：单个 AVD 用差量用户数据 + 命名 quickboot 快照；只有「冷启动确实慢 / 没有硬件加速」的机器才会在正常退出时保存快照（实测加载约 3.5 秒），快机器不额外占 2–4 GB 磁盘。
- **按需下载**：遇到仅含 ARM 原生库的应用才会补齐通用镜像；`.apks` / `.xapk` 拆分包自动用 `install-multiple` 安装。
- **可回收**：构建时裁掉非 x86_64 的 QEMU 目标（约 400 MB）；设置页可清理旧镜像、旧快照、锁文件和遗留 AVD。

## 目录结构

```
apkstart/
├─ src/
│  ├─ main.js              主进程：窗口/托盘/单实例/命令行分发/IPC
│  ├─ preload.js           安全桥接
│  ├─ ui/                  渲染层（原生 HTML/CSS/JS，无框架）
│  └─ core/
│     ├─ zip.js            极简 ZIP 读取器（按需解压）
│     ├─ axml.js           Android 二进制 XML 解析
│     ├─ arsc.js           resources.arsc 资源表解析（应用名/图标路径还原）
│     ├─ apk.js            APK 元信息：包名/版本/启动 Activity/图标/ABI
│     ├─ png.js            零依赖 PNG 编码器 + 程序图标绘制
│     ├─ shortcut.js       多尺寸 ICO 生成 + .lnk 快捷方式
│     ├─ assoc.js          .apk 文件关联（HKCU，免管理员）
│     ├─ adb.js            adb 客户端（安装/启动/同步/截图/…）
│     ├─ engine.js         运行时管理：探测/模拟器托管/空闲回收
│     ├─ sharer.js         本机 ↔ 安卓共享目录双向同步
│     ├─ installer.js      安装流水线编排
│     └─ store.js          应用清单与设置持久化
├─ engine/                 运行时组件下载缓存（emulator / system-images / platform-tools）
├─ tools/platform-tools/   便携 adb 放置处
├─ test/                   单元测试 + Electron 集成测试 + 冒烟截图
├─ build/pack.js           便携版打包
└─ scripts/assoc.js        .apk 关联命令行开关
```

## 命令行

```
ApkStart.exe                      打开主界面
ApkStart.exe <路径\to.apk>        安装 APK
ApkStart.exe --launch <包名>      直接启动应用（桌面快捷方式使用此参数）
```

## 测试

```powershell
npm test                                   # 纯 Node 单元测试 + 引擎链路测试（不需要网络）
npm run test:boot                          # 真实引导测试：用 61MB Alpine guest 验证 QEMU 参数/建盘/优雅关机
npm run selftest                           # 运行时自检：装好 Android 后一键验证 安装→启动→截图→共享目录
electron test/electron-integration.js      # ICO / 快捷方式集成测试
electron . --smoke test\shot.png           # 启动应用并截图（界面冒烟）
```

`npm run selftest` 是装好系统后的「验收命令」——它会对当前设备依次检查 adb 连接、
Android 版本、freeform 支持、共享目录双向同步，加 `--apk 某应用.apk` 还会完整走一遍
安装 → 独立窗口启动 → 前台确认 → 截图。

## 设计取舍（诚实说明）

- **不是从零实现的 hypervisor**：安卓内核、GPU 转译、ART 运行时是数年级别的工程，本项目选择站在 AOSP/QEMU/adb 的肩膀上，把工程量集中在「原生应用级体验」上——这正是应用宝电脑版、Google Play Games PC 版等产品共同的架构思路。
- **共享目录是同步而非挂载**：Windows 无 root 时无法在安卓侧挂载 NTFS 目录，采用秒级双向同步达到同等体验。
- **ARM-only 应用 / 字节系应用**：设置里开启「ARM 兼容模式」即可切换到 **Android 14（API 34）Google Play 镜像**（内置新版 ndk_translation 翻译层），仅含 ARM 原生库的应用可以安装运行。**实测红果免费短剧（com.phoenix.read，arm64-v8a-only）可正常安装、进入推荐流并播放视频**——旧版 API 30 镜像上会因字节系自带非标准 signal handler 触发翻译层保护性断言（`DoBadTrampoline` SIGABRT），Android 14 镜像的新版翻译层已修复。个别应用自带更深的反模拟检测（如强制校验真实传感器/基带），仍可能受限；安装失败或启动崩溃时 ApkStart 会给出中文说明。

| 兼容模式下运行红果免费短剧（Android 14 · AEHD 硬件加速） |
|:---:|
| ![红果短剧在 ApkStart 兼容模式运行](docs/images/compat-hongguo-playing.png) |

## 关于作者

ApkStart 由 **RoutineMiku** 开发维护。

- GitHub：<https://github.com/RoutineMiku/apkstart>
- 微信公众号：扫码关注

<p align="center"><img src="docs/images/brand.png" alt="关于面板：公众号二维码与项目链接" width="560" /></p>

<p align="center"><i>Powered by <b>RoutineMiku</b></i></p>

## 参与贡献

欢迎 Issue / PR。壳层保持零第三方依赖，提交前请跑 `npm test`；细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)。发行包只含 ApkStart 自身代码与 Electron 运行时，不分发安卓系统镜像、QEMU 二进制或 Google 组件；这些由用户本机首次启动时从官方源按需下载，遵循各自的许可协议。
