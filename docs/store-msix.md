# 微软商店（MSIX）版本

这个目录里的脚本和应用改动，目的是产出一个**「一次下载、装完即用」**的 Microsoft Store
安装包：里面已经包含 Android 模拟器、platform-tools 和系统镜像，用户不需要任何联网部署。

> 一句话现状：**打包链路已经就绪，能不能真上架只取决于你有没有 Partner Center 账号。**
> 自动化能做的部分（清单、图标、打包、自签、校验）全部在这份文档里；
> 需要在网页上人工完成的部分（注册账号、上传、填 listing、送审）在文末列成清单。

---

## 1. 它和现在的 NSIS 安装包有什么不同

| | NSIS（`npm run build:exe`） | MSIX（商店版） |
|---|---|---|
| 安装位置 | `%LOCALAPPDATA%\Programs\ApkStart`（可写） | `C:\Program Files\WindowsApps\...`（**只读**） |
| 用户数据目录 | `%APPDATA%\apkstart` | `%USERPROFILE%\ApkStart\data` |
| 运行时位置 | 装到安装目录，可写 | 直接在包内只读运行，镜像展开到数据目录 |
| 自更新 | 支持（下载 → 替换 exe → 重启） | **关闭**，更新走商店 |
| 硬件加速 | WHPX 或自动下载安装 AEHD 内核驱动 | **只能 WHPX**（MSIX 不允许装驱动、不允许提权） |
| 签名 | 不需要（用户自己承担 SmartScreen） | 提交时不用签，商店会重签 |

数据目录为什么搬出 `%APPDATA%`：MSIX 的 full-trust 应用会把 `%APPDATA%` / `%LOCALAPPDATA%`
下的**写入**重定向到 `%LOCALAPPDATA%\Packages\<包族名>\LocalCache\...`，而环境变量和
API 返回的仍是重定向前的真路径。我们从数据目录里 spawn `emulator.exe` / `adb.exe`，
一旦子进程和父进程对这些路径的「视图」不一致，就会变成「文件明明在那儿但找不到」。
把数据目录放到 `%USERPROFILE%\ApkStart`（AppData 之外，不参与虚拟化），父子进程看到的
是同一份真实文件，这一类问题从根上消失。代码见 `src/core/store.js` 的 `STORE_BUILD`。

---

## 2. 怎么打这个包

### 2.1 三条路，选一条

**A. 完全离线（推荐，最稳）**

```powershell
node build/pack.js      # 产出 dist/ApkStart-win64-portable（壳，约 228 MB）
node build/msix.js      # 自动把 build/runtime 复制进包，再打 MSIX
```

`build/msix.js` 会优先用 `dist/ApkStart-win64-portable` 当载荷（不需要联网），
自己把 `build/runtime` 复制到 `app\resources\runtime` —— 等价于 electron-builder 的
`extraResources`，但不会去 CDN 拉工具集。如果 `build/runtime` 不存在，先跑
`node build/prepare-runtime.js`（或 `npm run runtime`）。

**B. 一条命令（走 electron-builder）**

```powershell
npm run build:appx
```

它会跑 `electron-builder --win appx --x64 --config electron-builder.yml`，产出
`dist/release/ApkStart-<版本>.appx`。⚠️ 这一步会从 CDN 下载 electron-builder 自己的
工具集，**断网或网络不稳时会只解一半**（`win-unpacked` 里只剩 `electron.exe`，
`resources/runtime` 没复制），后续打出来的包会缺运行时。遇到这种情况回到 A。

**C. 自己组包(可控性最好)**

```powershell
npx electron-builder --win dir --x64 --config electron-builder.yml
node build/msix.js --payload dist/release/win-unpacked

# 想本地装一下试试，加 --sign（会生成自签证书并签名）
node build/msix.js --sign
```

产物在 `dist/store/ApkStart_<四段版本>_x64.msix`，脚本最后会用 ZipFile 自检包内是否
有 `AppxManifest.xml` / `AppxBlockMap.xml` / `[Content_Types].xml`（这三个缺一个都装不上），
并打印「运行时已内置」确认。

