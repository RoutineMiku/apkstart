## 这一版解决什么

### 1. 打开 ApkStart 会把微信（以及其它 Qt 应用）的窗口弄没

这是上一版最严重的问题。窗口代理原来靠**窗口类名**认自己的窗口：

- `FindEmulator()` 认「类名含 `QWindowIcon`」的窗口 —— 这是**所有 Qt 顶层窗口**的类名；
- `HideToolWindows()` 认「类名含 `QWindowTool`」的窗口 —— 而 Qt 的菜单、表情面板、
  悬浮小窗用的正是 `QWindowToolSaveBits`；
- 常驻压制每 120ms 扫一轮，扫到就 `ShowWindow(h, 0)`；`embed` / `park` 还会对它 `SetParent`。

微信 4.x 恰好就是 Qt 6（`Weixin.dll` 里有 `QWindowToolSaveBits` / `Qt6` 字符串），
主窗口类名是 `Qt51514QWindowIcon` —— 和模拟器一模一样。于是「打开 ApkStart，
微信窗口消失/被嵌进 ApkStart 变成黑块」就发生了。

**同一台机器上的实测对比**（微信 4.1.7.59，主窗 296×388）：

| 版本 | 微信窗口状态 |
|---|---|
| 0.3.3 | 启动 3.7 秒后 `hidden`，之后 74 次采样全部隐藏 |
| 0.3.4 | 45 秒 / 280 秒两轮全程 `visible`，隐藏 0 次 |

**修法：类名不是身份，进程路径才是。**

- 新增 `scope` 命令：主进程在压制/嵌入之前下发「我们的目录」（运行时根目录 + 随包的
  `engine` 目录）和主进程 pid；
- 所有窗口判定先过 `IsOurs(pid)`：进程可执行文件必须落在这些目录之内；
- **没有 scope 时一个窗口都不动** —— 宁可漏一个黑窗，也绝不藏别人的窗口；
- 控制台黑窗不再用「标题含 emulator/qemu/netsim」这种模糊匹配，改成 conhost 的父进程链
  能走到运行时目录，或标题里出现运行时目录的绝对路径；
- `embed` 校验宿主窗口的 pid 必须等于主进程 pid，否则拒绝（防止句柄回收后把窗口嵌进别人的应用）；
- 鼠标钩子里加 `IsWindow(_host)` 与宿主 pid 校验，句柄失效就一律放行；
- 旋转（Ctrl+←/→）只在自己窗口是前台时才发全局按键，否则干脆不发；
- 代理进程重建后重新下发 scope，否则新代理什么都不敢碰。

### 2. Gitee 上也放一个能直接双击解压的整包（不再是 part1/part2）

- 换压缩器：`Compress-Archive`（.NET deflate）→ 7-Zip `-mx=9`，同一目录 **105.2MB → 99.8MB**；
- 删掉包内的 `d3dcompiler_47.dll`（Windows 8.1 起 `System32` 自带同名 DLL，实测渲染无差异），
  再省 2.1MB；`vk_swiftshader` / `vulkan-1` 保留 —— GPU 驱动不可用时靠它兜底；
- 最终 **95.0 MiB**，在 Gitee 单文件上限（100MB）以内，下载下来直接解压即可；
- 新增 `build/zip.js`：压完用应用自己的 zip 解析器核对条目数与解压总字节，
  **超过 100MiB 直接让 CI 失败** —— 以后包变胖会当场炸，而不是又悄悄退回分片包。

### 3. 「双源自动选优」之前其实没生效

同名资产按名字去重、谁先来用谁，GitHub 排在前面，**Gitee 的同名地址被直接丢掉**。
整包不再分片以后，等于永远只走 GitHub。

- 同名资产改为合并 `urls`，并按地址分别记 `size`（两个源压出来的字节数本来就不同）；
- 下载前测速择优；`downloadMulti` 的「只混用声明大小一致的源」改为以**最快那个源**的
  总大小为基准（原来固定取 `Math.max`，等于总去下体积更大的那个源）；
- 实测本机四个候选（GitHub 直连 / ghfast / gh-proxy / Gitee）里最快的是 Gitee，
  95.2MB / 48 秒（约 2 MB/s）。

### 4. 其它

- 代理的「守窗」判定只认自己运行时里的进程，别的模拟器（MuMu / 雷电自带的 emulator.exe）
  不会再让代理多守 3 分钟；
- 工具脚本（`check-agent` / `check-console` / `check-windows` / `check-launch-clean` /
  `check-quit-clean`）同步补上 scope。

## 验证记录

| 项目 | 结果 |
|---|---|
| 单元 + 集成测试 | run-tests 3 / auto-test **70 通过，0 失败** |
| 端到端（真实运行时 + 真实 AVD + 红果 APK） | 安装 → 打开 → 嵌入全部通过；应用窗口 0.5 秒出现；泄漏窗口累计 **0** |
| 微信（4.1.7.59）共存 | 模拟器启动 / 装应用 / 嵌入全过程，微信窗口 hidden **0** 次 |
| Gitee 整包 | 95.18 MiB，`Expand-Archive` 5.2 秒解压，69 个文件 md5 与源目录一致 |
| 从 Gitee 实下 | 95.2MB / 48 秒，zip 结构完整 |

## 下载

- 轻量版 `ApkStart-v0.3.4-win64-portable.zip`（**95 MB**，解压即用，首次启动再下运行时）：
  GitHub 与 Gitee 都是**一个完整 zip**，不需要再拼接分片。
- 完整版 `ApkStart-0.3.4-Setup.exe`（约 1.35 GB，内置 adb / 模拟器 / 系统镜像，装完即离线可用）：
  体积超过 Gitee 单文件上限，只放在 GitHub。
