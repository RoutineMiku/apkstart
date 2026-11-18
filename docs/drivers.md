# 驱动（兼容补丁）

> ApkStart 0.5.7 起支持「驱动」扩展：一个驱动 = 一份 JSON 文件，声明
> **匹配哪些机器** + **命中后改哪些启动参数**。
> 用户自己就能给「我这台机器」写补丁，不用等 ApkStart 发版。

---

## 1. 它解决什么问题

同一份默认参数不可能在所有机器上都跑起来：

- 老核显的 GLES 只到 3.1，用 `-gpu host` 时 guest 起来十几秒就崩；
- 机器没开「虚拟机监控程序平台」，走硬件加速必然失败，要直接上软件模拟；
- 某个显卡驱动版本一开 Vulkan 就黑屏，换 `swangle` 就好了；
- 某些屏幕比例 / DPI 组合要改 `hw.lcd.density` 才不糊。

这些差异是**机器属性**，不是程序 bug。把判断写在代码里，等于每次都要发版；
做成数据文件，用户（或社区）发现可用组合后，写一份 JSON 就能分享给别人。

## 2. 放在哪里

| 目录 | 用途 |
|---|---|
| 设置 → 驱动 → **打开驱动目录** | 你自己的驱动，`%APPDATA%\apkstart\drivers\*.json`（商店版在 `%USERPROFILE%\ApkStart\data\drivers`） |
| 安装目录 `resources/app/src/drivers/` | 内置示例，只读，默认 `enabled: false` |

同 `id` 时**用户目录覆盖内置**：想改官方示例，导出/复制到用户目录再改即可，不用动安装目录。

## 3. 一份驱动长什么样

```json
{
  "format": "apkstart-driver/1",
  "id": "amd-igpu-swangle",
  "name": "AMD 核显改用 swangle 渲染",
  "version": "1.0.0",
  "author": "你的名字",
  "description": "说明这台机器为什么要这么改，别人看了一目了然",
  "priority": 0,
  "match": {
    "platform": ["win32"],
    "gpuVendor": ["amd"],
    "totalMB": { "min": 8192 },
    "accel": ["whpx"]
  },
  "effect": {
    "gpuMode": "swangle",
    "forceTcg": false,
    "emulatorArgs": ["-feature=Vulkan"],
    "configIni": { "hw.gpu.mode": "swangle" },
    "env": { "ANDROID_EMUGL_VERBOSE": "1" },
    "notes": ["如果还是黑屏，把 gpuMode 改成 software"]
  }
}
```

### 3.1 顶层字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `format` | ✅ | 固定 `apkstart-driver/1` |
| `id` | ✅ | 字母数字和 `. _ -`，3~64 字符；导入时用它当文件名 |
| `name` | ✅ | 界面上显示的名字（≤80 字） |
| `version` | ✅ | 形如 `1.0.0`；改了补丁记得升版本 |
| `author` / `description` / `homepage` | | 给人看的，方便别人判断能不能用 |
| `enabled` | | 文件里的默认开关；内置示例都是 `false`。界面上的开关优先于它 |
| `priority` | | `-100~100`，默认 0。**越大越晚应用**（覆盖先应用的） |
| `match` | ✅ | 匹配条件，见 3.2 |
| `effect` | ✅ | 命中后改什么，见 3.3 |

### 3.2 `match`：这台机器要不要用

全部条件都必须满足（AND）；一个条件都没写等于不匹配，要「所有机器」请写 `{"any": true}`。

| 键 | 取值 | 说明 |
|---|---|---|
| `any` | `true` | 匹配所有机器（适合做基线兜底） |
| `platform` | `win32` / `linux` | |
| `arch` | `x64` / `arm64` | |
| `gpuVendor` | `nvidia` / `amd` / `intel` / `unknown` | 按显卡名粗分，可写数组 |
| `gpuName` | 正则字符串（≤200 字） | 例如 `"radeon\\s+780m"`，大小写不敏感 |
| `cpuVendor` | 字符串或数组 | 匹配 CPU 型号文本 |
| `accel` | `whpx` / `aehd` / `none` | 当前硬件加速状态；`none` = 只能软件模拟 |
| `osBuild` | 数字或 `{min,max}` | Windows 内部版本号，例如 22631 |
| `totalMB` | `{min,max}` | 物理内存（MB） |
| `cores` | `{min,max}` | 逻辑核心数 |
| `emulatorVersion` | `{min,max}` | 按数字比较，`36.4.9 < 36.4.10` |

设置页里每个驱动都会显示「命中：gpu=amd / accel=whpx」或「本机不匹配」，
不用猜为什么没生效。

### 3.3 `effect`：命中后改什么

