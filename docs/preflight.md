# 本机体检 · 自动配置

> 0.5.8 起，设置页有「开始体检」：先查清这台机器能不能跑、要改什么，
> 能自动改的直接改，需要提权的给按钮，只能进 BIOS 的说清楚怎么改。

## 1. 查什么

| 项目 | 怎么查 | 查不到时 |
|---|---|---|
| CPU 虚拟化（VT-x / SVM） | `Win32_Processor` 的 `VirtualizationFirmwareEnabled` / `VMMonitorModeExtensions` | 记「未知」，提示手动确认 |
| Hyper-V / VBS 是否在跑 | `Win32_ComputerSystem.HypervisorPresent` | 未知 |
| 虚拟机监控程序平台（WHPX） | `Get-WindowsOptionalFeature -FeatureName HypervisorPlatform`；无权限时退到 `WinHvPlatform.dll` + Hypervisor 是否存在 | 未知（按「功能可用」处理需两个证据齐全） |
| 硬件加速当前是否可用 | `emulator -accel-check`（复用 provisioner 的缓存结论） | 视为不可用 |
| AEHD 驱动 | `%SystemRoot%\System32\drivers\aehd.sys` | 视为未安装 |
| 显卡 / 显存 / 驱动版本 | `Win32_VideoController` + 注册表 `HardwareInformation.qwMemorySize`（`AdapterRAM` 在 >4GB 时会被截断，不可信） | 显卡未知 |
| 内存 / 系统版本 | `Win32_ComputerSystem`、`os.release()` | — |

**WMI 的坑**：Hyper-V / 内存完整性（VBS）一旦接管 VT，`VMMonitorModeExtensions`
和 `SecondLevelAddressTranslationExtensions` 会返回 `False` —— 但机器明明能跑硬件加速。
所以这两个字段为 `False` 时，只有在「没有 Hypervisor、加速也不可用」的情况下才判定
「不支持虚拟化」，否则一律当未知。否则会把好好的机器误判成不能跑。

## 2. 自动改什么

体检完成后点「应用推荐配置」，只写这几项（都是安全项，随时能在设置里改回来）：

| 设置 | 规则 |
|---|---|
| `memoryMB` | 32GB 主机 → 8GB；16GB → 6GB；12GB → 4GB；8GB → 3GB；更小 → 2GB。且永不超过宿主一半 |
| `cores` | 8 线程以上 → 4 核；4~7 → 2~3 核；最少留 1 核给 Windows |
| `renderSize` | 无硬件加速、或显存 <512MB → `540x960`；否则 `auto` |
| `gpuMode` | 有加速 `auto`（交给降级链）；无加速 → `software` |
| `forceTcg` | 无硬件加速 → `true` |

同时把这台机器的参数固化成一份驱动（`%APPDATA%\apkstart\drivers\auto-<厂商>-<build>.json`，
`priority: 5`），以后每次开机自动套用，不用重复体检。
驱动同样要过白名单校验 —— 体检生成的内容也不能绕过参数限制。

## 3. 需要用户参与的

| 情况 | 界面给什么 |
|---|---|
| BIOS 里 VT-x / SVM 没开 | **只给手动指引**（重启进 BIOS → Intel VT-x / SVM Mode → Enabled）。这一步物理上无法代做 |
| Windows 功能没开（安装版） | 「一键开启（需管理员）」→ 提权执行 `dism` 开 HypervisorPlatform + VirtualMachinePlatform → 提示重启 |
| Windows 功能没开（商店版） | 「打开「Windows 功能」窗口」—— MSIX 固定 mediumIL，不能自行提权，只给入口和勾选项 |
| 没有加速且 CPU 支持虚拟化（安装版） | 额外给「安装 AEHD 驱动（需管理员）」 |
| 显卡驱动太旧（>3 年） | 只提醒去厂商官网更新，不自动装驱动（装错版本更糟） |

## 4. 结论等级

- `ok`：这一项没问题；
- `warn`：能用，但建议优化（内存偏小、驱动旧、系统版本低、读不到硬件信息）；
- `bad`：不处理就跑不起来（BIOS 没开虚拟化、Windows 功能没开）。

体检整体等级取最差的一项；界面上每条都有颜色点和具体说明，不写「未知错误」。

## 5. 隐私

探测全部在本机完成：只读 WMI / 注册表 / 系统文件是否存在，不发请求、不上传任何信息。
导出的诊断报告里也只有型号、驱动版本、内存这些排查必需的字段。