> **包体积**：当前约 1.5 GB。其中 1.1 GB 是 `system.img.xz`——它是用默认压缩档（preset 6）
> 重压出来的，原始发行版用 `preset 9|EXTREME` 只有约 470 MB。
> 想瘦回 ~850 MB：`npm run runtime` 重新生成镜像后再打一次包（这一步是纯 CPU，约 30~40 分钟，
> 只影响包体大小，不影响运行）。

### 2.2 需要本机装什么

- Node ≥ 20（已具备）
- **`makeappx.exe`**：Windows 11 **不自带**。三条找它的路，`build/msix.js` 会依次尝试：
  1. `PATH`
  2. `C:\Program Files (x86)\Windows Kits\10\bin\<版本>\x64\makeappx.exe`
  3. electron-builder 的缓存目录（只要跑过一次 `--win appx` 就有）

  想单独装：<https://developer.microsoft.com/windows/downloads/windows-sdk/>
  （只勾 Windows SDK，不用装 Visual Studio）。

  找不到时脚本会把 stage 目录留在 `dist/store/.stage`，并打印一条可以直接复制执行的
  `makeappx pack` 命令，不会白跑。

---

## 3. 提交商店前必须改的两个值

MSIX 清单里的 `Identity/@Name` 和 `Identity/@Publisher` 必须**逐字**等于
Partner Center → **Product management → Product identity** 里给出的
`Package/Identity/Name` 与 `Package/Identity/Publisher`，差一个字符都收不了。

当前默认值（占位用，真上架要换）：

```
Identity Name      = RoutineMiku.ApkStart
Identity Publisher = CN=RoutineMiku
PublisherDisplayName = RoutineMiku
```

三种改法，任选：

```powershell
# 1) 改 electron-builder.yml 的 appx.identityName / appx.publisher
# 2) 改 build/msix.js 顶部的 IDENTITY / PUBLISHER 默认值
# 3) 用环境变量或命令行参数覆盖（推荐，不动源码）
node build/msix.js --identity "12345RoutineMiku.ApkStart" --publisher "CN=1a2b3c4d-1111-2222-3333-444455556666"
$env:APKSTART_MSIX_IDENTITY="12345RoutineMiku.ApkStart"
$env:APKSTART_MSIX_PUBLISHER="CN=1a2b3c4d-1111-2222-3333-444455556666"
```

---

## 4. 本地试装（只是自测，上架不需要）

> ⚠️ 本地签名这一步**需要完整的 Windows SDK**。electron-builder 缓存里那份
> `winCodeSign` 工具集是裁剪过的，它的 `signtool.exe` 签 MSIX 会报
> `A required function is not present`（缺少 MSIX 的 SIP 提供程序）。
> 装了 Windows SDK 之后用 `C:\Program Files (x86)\Windows Kits\10\bin\<版本>\x64\signtool.exe`
> 就没问题。

```powershell
node build/msix.js --sign          # 生成自签证书 + 尝试签名
# 如果上一步报 signtool 不可用，用 SDK 里的那一份手工签：
& "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe" `
  sign /fd SHA256 /a /f dist\store\ApkStart-test.pfx /p 'ApkStart!test' `
  dist\store\ApkStart_0.6.3.0_x64.msix

# 管理员 PowerShell 里信任证书（一次即可）
Import-PfxCertificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' `
  -FilePath 'dist\store\ApkStart-test.pfx' `
  -Password (ConvertTo-SecureString 'ApkStart!test' -Force -AsPlainText)
Add-AppxPackage -Path 'dist\store\ApkStart_0.6.3.0_x64.msix'
```

卸载：`Get-AppxPackage *ApkStart* | Remove-AppxPackage`

自签证书的 Subject 必须和清单里的 `Publisher` 一致，否则报 `0x800B0109` / `0x80073CF3`。

---

## 5. 已知限制（写进 listing，别让用户自己踩）

0. **装完不会再联网下载任何东西**。模拟器、platform-tools、系统镜像全在包里；
   唯一的一次性动作是「把包内的 `system.img.xz` 就地展开」到
   `%USERPROFILE%\ApkStart\data\system-images`（约 1 分钟、约 3.3 GB，纯本地解压）。
   第一次开机动画会写明「运行时组件已随安装包内置，不再下载任何东西」。
   代码约束：`provision.systemImageInfo()` / `playImageInfo()` 把**压缩镜像也算就位**，
   `main.js` 的 `autoDeploy()` 在内置运行时下直接跳过联网（见 `bundledRuntimeDir`）。