| 字段 | 说明 |
|---|---|
| `gpuMode` | 固定渲染后端：`auto` / `host` / `swangle` / `swiftshader` / `swiftshader_indirect` / `software`。`auto` = 不干预 |
| `forceTcg` | `true` = 关掉硬件加速走软件模拟（等价于 `-accel off`） |
| `emulatorArgs` | 追加给 emulator 的参数，`-flag=值` 形式，只允许白名单 |
| `configIni` | 覆盖 AVD 的 `config.ini`，只允许白名单键 |
| `env` | 追加环境变量，只放行 `ANDROID_` / `QEMU_` / `LIBGL_` / `MESA_` / `EMUGL_` 前缀 |
| `notes` | 说明文字，开机日志与设置页会显示 |

`gpuMode` 和 `forceTcg` 会作用于**每一轮**启动尝试（包括自动降级重试）：
驱动说「这台机器只能用 swangle」，就没必要先拿崩过的后端试一遍。

## 4. 白名单：能改什么，为什么

驱动文件可以从网上下载、互相传，所以 ApkStart 对它的权限卡得很死：

**不允许执行任何代码**。驱动是纯 JSON，没有脚本钩子、没有 `eval`、不会 `require` 你写的文件。

**`emulatorArgs` 只接受**

| 参数 | 允许的取值 |
|---|---|
| `-gpu` | 已知渲染后端（见上表） |
| `-accel` | `auto` / `off` / `on` / `whpx` / `hax` / `haxm` / `aehd` / `tcg` |
| `-feature` | 字母数字与 `_,.-`，≤160 字 |
| `-gltransport` | `pipe` / `asgpu` / `virtio` |
| `-qemu` | 单个 qemu 参数，限字符集，≤120 字 |
| 开关型 | `-no-audio` `-no-boot-anim` `-no-metrics` `-no-snapshot` `-no-snapshot-load` `-no-snapshot-save` |

明确拒绝：`-wipe-data`（清空应用与存档）、`-partition-size`、`-datadir`、`-sysdir`、
`-avd`、`-port`、`-http-proxy`。这些要么毁数据，要么破坏 ApkStart 自己管理的落点。

**`configIni` 只接受**：`hw.gpu.mode`、`hw.gpu.enabled`、`hw.gltransport`、`hw.keyboard`、
`hw.audioInput`、`hw.audioOutput`、`hw.camera.back`、`hw.camera.front`、`hw.gps`、
`vm.heapSize`、`hw.lcd.density`。
`disk.dataPartition.size`、`hw.ramSize`、`hw.cpu.ncore`、`image.sysdir.*` 一律拒绝 ——
这些 ApkStart 自己会按设置写，混着改只会互相打架。

**`env`**：`ANDROID_*`、`QEMU_*`、`LIBGL_*`、`MESA_*`、`EMUGL_*`；值 ≤200 字且不能带换行。
`PATH`、`SystemRoot`、`NODE_OPTIONS` 这类会被直接拒。

## 5. 怎么做一份自己的驱动

1. 设置 → 驱动 → **导出本机模板**（`match` 已按当前机器填好，存到驱动目录）；
2. 用记事本 / VS Code 打开，改 `effect`：
   - 黑屏 / 花屏 → 先试 `"gpuMode": "swangle"`，还不行改 `"software"`；
   - 机器没开硬件加速 → `"forceTcg": true`；
   - 改完保存；
3. 回设置页点 **刷新**，看到「本机匹配 / 已生效」；
4. 打开一次应用验证，关机再开一次确认稳定；
5. 想分享：把 JSON 发给别人，对方「导入驱动…」即可。

写坏了不会影响启动：校验不通过的文件只会出现在设置页的错误列表里，
匹配不上的驱动完全不生效。

## 6. 排错

- 开机日志（设置 → 诊断 / `%APPDATA%\apkstart\logs\emulator.log`）会写：
  `drivers: amd-igpu-swangle@1.0.0`，以及每轮实际用的 `-gpu` / `-accel`；
- 设置页每个驱动都会说明「匹配 / 不匹配 / 已停用」以及命中了哪些条件；
- 文件加载失败（JSON 语法错、字段写错、超 256KB）会列出具体文件与原因；
- 想临时排除某个驱动：界面关掉开关即可（写进设置，不删文件）。

## 7. 内置示例

`src/drivers/` 下三个示例，默认**不启用**：

| 文件 | 场景 |
|---|---|
| `example-amd-igpu-swangle.json` | AMD 核显 + 老驱动，`-gpu host` 起来后崩 |
| `example-no-hypervisor-tcg.json` | 没有硬件加速，直接走软件模拟 |
| `example-intel-igpu-software.json` | 老 Intel 核显 GLES 初始化失败 |

它们同时也是文档：照着改 `match` 就能变成「只对我这台机器生效」的补丁。
