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
