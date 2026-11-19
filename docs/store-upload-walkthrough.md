# ApkStart 商店上传操作单（照抄版）

> 按 Partner Center 页面顺序排列。标 **[复制]** 的段落直接粘，标 **[上传]** 的从本地选文件。
> 全程约 15 分钟。唯一需要你动脑的地方是第 2 步抄两个身份值。

---

## 0. 前置检查

- [ ] `dist/store/ApkStart_0.6.2.0_x64.msix` 存在，约 1.5 GB
- [ ] 包里身份已换成你的真实值（见第 2 步；当前仍是占位 `RoutineMiku.ApkStart`）
- [ ] 隐私政策有可公开访问的 URL

---

## 1. 新建产品

1. <https://partner.microsoft.com/dashboard> 登录
2. **Apps and games → New product → MSIX or PWA app**
3. 产品名：`ApkStart`
   - 被占用就换 `ApkStart 安卓应用运行器`（只影响展示，不影响包身份）

---

## 2. 取身份值（**关键**）

**Product management → Product identity**，整行复制：

```
Package/Identity/Name       = RoutineMiku.ApkStart
Package/Identity/Publisher  = CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D
```

> 已确认（2026-11-16），**这两个值已经是 `build/msix.js` 与 `electron-builder.yml`
> 的默认值**，直接跑 `node build/msix.js` 打出来的就是正确身份。
> 另外 `build/msix.js` 加了一道守卫：Publisher 里没有 `58CA1DED` 时直接退出（退出码 3），
> 避免再用占位身份覆盖掉已经正确的包（此前 `dist/release/ApkStart 0.5.0.appx`
> 就是这样被打成占位身份的废包）。
> 若日后 Partner Center 里显示的值与此不同，重跑：
>
> ```powershell
> node build/msix.js --identity "RoutineMiku.ApkStart" --publisher "CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D"
> ```

打包完我会核对：清单身份逐字一致、`Version="0.6.2.0"`、7 张 Assets 的 md5 与 `build/store-assets` 一致。
**在第 2 步完成前不要上传**，占位身份会被直接拒收。

---

## 3. Packages — 上传

**Packages → Upload package**

- **[上传]** `D:\apkstart-dsh\apkstart\dist\store\ApkStart_0.6.2.0_x64.msix`
- 上传约 891 MB，按你的上行带宽可能要 5–20 分钟，别刷新页面
- 校验通过后会出现「Package accepted」

常见报错：
| 报错 | 原因 |
|---|---|
| `0x800B0109` | Publisher 与签名不匹配 → 身份值抄错，回第 2 步 |
| `0x80080204` | 清单结构不合法 → 用当前 `build/msix.js` 重打包（`Square71/310` 必须在 `DefaultTile`） |
| `Invalid package identity name` | `Name` 里有空格或大小写不符 |

---

## 4. Store listing — 英文（默认语言）

**Short description**（≤100 字符）**[复制]**
```
Run Android apps on Windows by double-clicking an APK. Each app gets its own window.
```

**Description** **[复制]**
`docs/store-listing.md` 第 3 节的 English 段落（从 `ApkStart turns Android apps...` 到 `No network access is needed afterwards.`）

**Product features**（最多 20 条，逐条粘贴）**[复制]**
```
Double-click an APK to install it — no emulator UI, no setup
Each app gets its own Desktop and Start menu shortcut with its real icon
Apps run in their own window, with full-screen and resizable window mode
Portrait and landscape apps are detected and filled to the correct aspect ratio
Windows Search finds installed Android apps by name
A shared folder syncs both ways between Windows and /sdcard/ApkStartShared
The full runtime ships in the package — nothing executable is downloaded at runtime
Shell has zero third-party dependencies; the runtime starts on demand and is reclaimed when idle
No virtual network adapter and no kernel driver — Android uses the host connection
Runtime permissions are granted automatically; crashed apps are retried
```

**Screenshots**（≥1 张，1366×768 以上）**[上传]**
1. `docs/store-shots/1-main.png`
2. `docs/store-shots/2-window.png`

**Store logos**：可跳过（图标已在 MSIX 的 `Assets/` 里，包内 7 张齐全）

---

## 5. Store listing — 中文（简体）

在产品语言里添加 **Chinese (Simplified)**，然后：

**简短描述** **[复制]**
```
双击 APK 即可在 Windows 上运行安卓应用：独立窗口、桌面图标、运行时内置，装完即用。
```

**详细描述** **[复制]**
`docs/store-listing.md` 第 3 节的「中文」整段

**功能列表** **[复制]**
`docs/store-listing.md` 第 4 节的 10 条

**截图**：同上两张（可复用）

---

## 6. Properties

- **Category**：Developer tools → **Utilities & tools**
- **System requirements** **[复制]**
```
Windows 10 version 2004 (build 19041) or later, x64. "Virtual Machine Platform"
(Windows Hypervisor Platform) must be enabled for hardware acceleration.
8 GB RAM recommended; ~4 GB free disk space for the system image.
```
- **Privacy policy URL** **[复制]**
  ```
  https://github.com/RoutineMiku/apkstart/blob/main/docs/privacy.md
  ```
  （已合入 `main`，无需再处理分支可见性）
- **Support contact**：填你的邮箱 + `https://github.com/RoutineMiku/apkstart/issues`

---

## 7. Age ratings（IARC 问卷）

- 应用本身不含内容，但**可运行第三方安卓应用** → 勾选「用户可以访问第三方内容」
- 不含用户生成内容分享、不含社交、不含位置共享、不含内购
- 一般得到 3+ / Everyone

---

## 8. Submission options → Notes for certification **[复制]**

`docs/store-listing.md` 第 6 节整段（英文），核心是说明：内置模拟器与镜像随包分发、
运行时不下载可执行内容、首次启动只做本地解压、WHPX 来自 Windows 本身。

---

## 9. 提交

**Review and publish → Submit for certification**

- 首个包通常 1–3 个工作日
- 被拒最常见的原因：截图与界面不符、隐私政策 404、certification notes 太简略——这三项本单都已覆盖
