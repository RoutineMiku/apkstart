# ApkStart v0.5.6

这一版只做一件事，但做得彻底：**把「第三方模拟器底座」整条链路删掉**。

从这一版起，ApkStart **无论什么情况都独立运行**：只用自己的 adb / emulator / 系统镜像，
不探测、不接管、不驱动、也不依赖你电脑上装的任何模拟器（MuMu / 雷电 / 蓝叠 / WSA / FydeOS 都不接）。

0.5.5 已经做到了「包里不带别人的模拟器、默认用自带运行时」，但代码里还留着 mumu / fydeos /
attach 三种底座和「不可用就回退」的判断。只要那条路还在，用户在设置里切一下、
或者导入一份旧 `settings.json`，ApkStart 就又会跑去驱动别人家的模拟器 —— 数据、存档、
镜像落在哪里都说不清，对方一升级或换端口还会直接失效。这一版把路拆了，不是关掉。

---

## 一、只有一个运行时

- `src/core/backends/` 现在只有 `base.js` / `builtin.js` / `index.js`：
  `mumu.js`（842 行）、`fydeos.js`（365 行）、`mumu-compat.js`、`frame.js` 全部删除。
- 注册表固定为 `['builtin']`，`create()` **故意忽略 `settings.engine.mode`**：
  残留的 `mode=mumu`、`fydeos`、`attach`、以及手改出来的任何值，一律创建自带运行时。
- 没有「自动挑选」了：不再扫描第三方模拟器的安装目录、注册表、adb 端口。
  `autoPick()` 直接返回 builtin，源码里一次 `probe()` 都不调用。
- 顺手去掉一个隐患：`adb` 的候选路径以前包含 MuMu / 雷电 / 蓝叠自带的 adb。
  用它们的 adb 会继承别人的 server 状态（端口、授权、offline 抖动），现在只认
  Android SDK 与手动安装目录，自己那份永远排第一。

## 二、旧配置不会把第三方带回来

- `store.getSettings()` 读盘时强制 `engine.mode = 'builtin'`，并删掉
  `mumuPath / mumuIndex / mumuRenderProfile / mumuMemoryGB / mumuCores / fydeosHost` 这些残留字段。
- 只改内存里的对象，不立刻回写磁盘：设置文件是用户的，等他下次保存设置时自然落盘。
- 引擎里的 `_fallbackFrom` 回退标记、`backendAvailable()` 分叉、`attach` 分支、
  `ATTACH_ENDPOINTS`（WSA / LDPlayer / MuMu / Nox / MEmu 的固定端口）全部移除。

## 三、设置页更简单

- 「引擎模式」下拉删除，换成一行只读说明：*ApkStart 自带运行时（QEMU + Android 14，独立运行）*。
- 「MuMu 安装目录」「FydeOS 地址」「设备地址 + 探测按钮」「MuMu 实例资源分配」四组控件删除。
- 内存 / CPU 核心 / 数据分区仍然可以自己分配（那是 0.5.5 加的，走 qemu 参数，与第三方无关），
  上限依旧按宿主内存、核心数、磁盘剩余算。

## 四、构建期守卫加严

`build/guard-standalone.js` 以前只拦「模拟器二进制和目录」，现在连**适配器源码**也拦：
打包产物里出现 `backends/mumu.js`、`backends/fydeos.js`、`core/mumu-compat.js`、
`core/frame.js` 任何一个，构建直接 `exit(4)`。
这样「又留一条能接管别人模拟器的路」不会悄悄进包。

## 五、验证

- 全套纯 Node 测试 **258 项通过**，`scripts/selftest.js` 对着真实运行的 `emulator-5554` **9/9 通过**
  （设备、Android 版本、分辨率、freeform、共享目录双向同步）。
- 独立运行测试从 15 项扩到 22 项，新增：注册表只有 builtin、各种残留 mode 只创建 builtin、
  显式 `id=mumu` 也压不过去、第三方模块文件必须不存在、设置页不再有引擎下拉、
  持久化层改写过期字段、adb 候选不含第三方 adb、守卫拦适配器源码且不误伤 `builtin.js`。

## 从 0.5.5 升级说明

- `0.5.6.0 > 0.5.5.0`，商店可直接覆盖升级。
- 已装的安卓应用、存档、quickboot 快照都保留，不需要重装。
- 之前把引擎切成 MuMu / FydeOS / attach 的用户：升级后自动回到自带运行时，
  设置页会显示只读的运行时说明；第一次开机可能因为要重新引导自带运行时多等十几秒。
- 之前用第三方模拟器时的应用和数据在那边，不在这里；需要的话重新拖一次 APK 安装即可。

## 微软商店

- 包体：`dist/store/ApkStart_0.5.6.0_x64.msix`（x64，约 850 MB，内置完整运行时）
- 身份：`RoutineMiku.ApkStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- 提交材料：`docs/store-listing.md`（含本版 What's new 中英文段）
- 步骤：`docs/store-upload-walkthrough.md`
