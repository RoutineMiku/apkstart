# 运行时引擎目录（手动放置，可选）

**从 0.2 起，ApkStart 默认完全自持**：adb、QEMU、系统镜像由应用自动下载部署到
`%APPDATA%\apkstart\runtime\`，不需要手动准备任何东西。

本目录仅用于以下两种情况：

## 1. 手动放置 QEMU（下载源被墙 / 想用指定版本）

```
engine/qemu/
├─ qemu-system-x86_64.exe
├─ qemu-img.exe
└─ …（其余 QEMU 文件）
```

QEMU 官方 Windows 构建地址：https://qemu.weilnetz.de/w64/
（`qemu-w64-setup-*.exe` 是 NSIS 安装包，ApkStart 会用 `/S /D=` 静默安装到运行时目录；
你也可以用 7-Zip 直接解压安装包后放到上面的位置）

## 2. 手动放置 adb

```
tools/platform-tools/
└─ adb.exe
```

下载地址：https://developer.android.com/tools/releases/platform-tools

## 系统镜像

- 推荐：Android-x86 9.0-r2（x86_64），应用内可直接下载（多镜像、断点续传）
- 或导入：任意已安装好 Android 的磁盘镜像（qcow2 / raw / vmdk），在「运行时 → 导入」选择
- 导入后 ApkStart 直接从磁盘引导，无需安装步骤

## 硬件加速

QEMU 使用 WHPX 加速：控制面板 →「启用或关闭 Windows 功能」→ 勾选「虚拟机平台」→ 重启。
未启用时 ApkStart 自动回退纯软件模拟（TCG），首次启动较慢。
