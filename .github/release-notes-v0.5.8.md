# ApkStart v0.5.8

这一版解决的是「装完到底能不能跑、要改什么」：新增**本机体检 · 自动配置**。
装完点一次，先查清 CPU 虚拟化、Windows 虚拟机监控程序平台、显卡与显存、内存和系统版本，
能自动改的直接改好，需要提权的给按钮，只能进 BIOS 的说清楚怎么改。

---

## 一、查什么、怎么查

| 项目 | 手段 |
|---|---|
| CPU 虚拟化（VT-x / SVM） | `Win32_Processor` + BIOS 侧标志 |
| Hyper-V / VBS 是否在跑 | `Win32_ComputerSystem.HypervisorPresent` |
| 虚拟机监控程序平台（WHPX） | `Get-WindowsOptionalFeature`；无权限时退到 `WinHvPlatform.dll` + Hypervisor 双重证据 |
| 当前硬件加速是否可用 | `emulator -accel-check`（复用缓存结论） |
| AEHD 驱动 | `System32\drivers\aehd.sys` |
| 显卡 / 显存 / 驱动日期 | `Win32_VideoController` + 注册表 `qwMemorySize`（`AdapterRAM` >4GB 会截断，不可信） |
| 内存 / 系统版本 | `Win32_ComputerSystem` / `os.release()` |

**踩到一个必须写的坑**：Hyper-V / 内存完整性（VBS）接管 VT 之后，
`VMMonitorModeExtensions`、`SecondLevelAddressTranslationExtensions` 会返回 `False`。
本机就是这种情况（AMD 8745HS + WHPX 可用），第一版据此判成「CPU 不支持虚拟化」，
把能跑硬件加速的机器误报成不能跑。现在只有「没有 Hypervisor + 加速也不可用」时才认定不支持，
否则一律标未知。

## 二、自动配置什么

点「应用推荐配置」后只写这几项（都安全、随时可改回来）：

| 设置 | 规则 |
|---|---|
| 内存 | 32GB→8GB / 16GB→6GB / 12GB→4GB / 8GB→3GB / 更小→2GB，且永不超过宿主一半 |
| CPU 核心 | 8 线程以上→4 核；4~7→2~3 核；至少留 1 核给 Windows |
| 画质 | 无加速或显存 <512MB→540×960，否则自动 |
| 渲染后端 | 有加速→交给自动降级链；无加速→`software` |
| 强软件模拟 | 无加速→开 |

同时把这台机器的参数**固化成一份驱动**（`auto-<厂商>-<build>.json`，priority 5），
以后每次开机自动套用，不用重复体检。驱动仍要过 0.5.7 的白名单校验，
体检生成的内容也不能绕开参数限制。

## 三、需要你参与的

| 情况 | 界面 |
|---|---|
| BIOS 里 VT-x / SVM 没开 | 只给步骤（重启进 BIOS → SVM Mode / Intel VT-x → Enabled），**不假装能一键** |
| Windows 功能没开（安装版） | 「一键开启（需管理员）」→ 提权开 HypervisorPlatform + VirtualMachinePlatform → 提示重启 |
| Windows 功能没开（商店版） | 「打开「Windows 功能」窗口」+ 勾选说明（MSIX 固定 mediumIL，无法自行提权） |
| 无加速但 CPU 支持（安装版） | 额外给「安装 AEHD 驱动（需管理员）」 |
| 显卡驱动超过 3 年 | 提醒去厂商官网更新（不自动装驱动，装错版本更糟） |

## 四、界面

设置页新增「本机体检 · 自动配置」：一条一条列结论（绿色 ok / 黄色 warn / 红色 bad），
每条带具体说明和可执行按钮；底部一句话总结 + 推荐配置。
体检耗时约 2~3 秒（一次 PowerShell 拿全部硬件信息，另一次查系统功能；无权限时自动降级）。

## 五、验证

- 新增 `test/preflight-test.js` **22 项**：资源推荐边界、渲染后端建议、BIOS/商店版/安装版三种结论、
  WMI 误判回归、「自动配置只写安全项」、生成的驱动能过驱动校验、探测失败也能给结论；
- 全套纯 Node 测试 **309 项通过**；
- 本机实跑：AMD 8745HS / Radeon 780M / 32GB / WHPX 可用 → `level=good`，
  推荐 6GB + 4 核 + auto 渲染，生成 `auto-amd-26300` 驱动（swangle）。

## 从 0.5.7 升级说明

- `0.5.8.0 > 0.5.7.0`，商店可直接覆盖升级；已装应用、存档、快照都保留。
- 体检**不会自动运行**：不点「开始体检」就不做任何探测、不改任何设置。
- 之前手动配过内存/核心的用户：体检推荐值会覆盖这两项（这是「应用推荐配置」的本意），
  不想覆盖就别点应用，只看报告。

## 微软商店

- 包体：`dist/store/ApkStart_0.5.8.0_x64.msix`（x64，约 850 MB，内置完整运行时）
- 身份：`RoutineMiku.ApkStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- 提交材料：`docs/store-listing.md`（含本版 What's new 中英文段）
- 文档：`docs/preflight.md`（体检）、`docs/drivers.md`（驱动）