1. **整包更新**：MSIX 没有差分下载，每次发版用户都要重下 ~852 MB。
2. **首次启动要展开镜像**：包里的 `system.img.xz`（472 MB）要展开成 ~3.3 GB，约 1 分钟。
   展开目标是 `%USERPROFILE%\ApkStart\data\system-images`，不在只读的包目录里。
   想要「装完 0 等待」可以改成随包分发已展开的镜像，代价是安装包从 852 MB 涨到约 4.4 GB
   （`build/msix.js` 目前按「小下载 + 一次本地展开」取舍）。
3. **只有 WHPX 能用**：商店版装不了 AEHD 内核驱动。用户需要在「启用或关闭 Windows 功能」
   里勾上「虚拟机平台」，否则会掉到 TCG 软件模拟（极慢）。
4. **不能自更新**：更新由 Store 负责（设置 → 应用 → 更新）。
5. **安卓数据随包卸载一起删**：数据在 `%USERPROFILE%\ApkStart\data`，卸载 MSIX 不会
   自动清掉它（这是好事），但「重置应用」会。

---

## 6. 需要人工完成的部分（脚本替代不了）

1. **注册开发者账号**：<https://storedeveloper.microsoft.com>
   （老入口 Partner Center 个人账号是一次性 $19；从上面这个新入口走流程据微软文档是免费的，
   代价是要做证件 + 自拍身份验证。以注册页当时显示的金额为准。）
2. **预留应用名称** → 拿到 `Package/Identity/Name`、`Package/Identity/Publisher`。
3. **上传包**：`.msix` / `.appx` / `.msixbundle` 都可以；Win10+ 推荐 `.msixupload`
   （带符号文件才有崩溃分析），但单 x64 的 `.appx` 直传也是被允许的。
   Store 接受上限 **25 GB/包**，我们 ~1.3 GB。
4. **准备 listing**：
   - 截图 ≥ 1 张（建议 4 张），**1366×768 或更大**，PNG，≤50 MB，最多 10 张
   - 中文描述（首屏那 3 句话最关键）、分类「实用工具」
   - 隐私政策 URL（本应用不收集个人数据，但仍建议挂一页说明联网行为）
5. **年龄分级问卷（IARC）**。
6. **Notes for certification**（给审核员看的说明）——这一项对本应用**特别重要**，
   建议照抄下面这段并补上自己的信息：

   > ApkStart 是一个 Android 应用运行器。它内置 Google 官方 Android 模拟器
   > （qemu-system-x86_64.exe）与一套 AOSP 系统镜像，全部随安装包分发，运行时不下载
   > 任何可执行内容。用户双击自己的 .apk 文件即可把该 Android 应用以 Windows 窗口形式
   > 运行。应用不会自行安装任何来自网络的 APK。首次启动会在
   > %USERPROFILE%\ApkStart\data 下展开约 3.3 GB 的系统镜像（这是模拟器正常工作所必需）。
   > 硬件加速依赖 Windows 自带 WHPX，不安装任何驱动或服务。
7. **无法自动化的一点**：Store submission API（Azure AD 认证）可以程序化提交，但一旦
   用 API 创建了某个 submission，就不能再回 Partner Center 网页改它（会进不可恢复的
   error 状态）。所以建议「CI 出包 → 网页上传 + 填表 → 提交」，不要一开始就接 API。

---

## 7. 相关代码位置

| 文件 | 作用 |
|---|---|
| `build/msix.js` | 组 stage、生成 5 张商店图标、写 `AppxManifest.xml`、调 `makeappx`、可选自签 |
| `electron-builder.yml` | `appx` 段落（identity / publisher / capabilities / 语言 / 最低系统版本） |
| `src/core/store.js` | `STORE_BUILD` 检测（`process.windowsStore`）与数据目录改道 |
| `src/core/provision.js` | 只读运行时目录处理：可执行文件留在包内，可写数据改道 |
| `src/main.js` | 商店版关掉自更新、AEHD 改提示开 WHPX |
