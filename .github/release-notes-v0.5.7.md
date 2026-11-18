# ApkStart v0.5.7

这一版加的是**驱动（兼容补丁）扩展**：机器跑不起来时，不用等 ApkStart 发新版，
自己写一份 JSON 补丁就能把参数改对，还能分享给别人。

安装包依旧独立运行、只带自己的运行时 —— 驱动改的是**我们自己的 emulator 启动参数**，
不涉及任何第三方模拟器。

---

## 一、为什么需要驱动

同一份默认参数不可能覆盖所有机器。实际踩到的例子：

- AMD 核显 + 老驱动：`-gpu host` 能通过 emulator 自检，但 guest 起来十几秒后进程直接崩
  （日志里只有 `AEHD is operational`）→ 换 `swangle` 就好；
- 机器没开「虚拟机监控程序平台」：走硬件加速必然失败，应该一开始就 `-accel off`；
- 老 Intel 核显：GLES 初始化失败 / 花屏 → 用 `software` 渲染；
- 某些屏幕比例 + DPI 组合要改 `hw.lcd.density` 才不糊。

这些是**机器属性**，不是程序 bug。写死在代码里等于每次都要发版；做成数据文件，
发现可用组合的人写一份 JSON 就能帮到同型号的机器。

## 二、驱动是什么

一份驱动就是一个 JSON：

```json
{
  "format": "apkstart-driver/1",
  "id": "amd-igpu-swangle",
  "name": "AMD 核显改用 swangle 渲染",
  "version": "1.0.0",
  "match": { "platform": ["win32"], "gpuVendor": ["amd"], "accel": ["whpx"] },
  "effect": { "gpuMode": "swangle", "notes": ["如果还是黑屏，改成 software"] }
}
```

- `match`：这台机器要不要用（显卡厂商 / 型号正则 / 内存 / 核心 / 系统版本号 / 加速状态 / emulator 版本）；
- `effect`：命中后改什么（`gpuMode`、`forceTcg`、`emulatorArgs`、`configIni`、`env`、`notes`）；
- `priority`：多个驱动同时命中时，大的后应用（覆盖前面的）。

完整字段表与白名单见 **`docs/drivers.md`**，内置三个示例在 `src/drivers/`。

## 三、安全边界（重要）

驱动文件可以从网上下载、互相传，所以：

1. **只认 JSON，不执行任何代码** —— 没有脚本钩子、没有 `eval`、不会 `require` 驱动里的东西；
2. **参数白名单** —— `-gpu` / `-accel` / `-feature` / `-gltransport` / 单个 `-qemu` 与几个开关型参数；
   `-wipe-data`、`-partition-size`、`-datadir`、`-sysdir`、`-avd`、`-port` 一律拒绝（会删数据/改落点）；
3. **config.ini 白名单** —— 只允许 `hw.gpu.*` / `hw.gltransport` / `hw.keyboard` / `hw.audio*` /
   `hw.camera.*` / `hw.gps` / `vm.heapSize` / `hw.lcd.density`；数据分区、内存、CPU 核数不接受外部改；
4. **env 白名单** —— 只放行 `ANDROID_` / `QEMU_` / `LIBGL_` / `MESA_` / `EMUGL_` 前缀，
   `PATH` / `SystemRoot` / `NODE_OPTIONS` 直接拒；
5. 单一文件 ≤256KB，坏文件只记录错误、不影响其它驱动；匹配不上完全不生效。

## 四、界面

设置页新增「驱动 · 兼容补丁」：

- 列出每个驱动的名字、版本、作者、命中条件、是否生效；
- 开关：内置示例默认关，点一下启用（写进设置，不改只读的安装目录）；
- **导入驱动…**：选 JSON → 校验 → 存到 `%APPDATA%\apkstart\drivers\<id>.json` → 立刻启用；
- **打开驱动目录** / **导出本机模板**（`match` 已按当前机器填好，改 `effect` 就能用）；
- 加载失败的文件会在列表下方逐条说明原因（JSON 语法、字段写错、超限）。

## 五、接进启动链路

- 开机前解析一次：把命中的驱动叠成一份效果（`priority` 小的先、大的后覆盖）；
- `gpuMode` / `forceTcg` 作用于**每一轮**启动尝试（包括自动降级重试）——
  驱动说「这台机器只能用 swangle」，就没必要先拿崩过的后端再试一遍；
- `emulatorArgs` 追加到命令行（`-gpu` / `-accel` 由前两项统一处理，避免重复参数）；
- `configIni` 就地覆盖 `config.ini` 里的同名键，缺的追加；
- `env` 合并进 emulator 进程环境；
- 开机日志写一行 `drivers: amd-igpu-swangle@1.0.0`，导出的诊断报告里也看得到。

## 六、验证

- 全套纯 Node 测试 **287 项通过**，其中驱动 **29 项**：校验、匹配、叠加、开关、
  读盘容错、导入导出、白名单拒绝（`-wipe-data` / `-partition-size` / `PATH` / 换行注入）、
  以及「`buildArgs` / `env` / `config.ini` 真的用上了驱动效果」；
- `scripts/selftest.js` 9/9（真实 `emulator-5554`）；
- MSIX 0.5.7 已重建，载荷内不含任何第三方模拟器文件，源码与包内一致。

## 从 0.5.6 升级说明

- `0.5.7.0 > 0.5.6.0`，商店可直接覆盖升级；已装应用、存档、快照都保留。
- 默认**不会**启用任何驱动：内置示例是 `enabled:false`，行为与 0.5.6 完全一致。
- 想给机器打补丁：设置 → 驱动 → 导出本机模板 → 改 `effect` → 刷新。

## 微软商店

- 包体：`dist/store/ApkStart_0.5.7.0_x64.msix`（x64，约 850 MB，内置完整运行时）
- 身份：`RoutineMiku.ApkStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- 提交材料：`docs/store-listing.md`（含本版 What's new 中英文段）
- 驱动文档：`docs/drivers.md`
