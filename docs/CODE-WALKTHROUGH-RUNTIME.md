# 运行时栈代码走读（sources / download / provision / updater / store / layers / 小工具）

> 代码版本：`package.json` = **0.3.4**，`main` = `src/main.js`。
> 行号对应当前工作副本（`D:\apkstart-dsh\apkstart`），文件可能已变动，引用前请以函数名为准再核一次行号。
> 阅读范围：`src/core/{sources,download,provision,updater,store,layers,logfile,notify,android,display}.js`，
> 顺带读了调用方 `src/main.js` / `src/core/{engine,emulator,installer}.js` 与 `test/`。
> 本文只描述代码事实；「✓」= 有测试，「✗」= 无覆盖。

依赖方向（重要，避免循环 require）：

```
main.js ──> engine.js ──> provision.js ──> sources.js ──> version.js
   │            │              │  │
   │            │              │  └──> download.js
   │            │              └─────> store.js / doctor.js / zip.js
   │            ├──> emulator.js ──> provision.js / logfile.js
   │            └──> layers.js ──> store.js（summary 内延迟 require）
   ├──> updater.js ──> sources.js / download.js / zip.js / version.js
   ├──> installer.js ──> store.js / provision.js(通过 runtime.provisioner)
   └──> android.js / notify.js / display.js / logfile.js
```

`version.js` 单独存在的原因写在 `version.js:2-4`：避免 `updater ↔ sources` 互相 require 形成环。

---

## 1. `src/core/sources.js` — GitHub / Gitee 双源 + 镜像 + 测速 + 熔断缓存

### 职责
把「读版本信息」和「拿下载地址」抽象成一组按**实测字节速度**排序的候选 URL，并对被限流/报错的源做短期熔断。

### 对外接口

| 导出 | 签名 | 说明 |
|---|---|---|
| `Sources` | `new Sources(settingsFn)` | `settingsFn: () => settings`，每次判定时现读（不缓存设置） |
| `Sources#blockedReason` | `(id: 'github'\|'gitee') => string\|null` | `null` = 可用；否则返回中文原因 `暂时跳过（N 分钟内不再尝试）`（230-234） |
| `Sources#fetchReleases` | `() => Promise<Array<{source,name,web,rel?,error?}>>` | 按 `sourcePreference` 决定问一边还是两边，`Promise.all` 并发（237-271）；可被测试覆写 |
| `Sources#latest` | `({force=false}) => Promise<Merged>` | 合并后的版本信息（见下），10 分钟缓存（277-364） |
| `Sources#candidates` | `(assetOrUrl: string\|{url}\|{urls:[]}) => string[]` | 源站优先、镜像其次，去重保序（371-393） |
| `Sources#rank` | `(urls, {onProgress}) => Promise<string[]>` | 按 30 分钟内缓存的实测速度降序；≤1 个地址直接返回（399-432） |
| `Sources#reset` | `() => void` | 清测速缓存 + 版本缓存 + 熔断（435-439） |
| `SOURCES` | `{github:{id,name,api,web}, gitee:{...}}` | 常量，owner 写死在 22-24 |
| `measure` | `(url, {bytes=256*1024, timeoutMs=9000}) => Promise<{url,ok,got,ms,ttfb,speed,error?}>` | 真下 256KB 测吞吐（108-157） |
| `withMirror` | `(url, prefix) => string` | 前缀补尾斜杠；非 `http(s)://` 返回 `''`（160-164） |
| `mirrorList` | `(settings) => string[]` | 自定义前缀唯一生效 → 其次 `autoMirror!==false` 时的内置镜像（207-213） |
| `KNOWN_MIRRORS` | `['https://ghfast.top/','https://gh-proxy.com/']` | 42-45 |

`latest()` 返回结构（350-361）：

```js
{
  version, tag, name, notes, htmlUrl, publishedAt,
  assets: [{ name, size, url, urls: string[], sizes: { [url]: bytes },
             parts?: [{index,size,urls:[]}], partial?: bool, source }],
  sources: [{ source, name, tag }],      // 参与合并的源
  unreachable: [{ source, name, error }],
  bySource,                              // 胜出源
  stale?: true, staleReason?             // 全部源挂掉但手里有旧结果（296）
}
```

### 关键实现

**1) 版本获取 = 并发问两边 + 降级列表接口（248-269）**
- 先 `${api}/releases/latest`，失败再 `${api}/releases?per_page=10` 取第一条非 `draft`；
- Gitee 私有仓库会回 **404 "Not Found Project"**（而不是 401），此时可填只读 `runtime.giteeToken`（243-246 会拼 `access_token`）；
- 只有 `403/429` 才记熔断，`_blockMs = 15min`（226、263）。**熔断也在 `latest()` 里补记一次**（286-290），注释说明是为了让「谁提供结果」可被测试替换（auto-test 就是这么注入的）。

**2) 合并策略**
- 版本号用 `cmpVer` 取最高（299），然后**只保留与该版本相同的资产**（307-310）；
- 资产白名单：`/^ApkStart/i`（316），排除 Gitee 自动挂的源码包；
- 同名资产跨源合并成 `urls[]`，并**逐地址记 `sizes{}`**（334-348）——两个源压出来的字节数不同，绝不能平均；
- 同版本既有整包又有分片时**优先整包**（326-327）；
- 全部源失败但 `_relCache.value` 存在 → 返回旧结果并打 `stale`（292-298），避免界面直接报错。

**3) 缓存三层**

| 缓存 | 字段 | TTL | 失效 |
|---|---|---|---|
| 测速 | `_rankCache: Map<url,{at,ok,speed}>` | 30min（219） | `reset()`；`ok=false` 也缓存，排序时记 -1（418-421） |
| 版本 | `_relCache: {at,key,value}` | 10min（223） | `key` 不匹配（`sourcePreference` 变了）/ `force` / `reset()` |
| 熔断 | `_blocked: Map<sourceId, untilMs>` | 15min（226） | `reset()` |

**4) 测速是「串行」的（408-417）**：注释明确写了并发会互相抢带宽，测出来变成「谁抢得凶」。代价是最坏情况 `候选数 × 9s`（`measure` 的 `timeoutMs`）。

**5) 吞吐只算「收到首字节之后」的时间（120-122）**：`span = now - (firstAt || t0)`，把 TLS/DNS 固定开销排除；否则「延迟高但带宽大」的源会被误判成慢。

**6) 分片还原 `groupParts`（172-204）**：`xxx.zip.part1/.part2` → 逻辑资产 `{name, size=Σ, parts:[{index,size,urls:[]}], partial:true}`；缺地址或序号不连续 → `broken`，被 `list` 过滤掉，`broken` 名单返回但 `latest()` **没有向外暴露**。

### 坑点与不变量

- **Gitee 单文件 100MiB**（172-204 注释、`.github/release.yml:36-44,78-100`）：超限就切 `.part1/.part2`；`updater._downloadParts` 负责拼回。
- **Gitee 资产条目没有 `size`**（198-201）：所以「完整性」只要求「分片连续 + 每片有地址」，不能要求 `size>0`；大小未知时进度按已收字节显示。
- **源码包 `v1.2.3.zip` / `.tar.gz` 会混进资产**（313-316）：靠 `^ApkStart` 白名单挡掉，`\.zip$` 这种后缀匹配会把源码包当更新包下下来。
- **镜像只能套 GitHub 地址**（366-369、385-390）：ghfast / gh-proxy 只代理 GitHub，拼 Gitee 只会 403，白测一次速。
- **同名资产必须留全部地址**（329-333）：以前按名字去重「谁先来用谁」，GitHub 在前 → Gitee 地址被丢 → 自动选源退化成只用 GitHub。
- `SAMPLE_BYTES = 256KB`（52），但 `provision.installRuntimePack:532` 的注释还写着「128KB」——**注释已过期，实现是 256KB**。
- `measure` 里 `openUrl` 返回的是 `res`（流），`done()` 时 `req.destroy()` 关的是流不是请求对象（115-132 的 `req = res`），能用但命名有误导性。
- `groupParts` 对 `part0`（从 0 开始）也会判 `broken`（196 要求 `index === i+1`）。
- 不变量：`candidates()` 第一项永远是**原始源站 URL**（380-382），`rank()` 只在 `length>1` 时排序（401），这是「最坏情况还能直连下载」的保底。

### 被谁调用
- `src/core/provision.js:16`（require）、`:145`（`new Sources(() => store.getSettings())`）、`:149-151`（`get sources`）、`:535`（`rank`）、`:588`（`candidates`，`_downloadUrls`）。
- `src/core/updater.js:23,47`（`new Sources(this.settings)`）、`:74`（`latest`）、`:140-141`（`candidates`+`rank`）、`:191-196`（分片各自 `candidates`+`rank`）。
- `src/main.js:819-825`：设置里改了 `sourcePreference/mirrorPrefix/autoMirror` → `updater.sources.reset()` + `provisioner.sources.reset()`。**注意**：这里不会清 `provisioner._cache.pack / emulatorUrl / sysimgUrl / playUrl`（见 §3 坑点）。

### 测试覆盖（`test/auto-test.js`）
- ✓ `:843` 候选地址含镜像前缀，自定义前缀优先于公共镜像
- ✓ `:864` 测速结果按速度排序，全部失败时保持原序不丢可用地址（并验证 `reset()`）
- ✓ `:878` Gitee 自动附带的源码包（`v1.2.3.zip`）绝不能被当成安装包
- ✓ `:901` Gitee 资产没有 `size`：分片组仍要成立
- ✓ `:926` 分片资产必须一路传到 `updater.asset`
- ✓ `:949` 合并版本时只认同版本资产
- ✓ `:976` 同名整包两边都有时两个地址都留着
- ✓ `:1282` 版本结果缓存 10 分钟，`force` 强制重查
- ✓ `:1300` 403 熔断跳过 + `blockedReason` 文案 + `reset()` 解除
- ✓ `:1323` 全部源不可达时退回上次结果（`stale`）

---

## 2. `src/core/download.js` — 单流 / 分块 / 多源并行 + 断点续传 + 看门狗

### 职责
只依赖 `http/https/fs` 的四层下载器：单流续传 → 单源分块 → 多源分块（带宽叠加）→ 依次换源；全部带空闲看门狗与「保证 settle」保护。

### 对外接口

| 导出 | 签名 | 返回 |
|---|---|---|
| `openStream` | `(url, {method='GET', headers={}, redirects=0}) => Promise<IncomingMessage>` | 跟随 301/302/303/307/308（≤6 跳），socket 空闲超时 30s（15-36） |
| `head` | `(url) => Promise<{status,size,type,error?}>` | 永不抛，失败 `status:0`（38-50） |
| `sha256File` | `(file) => Promise<hex>` | 52-60 |
| `download` | `(url, dest, opt) => Promise<{file,size}>` | `opt = {onProgress,signal,expectSha256,retries=2,idleMs=30000}` |
| `downloadParallel` | `(url, dest, opt) => Promise<{file,size,parallel:n}>` | `opt += {connections=8,minChunk=1MB,retries=3}` |
| `downloadAny` | `(urls, dest, opt) => Promise<{file,size,url}>` | 依次试，全失败抛聚合错误（314-326） |
| `downloadMulti` | `(urls, dest, opt) => Promise<{file,size,parallel,sources,multi,resumed}>` | `opt += {minChunk=2MB,retries=6,idleMs=20000,slowAfterMs=45000,slowBps=120*1024}`（338-548） |
| `downloadAnyParallel` | `(urls, dest, opt) => Promise<{file,size,url}>` | 依次用 `downloadParallel`（551-563） |

`onProgress` 回调体：`{got,total,percent,speed,eta}`（`downloadMulti` 额外带 `sources`）。

### 关键实现

**1) `download()`：单流 + 续传（68-173）**
- 每次尝试前 `statSync(dest).size` → `Range: bytes=existing-`（75-77）；
- `416` 视为「已完整」，直接 `break`（82-86）；
- `200` 且 `existing>0` = 服务器不支持续传 → `rmSync` 后重写（97-100）；
- 非 200/206：最多重试 `retries=2` 次，**固定退避 1500ms**（87-90）；
- 空闲看门狗 `idleMs`（默认 30s）：`kick()` 每次收到数据重置，超时 `res.destroy()` + `finish(Error('连接停滞（长时间无数据）'))`（112-130）。注释（109-111）记录：连接静默时 `res` 既不 `end` 也不 `error`，`pipe` 永不 `finish`，整个下载卡死且无报错；
- `signal.abort` → `res.destroy(new Error('已取消'))`（132-133）；
- 收尾强制 `onProgress({percent:100})`（162-163）；`expectSha256` 不符 → 删文件 + 抛错（165-171）。

**2) `downloadParallel()`：单源分块（180-311）**
- 已有非空文件 → 直接退回 `download()`，避免分块状态丢失（188-191）；
- 探测 Range：`Range: bytes=0-0`，206 + `content-range` 才并行；`total < minChunk*2` 也退回单流（193-210）；
- `n = min(connections, ceil(total/minChunk))`，`per = ceil(total/n)`（212-213）；
- 先 `ftruncateSync(fd,total)` 建空文件，再各块 `fs.writeSync(fd, buf, 0, len, pos)` 定位写（219-220、268）；
- 每块最多 `retries=3`，退避 `800 * tries` ms（285-300）；
- 结束校验 `size === total`，否则抛「下载不完整」（307-310）。

**3) `downloadMulti()`：多源分块（338-548）**
1. `list = 去重(urls)`；只有一个 → `downloadParallel`（350-352）；
2. `Promise.all` 并发探测每个地址的 `content-range` 总大小（355-365）；全部不支持 Range → `downloadAnyParallel`（367-370）；
3. **基准总大小取 `usable[0].total`**，即 `rank()` 排好序的第一个（最快的源），不是 `Math.max`（371-377）；只混用 `total === 该值` 的源（378-381）；
4. `n = clamp(2..connections, ceil(total/minChunk))`，块按 `i % same.length` 轮转分配源（384、409-416）；
5. **分块断点续传边车** `${dest}.chunks.json`（391-405）：只有 `m.total===total && m.n===n && dest 大小===total` 才认；否则删文件+删边车重下。完成的块 `doneSet.add(c.start)` + `saveMeta()`（518-520）；
6. 续传时把已完成块算进 `got`，进度不回到 0（425-427）；
7. **低速换源**：单块跑够 `slowAfterMs=45s` 且平均 < `slowBps=120KB/s`，且 `c.rotates < 2` → `res.destroy()` + 抛「该源速度过低…换源重试」，`c.pos` 保留（446-451、492-503）。注释点名现象：**「卡在 95% 不动」**；
8. 每块 `retries=6`（注释：3 次在「三个源里两个偶尔停摆」不够用），失败时 `c.src += 1` 换源，退避 `600 * tries`（523-534）；
9. 失败退出时 `saveMeta()` 再抛（526-528），成功后 `rmSync(meta)`（542）。

**10) 「保证 settle」双保险**：`fetchChunk` 里自己维护 `settled` + `finish()`，看门狗直接调用 `finish`，因为 `res.destroy(err)` 有时只发 `close` 不发 `error`（466-480）。

### 坑点与不变量

- **多源只能混用「声明总大小一致」的源**（371-381），否则会拼出坏文件；大小不同（GitHub/Gitee 各压一份）时只走最快那个。
- **`c.rotates` 必须显式初始化为 0**（415 注释）：`undefined < 2` 是 `false`，换源逻辑永远不触发（历史 bug）。
- **每次请求只允许换一次源**（459-463）：同一条连接 `destroy` 后仍可能收到已缓冲的包，会重复触发换源把源跳过头。
- **续传只对 `download()` 与 `downloadMulti` 生效**，`downloadParallel` 见到半截文件就降级单流（188-191）——这是设计取舍，不是 bug。
- `provision.installQemu:1100` 传了 `{ resume: true }`，但 `download()` 根本没有 `resume` 选项（69），续传是自动的：**该参数是无效/历史遗留**。
- `downloadMulti` 不处理 `opt.signal`（只有 `download()` 处理），取消多源下载目前只能靠超时/抛错。
- `download()` 的 `416` 分支会 `break` 并把「已存在文件」当作完整文件（82-86）；若 `existing > total`（上次写坏）不会自愈，只有 `expectSha256` 能兜住。
- `openStream` 的 `timeout: 30000` 是 socket 空闲超时，**没有单独 connect 超时**；DNS 卡住时靠外层 `measure/rank` 的定时器。
- UA 在 `download.js:13` 是 `ApkStart/0.2`，`sources.js:64` 是 `ApkStart/0.3`，两处不一致（无功能影响，仅日志/服务端统计）。
- 不变量：所有下载函数的 `onProgress` 在成功结束前一定会被调一次 `percent:100`（163、308、545），UI 不会停在 99%。

### 被谁调用
- `src/core/provision.js:14`（require）、`:434` `downloadAny`（adb）、`:541` `downloadMulti`（运行时整包）、`:912` `downloadAnyParallel`（emulator）、`:1010`（play 镜像）、`:1052`（aehd）、`:1143`（ISO）、`:628-629`/`:1071-1072` `openStream`（抓索引/目录页）、`:1226-1228` `head`（`probeSources`）。
- `src/core/updater.js:20,150`（`downloadMulti` 更新包）、`:198`（`downloadAnyParallel` 每个分片）。
- `test/engine-test.js:32`；`test/boot-test.js:23,38`（真下 ISO，走 `test:boot`）。

### 测试覆盖
`test/engine-test.js`
- ✓ `:83` 完整下载 + 跟随重定向
- ✓ `:89` 断点续传（已有半截文件）
- ✓ `:101` HEAD 探测 + SHA256
- ✓ `:108` SHA256 校验失败会清理文件
- ✓ `:118` 并行分块下载：多连接拼接内容一致
- ✓ `:133` 源不支持 Range 时自动回退单流

`test/auto-test.js`（本地起 http 服务打真实字节）
- ✓ `:995` 多源并行下载：两个源体积不同时跟最快的源走
- ✓ `:1068` 不同分块从不同源拉，拼出来字节必须完全一致
- ✓ `:1108` 失败后重来只补缺的块（边车）
- ✓ `:1155` 连接建立后一个字节都不来，必须超时换源而不是挂死
- ✓ `:1198` 某个源只跑几十 KB/s 时换源，而不是卡在最后几 % 不动
- ✓ `:1251` 只有一条可用地址时退回单源分块
- ✓ `:1033` 分片更新包按顺序拼回整包，大小不符立刻中止（`updater._downloadParts`）

---

## 3. `src/core/provision.js` — 运行时自举（adb / emulator / system image / qemu / aehd）

### 职责
不依赖第三方模拟器，把 adb、emulator、系统镜像、AEHD、QEMU、虚拟磁盘全部「下载→校验→解压/安装→落盘」，并统一管理这些文件该放哪（`paths()`）、够不够空间（`guardDisk`）、装没装好（`checkEnv`）。

### 对外接口（`class Provisioner`，导出 `{Provisioner, SOURCES, MIN_SIZE, absUrl, baseOf}`）

| 成员 | 签名 | 说明 |
|---|---|---|
| `constructor` | `(appRoot)` | 140-146；内部 `_sources = new Sources(() => store.getSettings())` |
| `get sources` | `Sources` | 149-151，与 updater 共用同一套镜像/测速设置 |
| `get root` | `string` | `settings.runtime.dir` 或 `%APPDATA%\apkstart\runtime`（192-195） |
| `paths()` | `Paths` | 197-245，见下表 |
| `ensureDirs()` | `Paths` | 建 root/qemu/platform-tools/images/_tmp/avdHome（247-253） |
| `guardDisk` | `(component, targetDir) => Promise<freeMB>` | 不足直接抛中文错误（262-277） |
| `hypervisor` | `() => Promise<{whpx,dll,hypervisorPresent,note}>` | 只做毫秒级文件检查（281-296） |
| `adbVersion` / `qemuVersion` / `emulatorVersion` | `() => Promise<{ok,path,version}>` | 各带 30s 内存缓存（298-338、687-714） |
| `inspectIso` | `(file) => {ok,iso9660,rawImage,size,reason,magic}` | 读 `0x8001` 处 `CD001`（341-365） |
| `checkEnv` | `() => Promise<Env>` | 367-424，UI 的「状态」全靠它 |
| `installAdb` | `(onProgress) => {ok,path,version}` | 428-456 |
| `resolveRuntimePack` | `() => {url,name,size,tag,page,from}` | 476-516，Gitee/GitHub 并发找 `ApkStart-runtime-*.zip` |
| `installRuntimePack` | `(onProgress) => {ok,name,tag}` | 522-580，轻量版一键部署 |
| `extractZip` | `(zipPath,destDir,{onEntry}) => destDir` | 591-622，>64MB 用文件版 zip、大条目流式 |
| `resolveEmulatorUrl` / `resolveSysimgUrl` / `resolvePlayUrl` / `resolveQemuUrl` | `() => Promise<string>` | 从 Google 索引/目录页动态解析，落兜底常量 |
| `materializeImages` | `(onLog) => Promise<count>` | 722-794，`.img.xz/.gz` → `.img`（只做一次） |
| `systemImageInfo` / `playImageInfo` | `() => {ok,dir,size,api,tag?,note?}` | 797-839 / 972-980 |
| `emulatorAccel` | `() => Promise<{ok,kind,note,...}>` | 845-902，`-accel-check` + 落盘缓存 |
| `installEmulator` | `(onProgress) => {ok,path,version}` | 905-937 |
| `ensurePlatformTools` / `adbVersionPath` | `() / () => bool / string` | 940-955 / 957-963 |
| `installSystemImage` | `(onProgress)` | 966-969，等价于 `installPlayImage`（只有一份基础镜像） |
| `installPlayImage` | `(onProgress) => playImageInfo` | 1004-1044，顺手清 `android-30` |
| `installAehd` | `(onProgress) => {ok,dir,installer}` | 1047-1062，只下载不解安装 |
| `installQemu` | `(onProgress) => {ok,path,version}` | 1090-1130，NSIS `/S /D=` 静默安装 |
| `downloadIso` / `inspectImage` / `importIso` / `importDisk` | | 1134-1195（QEMU 路线） |
| `createDisk` | `(sizeGB=24, onProgress)` | 1199-1220，`qemu-img create -f qcow2` |
| `probeSources` | `() => {adb,qemu,iso}` | 1224-1231，HEAD 探测三个固定 URL |
| `envCacheGet/Set`, `invalidateEnvCache`, `_envKey` | | 154-188，落盘环境探测缓存 |

`paths()` 返回（225-245）：

```js
{ root, qemuDir, qemuExe, qemuImg,
  adbDir, adbExe,
  emulatorDir, emulatorExe,
  sysImgRoot,                       // ★ 见下方三分支
  sysImgDir: <sysImgRoot>/android-34/google_apis_playstore/x86_64,
  avdHome, aehdDir,
  imagesDir, iso, disk, tmp,
  sysTag:'google_apis_playstore', sysApi:'34', sysAbi:'x86_64' }
```

`checkEnv()` 返回（387-423）：

```js
{ adb:{ok,path,version,required}, emulator:{ok,path,version,required,note},
  sysimg:{ok,dir,size,api,required,note}, playImage:{ok,dir,size,...},
  accel:{ok,kind,note}, qemu:{ok,...}, iso:{ok,path,size,iso9660,reason,...},
  disk:{ok,path,size,note}, hypervisor:{...},
  ready, engine:'emulator'|'qemu'|'none', paths }
```
`ready = adb.ok && (emulatorReady || qemuReady)`；`emulatorReady = emulator.ok && (sysimg.ok || playImage.ok)`（384、420）。

### 关键实现

**1) `paths()` 的三条路径规则（197-245）——这是「镜像到底落在哪个盘」的唯一权威**

- `root`：`settings.runtime.dir`，空则 `%APPDATA%\apkstart\runtime`（192-195）。
- `avdHome`（237）：`settings.runtime.avdDir`，否则**若 root 不在 `DATA_DIR` 下**就用 `<DATA_DIR>/avd`，否则 `<root>/avd`（202-209）。理由（202-206）：单文件发行版的运行时被解到临时目录，AVD 放进去等于每次退出丢应用。
- `sysImgRoot` 三分支（217-224）：
  1. `<root>/system-images` 已存在 → 用它（整包解压产物）；
  2. 否则 `<DATA_DIR>/system-images` 存在 → 用它（老用户/单文件发行版布局）；
  3. 两处都没有 → **落 `<root>/system-images`**（全新安装；注释说明 CI 组装运行时靠这个，且 `DATA_DIR` 可能被重定向到临时目录）。

**2) `materializeImages()`（722-794）**
- 源目录固定 `<root>/system-images`（723），**目标目录 `this.paths().sysImgRoot`**（726），注释明确要求两者用同一套规则，否则出现「整包解到 D 盘、镜像又展开回 C 盘 AppData」（实测 1.2GB + 3.3GB 并存）。
- 遍历：`.img.xz` 优先于 `.img.gz`（`found` Map，729-741）；其它文件（`kernel-ranchu` / `ramdisk.img` / 未压缩 `.img`）**必须一并复制**（728、751-760），否则模拟器报「还差系统镜像」。
- 已展开判定：`fileSize(dest) > 32MB` 跳过（765）。
- `.xz` 解压必须绕过包的 ESM 入口（771-781）：`require.resolve('@napi-rs/lzma')` 取目录再 `require(dir/index.js)`，注释说明 Electron 的 Node 20 不支持 `require('stream-polyfill.mjs')`，且 `exports` 不允许直接写 `/index.js`。
- 单个镜像失败只 `onLog('展开镜像失败：…')`（790），**不向上抛**。

**3) `installRuntimePack()`（522-580）——轻量版的「一键」**
- `resolveRuntimePack()`：自定义 `settings.runtime.runtimePackUrl` 优先（477-478，`size:0`）；结果缓存到 `this._cache.pack`，**never invalidated**（479、514）；
- 并发问 GitHub/Gitee 的 `releases?per_page=15`，找 `assets` 里 `/^ApkStart-runtime-.*\.zip$/i`，按 `cmpVer` 取最高 tag（487-515）；
- `guardDisk('runtime', p.root)`（525）→ **`'runtime'` 不在 `need` 表里**，落到 default 512MB + 1024MB buffer = 1536MB（264-266）；
- `rank(this._downloadUrls(pack.url))` 测速（534-536），失败退回原候选；
- `downloadMulti(urls, tmp/runtime-pack.zip, {connections: settings.runtime.downloadConnections||8})`（529、541-555）；**
  进度映射 `percent = clamp(1..90, pct*0.9)`**（551）；
- 体积闸门：`< 200MB` 抛「运行时整包下载不完整，可重试续传」（556）；
- `extractZip(zip, p.root, {onEntry})`（559-565），进度 91→99；
- 写标记 `<root>/.runtime-pack.json`（`{name,tag,at,from}`）并删 zip（566-571）；
- **立刻** `materializeImages(...).catch(() => 0)`（573-576），注释说明否则紧接着的 `checkEnv()` 会认为没装镜像、又去 Google 下一套 1.4GB；
- 返回 `{ok,name,tag}`，进度 100。

**4) `extractZip()`（591-622）**
- `fileSize > 64MB` → `new ZipFile(path)`（不整包进内存）；否则 `new ZipArchive(fs.readFileSync(...))`；
- 单个条目 `uncompSize > 64MB` 走 `zip.pipeTo()` 流式，其余 `fs.writeFileSync(zip.read())`；
- `finally { zip.close() }`（618-620）。

**5) `checkEnv()`（367-424）**：`Promise.all` 起 5 个探测（adb/qemu/hypervisor/emulator/accel），再叠加 `inspectIso`、`fileSize(disk)`、`systemImageInfo()`、`playImageInfo()`；`sysimg.ok` 被定义为 `systemImageInfo().ok || playImageInfo().ok`（381-399）。

**6) 环境探测落盘缓存（126-188）**
- 文件：`%APPDATA%\apkstart\cache\env.json`（129-131）；
- key = `exe 路径 + exe(size:mtime) + aehd.sys(size:mtime) + WinHvPlatform.dll 存在与否`（154-162）；
- TTL：可用结论 6h（126），**不可用只信 10 分钟**（127，用户可能刚开了虚拟化）；
- 开机失败时 `invalidateEnvCache()` 由 emulator 调用（`emulator.js:848,886`）。

**7) `emulatorAccel()`（845-902）**：解析 `-accel-check` 文本；三条兜底规则：`emulator-check` 缺失但有 `aehd.sys` → 判可用（879-883，注释说明「避免误判无加速而强行 `-accel off`，软件模拟在部分机器上直接崩溃」）；`hasAehdFile && /aehd/` → 可用（884）；`hv.dll && /whpx/` → 可用（886）；否则 `viaTcg: true`（888-897）。

**8) 磁盘守卫 `guardDisk()`（262-277）**

| component | need(MB) | + buffer 1024MB |
|---|---|---|
| adb | 64 | 1088 |
| emulator | 600 | 1624 |
| sysimg / playimg | 1800 | 2824 |
| qemu | 320 | 1344 |
| iso | 1100 | 2124 |
| aehd | 64 | 1088 |
| 未列（如 `'runtime'`） | 512 | **1536** |

不足时抛：「目标磁盘空间不足：该组件约需 N MB…把『运行时数据目录』改到空间更大的盘（设置 → 系统集成 → 运行时数据目录 → 浏览）」。

### 坑点与不变量

- **镜像落点必须与 `paths().sysImgRoot` 一致**：`installPlayImage` 解到 `p.sysImgRoot`（1023），`materializeImages` 目标 `paths().sysImgRoot`（726），`playImageInfo` 查 `p.sysImgRoot`（974）。任何新代码若自己拼 `<DATA_DIR>/system-images` 就会复现「设了运行时目录还是下到 AppData」。
- **`guardDisk('runtime')` 的估算偏低**：512+1024=1536MB，而实际是「1.5GB 包 + 落盘 zip + 解出 3.3GB system.img + .xz 展开」。小盘机器会在解压阶段失败并留下半截文件（`installRuntimePack` 没有清理半截 zip 的逻辑，靠下一次续传）。
- **`this._cache.pack` / `emulatorUrl` / `sysimgUrl` / `playUrl` 没有失效入口**：`main.js:819-825` 只 `sources.reset()`。用户在设置里改了 `sourcePreference` 或换了整包地址，同一进程内仍用旧地址（`runtimePackUrl` 例外，因为每次先读设置，477）。
- **`materializeImages` 的失败被两处吞掉**：自身 `.catch(e => onLog(...))`（790）＋调用方 `.catch(() => 0)`（576）。`@napi-rs/lzma` 缺失/被杀软拦截 → 镜像永远展不开 → `checkEnv().sysimg.ok === false` → 每次启动都重新走「下载运行时」路径（典型「卡在准备运行时」）。
- **`emulatorVersion()` 失败不缓存**（687-714）：`ok:false` 直接 return，没有 `envCacheSet`，也没有 30s 内存缓存；每次 `checkEnv()` 都会 `execFile(emulator.exe -version)` 最多 20s。成功路径才写缓存（707-710）。
- **`emulatorVersion` 缓存只在内存/落盘，`_cache.emulatorVerAt` 只在成功时设置**，失败路径会让状态轮询反复拉起进程。
- **`extractZip` 不校验 zip-slip**：`path.join(destDir, name)` 直接拼（606）；`updater._extract` 有 `startsWith(path.resolve(dest))` 防护（updater:237），两边不一致。运行时整包与更新包都来自本项目 release，风险低，但接手者别把 `extractZip` 用到不可信输入上。
- **`resolveRuntimePack()` 的自定义地址 `size: 0`**，下载进度只能靠探测或已收字节；`installRuntimePack` 里 `total` 也因此为 0，`mb` 文案会缺「/ 总大小」。
- **`installAdb` 解压到 `p.root`**（446），zip 顶层就是 `platform-tools/`；`installEmulator` 同理（926）。所以 root 同时是 `ANDROID_SDK_ROOT`（232-234 注释）。
- **`ensurePlatformTools()`（939-955）**：emulator 要求 SDK root 下有 `platform-tools`，否则 FATAL；它从 `engine/platform-tools`、`tools/platform-tools`、`settings.adbPath` 所在目录复制 3 个文件（`adb.exe` + 两个 dll）。
- **`installAehd` 只下载**（1047-1062），安装要管理员：`main.js:1121-1200` 走 `silent_install.bat` + UAC。
- **QEMU 安装**：NSIS `/S /D=<dir>`，`/D` 必须最后且不加引号（1112-1116）；`setTimeout` 600s 后强杀（1119）。
- **`systemImageInfo()`（797-839）**：先在 `paths().sysImgDir` 找，再把 `sysImgRoot`、`<root>/system-images`、`<appRoot>/engine/system-images` 下所有 `android-*/tag/abi` 枚举一遍（按 API 降序），任何一套 `system.img > 300MB` 且有 `kernel-ranchu` 就算 ok。这是「完整版可能只带更小的 AOSP 镜像」的兼容点。
- **`playImageInfo()` 与 `sysimg.ok` 的关系**：`checkEnv().sysimg.ok` 把两者或起来（390-399），但 `engine.ensure()` 用的是 `env.sysimg.ok`（`engine.js:852`），所以只有 play 镜像也能启动。
- **不变量**：所有 `install*` 的 `onProgress` 都以 `{stage:'download'|'extract'|'install'|'done', percent}` 形式汇报，`main.js:317` 统一加 `component`，UI 侧 `app.js:357 updateStepProgress` 只读 `percent/message`。
- `SOURCES` 里硬编码的兜底版本会过期（`emulator-windows_x64-16847572.zip`、`x86_64-34_r14.zip`，27-41），只在索引抓不到时使用。

### 被谁调用
- `src/core/engine.js:16,54`（`new Provisioner(appRoot)`）、`:79,202,393,995`（`paths()`）、`:109,235,368,635,849,996`（`checkEnv`）、`:264,761`（`emulatorAccel`）、`:639`（`createDisk`）、`:848`（`materializeImages`）、`:1017,1021`（`paths().root` → layers）、`:873`（`needsSetup`）。
- `src/core/emulator.js:17,29`、`:53,225`（`paths`/`ensureDirs`）、`:56,63`（`systemImageInfo`）、`:62,723`（`playImageInfo`）、`:659`（`adbVersionPath`）、`:761-762`（`emulatorAccel`+`emulatorVersion`）、`:848,886`（`invalidateEnvCache`）。
- `src/core/installer.js:95-99`（`playImageInfo` + `installPlayImage`，首次遇到 ARM 应用按需下）；`:159,169,190,489`（`playImageInfo` 判定）。
- `src/main.js`：`:314-354`（`autoDeploy` 主流程）、`:707`（`paths().root` 给 UI）、`:824`（`sources.reset`）、`:898,932,939,946,953,964,977`（自检/诊断）、`:1076-1269`（各 `provision:*` IPC）、`:1330,1542`（`avdHome`/`root`）、`:1631`（预热前 `checkEnv`）。
- `test/engine-test.js:146-220,391-401`、`test/auto-test.js:1347-1350`、`test/boot-test.js:44`。

### 测试覆盖
`test/engine-test.js`
- ✓ `:149` 默认运行时目录位于数据目录下
- ✓ `:156` 空环境检查：adb 未就绪，组件结构完整
- ✓ `:166` 内置 ZIP 解压可用
- ✓ `:197` SDK 索引里的相对 url 会被补全成绝对地址（`absUrl`/`baseOf`）
- ✓ `:211` 解析出的 emulator / 系统镜像地址都是可下载的绝对 URL
- ✓ `:244` 镜像校验：区分有效 ISO9660 / 损坏 / 未下完（`inspectIso`）
- ✓ `:391` `playImageInfo` 校验 API 34 兼容镜像完整性

`test/auto-test.js`
- ✓ `:1339` **系统镜像落点：全新安装必须落在运行时目录**（覆盖 `paths().sysImgRoot` 三分支）

`test/boot-test.js:44` 起真实 `checkEnv` + 真机启动（`npm run test:boot`，不联网也能跑但要 ISO）。

**未覆盖**：`installRuntimePack`、`resolveRuntimePack`、`materializeImages`、`installAdb/installEmulator/installPlayImage/installAehd/installQemu`、`guardDisk` 全都没有单测（都需要真实网络/大文件）。

---

## 4. `src/core/updater.js` — 在线更新（check / prepare / apply）

### 职责
从本仓库 GitHub/Gitee Releases 取最新版本，按安装形态挑资产、下载并组装载荷，生成一段 PowerShell 覆盖脚本在进程退出后执行「替换 + 重启」。

### 对外接口（导出 `{Updater, cmpVer, OWNER, REPO}`）

| 成员 | 签名 | 说明 |
|---|---|---|
| `constructor` | `({currentVersion, exePath, isPackaged, dataDir, settings?, onProgress?})` | 38-50；`this.installDir = dirname(exePath)`，`this.sources = new Sources(settings)` |
| `get flavor` | `'setup' \| 'portable'` | 53-59：`installDir` 下有 `Uninstall *.exe` → `setup` |
| `get updateDir` | `<dataDir>/update` | 61-63 |
| `check` | `({force=false}) => Promise<Latest>` | 73-115，见下 |
| `prepare` | `(info?) => Promise<{mode:'zip'\|'setup', payload, version}>` | 121-176 |
| `_downloadParts` | `(asset, target, conns, total)` | 182-227，分片下载 + 顺序拼接 |
| `_extract` | `(zipPath, dest)` | 229-251，带 zip-slip 防护、逐条流式 |
| `apply` | `(job, {waitPid?, spawn?}) => true \| script` | 258-325；`spawn:false` 时只返回脚本（测试用） |
| `static repoUrl()` | `() => 'https://github.com/RoutineMiku/apkstart/releases'` | 328-330 |
| `cmpVer` | re-export 自 `version.js` | 333 |

`check()` 返回（82-112）：

```js
{ version, tag, name, notes, htmlUrl, publishedAt,
  asset: { name, size, url, urls[], sizes{}, source, parts?, partial? } | null,
  assets, sources, unreachable,
  flavor, hasUpdate, current, canAutoApply }
```
`asset` 挑选（77-80）：
- `setup`：`/Setup\.exe$/i` → 兜底 `/win.*\.exe$/i`
- `portable`：`/portable.*\.zip$/i` → `/win64.*\.zip$/i` → **`/\.zip$/i`**
`hasUpdate = cmpVer(merged.tag, current) > 0`（109）；`canAutoApply = !!asset && (asset.url || asset.parts?.length)`（111）。

### 关键实现

**1) `check()`（73-115）** 只做「元数据 + 挑资产」，下载地址在 `prepare()` 里才测速。`force` 透传给 `sources.latest`。

**2) `prepare()`（121-176）**
- 载荷目录 `<dataDir>/update/<version>/`；
- 有 `asset.parts` → `_downloadParts`（133-134）；
- 否则 `candidates(asset)` → `rank()` → `downloadMulti(ranked, file, {connections})`（136-163）；
- **进度总大小的取法**：`sizes[url]` 按 `ranked` 顺序找第一个已知的（142-147），注释说明拿错会「一直显示 92% 再突然跳到完成」；
- `.zip` → 解到 `payload/` → `{mode:'zip',payload:out}`；其余 → `{mode:'setup',payload:file}`（166-175）。

**3) `_downloadParts()`（182-227）**：每个分片单独 `candidates + rank`（可以一部分走 Gitee、一部分走镜像），`downloadAnyParallel` 到 `<name>.<index>.tmp`，校验 `part.size`（若已知，211-216），`fs.writeSync(fd, buf, 0, len, doneBytes)` 顺序落盘，最后校验 `doneBytes === total`（224-226）。整片 `readFileSync` 进内存（213）——分片 ≤100MiB，可接受。

**4) `apply()`（258-325）—— 更新链最关键的一段**
生成的脚本（`lines`，265-307）依次：
1. `$ErrorActionPreference='SilentlyContinue'`，`Note()` 写 `<updateDir>/update.log`；
2. `Wait-Process -Id <waitPid> -Timeout 90` + `Sleep 700ms`（270-272）；
3. `mode==='zip'`：`Copy-Item -Recurse -Force` **最多 12 轮**，每轮用「目标 exe 是否存在」当探针，失败 `Sleep 600ms`（275-290）；之后 `Remove-Item $src`（解压目录，289）；
4. `mode==='setup'`：`Start-Process -ArgumentList '/S' -Wait` 并记录 exit code（291-298）；
5. 重新拉起 `exe`（300-301）；
6. `Remove-Item <updateDir>/<version> -Recurse -Force`，最后 **`exit 0`**（304-306，注释：清理失败不应让调用方以为更新失败）。

启动方式（309-324）：
- 脚本先落盘 `update/apply.log.ps1` 便于排障（310）；
- 真正执行用 `-EncodedCommand`（UTF-16LE base64，313），注释说明**绕开 PS 5.1 按 ANSI/GBK 解码无 BOM 脚本**导致中文路径乱码；
- **不能 `detached`**（315-318）：某些安全软件/沙箱会拦「分离的控制台进程」，表现为脚本压根没跑（界面上「正在替换程序并重启」卡住）；改用普通子进程 + `child.unref()`；
- `spawn(ps, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-EncodedCommand',b64], {stdio:'ignore', windowsHide:true})`。

### 坑点与不变量

- **安装版 vs 便携版靠「安装目录里有没有 `Uninstall *.exe`」判定**（53-59），没有其它标记；NSIS 静默覆盖安装，便携版靠复制覆盖。
- **覆盖不会删除旧版本多出来的文件**（287-288 注释），只清本次解压目录；所以「删掉的 dll 残留」可能影响新版本（目前判断为无害）。
- **`apply()` 之后调用方必须退出**：`main.js:594-596` `apply(job)` 后 900ms `app.quit()`；脚本最多等 90s。
- **Gitee 100MiB → `.part1/.part2`**（130-134 注释）；`sources.latest` 已把分片合逻辑资产，`check()` 必须把 `parts` 一路带出来（88-101），auto-test:926 专门守这个。
- **`sizes` 逐地址记录**，不能用 `asset.size` 一处了事（142-147、sources:339-347）。
- **潜在误判：默认兜底 `/\.zip$/i` 会把运行时整包当更新包**（80）。同一个 release 里既有 `ApkStart-vX-win64-portable.zip` 也有 `ApkStart-runtime-vX.zip`（`.github/workflows/release.yml:44,187`），当前靠 `portable` 正则先命中才没出问题；一旦便携包改名，`/\.zip$/i` 会挑到 1.5GB 的运行时整包并覆盖程序目录。
- **`prepare` 不校验下载结果的 zip 完整性**，`_extract` 才暴露错误；下载大小与 `total` 不符时 `downloadMulti` 会抛（download:546）。
- **更新只在打包后检查**：`main.js:1665 if (app.isPackaged)`；开发态不查。
- 不变量：`apply()` 必须在 `prepare()` 成功之后调用（`prepare` 无载荷时抛错，`main.js:592` 捕获后 `sendProgress({stage:'error'})`）。
- `flavor` 每次 `readdirSync(installDir)`，无缓存（53-59）——高频调用会有磁盘 IO，目前只在 check/UI 用。

### 被谁调用
- `src/main.js:38`（require）、`:1503-1511`（构造，注入 `settings`/`onProgress`）、`:579-604`（`runUpdate`：`check`→`prepare`→`apply`→`quit`）、`:496,584,588`（托盘/手动检查 + `repoUrl()`）、`:1447`（`app:updateCheck`，`force` 默认为真）、`:1456`（`app:updateOpen`）、`:1461`（`app:updateApply`）、`:1667`（启动 8s 静默检查）。
- `src/preload.js:71-72`（`updateCheck` / `updateApply`）；`src/ui/app.js` 设置页「软件更新」。

### 测试覆盖（`test/auto-test.js`）
- ✓ `:820` 版本比较按数字逐段比（`cmpVer`）
- ✓ `:828` 安装形态决定挑哪个资产 + `flavor` 判定
- ✓ `:926` 分片资产必须一路传到 `updater.asset`（否则 `prepare` 报「没有可用的下载地址」）
- ✓ `:1033` 分片更新包按顺序拼回整包，大小不符立刻中止（`_downloadParts`）
- 间接覆盖：`:843/:864/:878/:901/:949/:976`（`sources`）、`:995/:1068/:1108/:1155/:1198/:1251`（`downloadMulti`）
- **未覆盖**：`apply()` 生成的脚本内容（无断言抓 `apply.log.ps1`）、`_extract` 的 zip-slip、`prepare` 的 `sizes` 选择。

---

## 5. `src/core/store.js` — 设置与应用清单持久化

### 职责
一个「读时合并默认值 + 原子写」的 JSON 存储：`%APPDATA%\apkstart\{settings.json,apps.json,icons/,apks/}`。

### 对外接口（`module.exports = store`）

| 成员 | 签名 | 说明 |
|---|---|---|
| `DATA_DIR` / `ICON_DIR` / `APK_DIR` | `string` | 10-14；`DATA_DIR = %APPDATA%\apkstart` |
| `getSettings()` | `() => Settings` | 175-186：`deepMerge(DEFAULT_SETTINGS, 磁盘内容)` + **强制迁移** |
| `saveSettings(patch)` | `(patch) => Settings` | 188-196：`deepMerge(当前, patch)`，`engine.resourceMode` 存在时翻译成三开关 |
| `getApps()` | `() => App[]` | 198-201，坏文件回落 `[]` |
| `saveApps(apps)` | `(apps) => void` | 203-205 |
| `upsertApp(app)` | `(app) => app` | 207-214，按 `package` 合并 |
| `removeApp(pkg)` / `getApp(pkg)` | | 216-223 |
| `iconPath(pkg)` / `apkPath(pkg,version='cur')` | `=> string` | 225-231 |
| `ensureDirs()` | `() => void` | 119-123 |
| `DEFAULT_SETTINGS` | 常量对象 | 16-117，被测试与 doctor 直接引用 |

### 关键实现

- **原子写**（133-138）：写 `<file>.tmp` → `renameSync`，避免半截 JSON。
- **`deepMerge`（140-150）**：只递归普通对象，数组和标量直接覆盖；`base[k]` 必须是对象才递归。
- **读时迁移（175-186）——三处强制覆盖，没有版本号字段**：
  - `s.engine.headless = false`（179）：旧版无头运行 ≠ 打不开窗口；
  - `s.hideAfterLaunch = false`（181）：旧版退出壳层会杀掉整个运行时；
  - `s.freeform = false`（184）：旧版 freeform 小窗会变成「窗口里套小窗」。
  因为每次读都覆盖，旧 settings.json 里的 `true` 永久失效（auto-test:455 断言）。
- **资源策略翻译（160-170、191-193）**：`save`→`liteMode:true/priorityMode:balanced/renderSize:540x960`；`smooth`→`false/performance/720x1280`；`balanced`→`true/balanced/auto`。只在 `patch.engine.resourceMode` 出现时触发，避免与细项开关打架。
- **默认值里的「事实约束」**（写在注释里，读的时候别删）：
  - `engine.headless:false`（28-30）：无头模式 SurfaceFlinger 不出 VSYNC，应用活着但没画面；
  - `engine.badGpu:''`（32-34）：记录「拉起就崩」的 `<emulator版本>|<gpu>`，升级运行时自动失效；
  - `runtime.dir:''`（68）= `%APPDATA%\apkstart\runtime`；
  - `runtime.downloadConnections:8`（88）；
  - `runtime.sourcePreference:'auto'`（91）、`autoMirror:true`（94）、`giteeToken:''`（97）；
  - `runtime.compatImage:false`（78）——**已基本废弃**：`provision.checkEnv:381-384` 不再依赖它，把 play 镜像同时当主镜像；
  - `engine.logLimitKB:2048`（55）、`engine.prefetch` 无、`engine.prewarm:true`（65）；
  - `display.portrait:'900x1600'`（112），但 `main.js:276` 用的是 `d.portrait || '540x960'`（默认值不一致，实际以 settings 里存在的 900x1600 为准）。
- **`DEFAULT_SETTINGS` 缺 `runtime.avdDir`**：`provision.paths():207` 读 `runtime.avdDir`，新装用户这里是 `undefined`；UI 写入后才有（`ui/app.js:1203`）。同理 `runtime.installed` 被 `engine.js:870` 读，但默认值里没有。

### 坑点与不变量

- **`getSettings()` 每次调用都 `readFileSync + JSON.parse`，没有内存缓存**（175-186）。而 `provision.paths()` 每次调用要读 2~4 次 settings（193、207、209 等），`checkEnv()` 在多处被状态轮询调用 → 高频小文件读。要做性能优化这里是第一个下手点。
- **`saveSettings` 写的是「合并后的完整对象」**（189-194），所以 settings.json 会带上当时的所有默认值；升级后新增的默认值不会被写入，只在读时合并——这正是迁移可以放在读时的原因。
- 迁移是**单向强制**（179-184），未来若要允许用户重新打开 headless，必须改这里而不是改 UI。
- `writeJson` 的 `renameSync` 在跨卷时会失败（`os.tmpdir` 与 `DATA_DIR` 同卷时没事；测试里改 `APPDATA` 后仍在同卷）。
- 测试隔离方式：改 `process.env.APPDATA` 再**重新 require**（`auto-test.js:11,1344-1347`）；`DATA_DIR` 是模块加载时求值的常量，同进程内改 env 不会生效——写测试时注意。

### 被谁调用
- `src/core/provision.js:12,145,192,197-237,452,1159,1187,1193,1217`。
- `src/core/engine.js:15,1017-1021`（`store.DATA_DIR`）、`src/core/emulator.js:16`、`src/core/installer.js:10`、`src/core/sharer.js:10`、`src/core/layers.js:162`（`summary` 内延迟 require）。
- `src/main.js`：全流程（启动迁移、`app:info`、`settings:get/set`、`bootstrabBundledRuntime:97-171` 直接 `saveSettings({runtime:{dir}})`）。
- `test/engine-test.js:147`、`test/auto-test.js:456,700,1346,1374,1386`、`test/boot-test.js:21`。

### 测试覆盖
- ✓ `auto-test.js:455` 旧配置强制迁移：无头与「启动后退出」不再生效
- ✓ `auto-test.js:1373` 资源策略一处切换，自动翻译成 vCPU/优先级/分辨率
- ✓ `auto-test.js:1385` 数据分区容量可配置，默认不再是死数字
- ✓ `engine-test.js:149` 默认运行时目录位于数据目录下（依赖 `DATA_DIR`）
- **未覆盖**：`upsertApp/removeApp/apkPath/iconPath`、`writeJson` 原子性。

---

## 6. `src/core/layers.js` — 容器分层盘点 / 回收

### 职责
把运行时目录当成镜像层来做**只读盘点**与**按明确清单回收**（默认 `dryRun`），并给设置页一个「一共占了多少盘」的摘要。

### 对外接口（导出 `{analyze, prune, summary, walk, dirSize}`）

| 导出 | 签名 | 说明 |
|---|---|---|
| `walk` | `(dir, out=[], depth=0) => [{path,size}]` | 递归文件列表，**深度上限 6**（15-27） |
| `dirSize` | `(dir) => bytes` | 29 |
| `analyze` | `(root, {keepAvd='apkstart.avd', aggressive=false, keepSnapshots=false}) => {total,groups,candidates}` | 36-127 |
| `prune` | `(root, {apply=false, keepAvd, aggressive, keepSnapshots, onRemove}) => {…analyze, apply, removed, saved, after}` | 133-152 |
| `summary` | `(root) => {total,totalText,runtimeText,groups,reclaimable,reclaimableText,count}` | 155-184 |

`candidates[]` 项：`{path, size, reason, kind:'file'|'dir'}`。

### 关键实现

**1) `analyze()` 的 8 类回收项（对应代码顺序）**

| # | 行号 | 目标 | reason |
|---|---|---|---|
| 0 | 48-51 | `emulator/`、`system-images/`、`avd/`、`platform-tools/` | 只做 size 分组（`groups`），不删 |
| 1 | 53-61 | `emulator/qemu/windows-x86_64/qemu-system-{aarch64,armel,i386}*` | 非 x86_64 的 QEMU 目标 |
| 2 | 63-68 | `system-images/**/{NOTICE.txt,source.properties}` 且 >1MB | 镜像包内大体积说明文件 |
| 3 | 70-77 | `system-images/android-30`（仅当 API34 play 的 `system.img` 存在）、`<root>/x86_64` | 旧镜像 / 解压错位目录 |
| 4 | 79-86 | `avd/*.avd` 中 `name !== keepAvd` | 非活动 AVD（含 8-16GB 用户数据） |
| 5 | 87-90 | `avd/**/*.lock` | 上次异常退出残留锁文件 |
| 6 | 91-100 | `avd/<keepAvd>/snapshots` 或 `snapshots.stale-N`（`keepSnapshots=false` 时） | 旧 quickboot 快照 |
| 7 | 103-110 | `<root>/_tmp`、`<root>/images` | 下载临时文件 / 旧 QEMU·ISO 遗留 |
| 8 | 112-123 | `aggressive` 时 `emulator/crashreport.exe` | 构建发行包专用 |

**2) `prune()` 的安全约束（139-141）**
```js
const p = path.resolve(c.path), rootAbs = path.resolve(root);
if (p === rootAbs || !p.startsWith(rootAbs + path.sep)) continue;   // 不出 root、不删 root
```
`apply=false` 时**一个文件都不动**（142-149），只返回清单；删除失败（被占用）静默跳过，下次再清（148）。

**3) `summary()`（155-184）**：运行时 `analyze` + 4 个额外目录（`avd`、`APK_DIR`、`ICON_DIR`、`logs`），过滤 0 字节组，单位在 1GB 以上转 GB。

### 坑点与不变量

- **`aggressive` 的黑名单是硬约束**（112-114 注释）：`Qt6WebEngineCoreAndroidEmu.dll` 是 `qemu-system-x86_64.exe` 的加载时依赖，**绝不能删**；`qsn/netsim` 保守保留。
- **`keepAvd` 默认写死 `'apkstart.avd'`**，与 `emulator.js` 的 `AVD_NAME` 必须一致；改名要同步两处。
- **运行时正在跑时必须 `keepSnapshots:true`**：`engine.cleanup()` 传 `keepSnapshots: this.vmRunning`（`engine.js:1019-1023`），否则删当前会话的快照会把运行中的机器写坏。
- `walk` 的深度 6 是为了防符号链接环/深层目录炸栈；超过 6 层的文件不计入 size（会低估）。
- `analyze` 的 `candidates` **不包含**「活动 AVD 的 userdata/快照（`keepSnapshots=true` 时）」，这是「已装应用不会被清」的保证（auto-test:174 断言）。
- `prune` 的 `after` 只是 `total - saved`，不重新扫描，真删失败时与实际略有出入。

### 被谁调用
- `src/core/engine.js:1017`（`usage()` → `summary`）、`:1019-1023`（`cleanup()` → `prune`）。
- `src/main.js:1004`（`runtime:usage` → `runtime.usage()` → `summary`）、`:1056-1071`（`runtime:cleanup`：先 `apply:false` 拿清单 → `dialog.showMessageBox` 二次确认 → `apply:true`）。
- `src/ui/app.js`（设置页「占用/清理」面板，经 `runtime:usage`/`runtime:cleanup`）。
- `test/auto-test.js:25,157,167,171`。

### 测试覆盖
- ✓ `auto-test.js:139` 盘点可回收项：非 x86_64 QEMU、旧镜像、旧 AVD、锁文件、旧快照（含 dryRun 不删除、`apply` 后活动 AVD 与 x86_64 QEMU 保留）
- **未覆盖**：`summary()` 的额外 4 个目录、`aggressive` 分支、深度上限。

---

## 7. 小工具四件套

### 7.1 `src/core/logfile.js` — 按大小滚动日志

| 导出 | 签名 | 说明 |
|---|---|---|
| `rotate` | `(file, limitKB) => bool` | 15-26：`size < limit` 返回 false；否则删旧 `.1.log` → `rename` 成 `.1.log` |
| `append` | `(file, line, limitKB=2048) => bool` | 33-45：**每进程首次 + 每 200 行**做一次 rotate（39），`appendFileSync` 补换行 |
| `trimNow` | `(file, limitKB=2048) => bool` | 48-50：启动时无条件检查一次 |

- 职责：`app.log` / `emulator.log` 长期 append 会被写满（header 2-9），只保留**一份** `.1.log`。
- 坑点：`limitKB` 被 `Math.max(256, ...)` 夹到 ≥256KB（39、49）；`counters` 是模块级 `Map`，进程重启归零；`rotate` 用 `renameSync`，Windows 上文件被占用会失败并返回 false（静默）。
- 被谁调用：`src/main.js:85`（`appLog`，`logs/app.log`）、`src/core/emulator.js:577`（emulator 日志）。
- 测试：✓ `auto-test.js:1404` 日志超过上限自动滚动，只保留一份备份。

### 7.2 `src/core/notify.js` — 安卓通知 → Windows 通知

| 导出 | 签名 | 说明 |
|---|---|---|
| `parseRecords` | `(dumpsys 文本) => [{pkg,key,title,text}]` | 34-63 |
| `NotifyBridge` | `new NotifyBridge({getClient,getAppLabel,getAppIcon,onOpen})` | `start()/stop()`，内部 `setInterval(_tick, POLL_MS=2500)`（11、77-89） |

关键实现：
- 每 2.5s `client.shell('dumpsys notification --noredact', {timeout:12000})`（97），**先 `isOnline()`**（96）；
- 过滤：`SYSTEM_PKGS` 白名单 + `com.android.providers.*` + `launcher`（18-32）；`FLAG_ONGOING_EVENT(0x2)`、`FLAG_FOREGROUND_SERVICE(0x40)` 跳过（43-45）；
- 首次 `_tick` 只做基线 `primed`，避免启动瞬间把历史通知全弹一遍（99-104）；`seen` 超 500 条裁到 300（113）；
- 点击 `note.on('click')` → `onOpen(pkg)`（130）；
- 模块顶层 `require('electron')`（9）→ **纯 Node 测试跑不了**，所以 `test/notify-test.js` 用 electron 跑。

被谁调用：`src/main.js:36,682-697`（`startNotifier()`，只在容器有应用窗口时由 `onContainerActive(true)` 启动，`:670-678` 关闭时 `stop()`；`:1772` 退出时 stop）。
测试：`test/notify-test.js`（用真实 `test/notif.txt` dump 调 `parseRecords`，**不在 `npm test` 里**）；`NotifyBridge` 本体无覆盖。

### 7.3 `src/core/android.js` — 安卓设置开关（不需要进桌面）

| 导出 | 说明 |
|---|---|
| `ACTIONS` | 11 个 `android.settings.*` action 常量（7-19） |
| `AndroidSettings` | `new AndroidSettings(runtime)`；方法 `status()`、`setWifi`、`setAirplane`、`setVolume`、`setAnimations`、`setFontScale`、`setDensity`、`tune({pkg})`、`open(action)`、`permissions(pkg)`、`grantAll(pkg)` |

关键实现：
- `client()` 每次 `await runtime.ensure()`（24-28），失败抛「运行时未就绪」；
- `_sh(commands)` 把多条命令用 `; ` 拼成**一次** `adb shell`（30-34），20s 超时；
- `status()` 用 `echo "k=$(...)"` 一次拿 7 个值再正则解析（37-61）；
- `tune()`：关三个动画 + `max_cached_processes=32` + 可选 `deviceidle whitelist +pkg`（111-121）；
- `permissions()` 解析 `dumpsys package` 的 `runtime permissions:` 段，按缩进收尾（131-145）；`grantAll()` 逐个 `pm grant`，失败忽略（147-156）；
- 取值范围：`fontScale 0.85~1.3`、`density 120~640`、`volume 0~100`（79-108）。

被谁调用：`src/main.js:1501`（`androidSet = new AndroidSettings(runtime)`）、`:1404-1434`（`android:status/set/open/tune/permissions/grantAll` IPC）；`src/preload.js` 暴露给设置页。
测试：**✗ 无覆盖**（需要真实 adb）。

### 7.4 `src/core/display.js` — 显示适配的纯计算

| 导出 | 签名 | 说明 |
|---|---|---|
| `densityFor` | `(w,h,manual) => dpi` | `manual>0` 时夹 120~640；否则 `min(w,h)/2.57` 夹 200~480（7-10） |
| `portraitSize` | `(str) => {w,h}` | 解析 `900x1600`，非法/横屏回 `{900,1600}`（12-18） |
| `defaultBounds` | `(area) => {x,y,w,h}` | 高度 `area.h*0.84`，宽 9:16，居中（20-28） |
| `fullscreenBounds` | `(portrait, area) => {x,y,w,h}` | 铺满高度、按竖屏比例算宽、水平居中（36-46） |
| `sizeFor` | `(mode, portrait, area) => {w,h}` | **两种模式都返回竖屏预设**（55-57） |

关键不变量（写在注释里）：模拟器窗口的宽高比**在开机时被 LCD 锁死**，直接 `SW_MAXIMIZE` 只会得到贴左边、宽度不变的窗口；所以「全屏」= 最大化窗口而**不改 Android 分辨率**（48-54），切换模式不需要重启运行时。

被谁调用：`src/main.js:32`（require）、`:274-277`（`portraitSize()` 读 `display.portrait`）——**只有 `portraitSize` 在运行时代码里被用**；`densityFor/defaultBounds/fullscreenBounds/sizeFor` 目前只被测试调用（`appwin.js:46` 有自己的一份 `AppWindow.sizeFor`）。
测试：✓ `auto-test.js:465` 显示适配：窗口/全屏共用竖屏分辨率，窗口比例 9:16 可拉伸（覆盖 4 个函数）。

---

## 8. 下载 / 部署 / 更新总链路

### 8.1 文字流程图

```
【用户点「一键完成」】
src/ui/app.js:371  deployAll()
   ├─ setStepBusy('all',true)  → 按钮文案「准备中…」(app.js:334)
   ├─ api.autoDeploy()         → preload.js:45  invoke('runtime:autoDeploy')
   └─ IPC runtime:autoDeploy   → main.js:870
        └─ autoDeploy()        → main.js:314  （有 deploying 互斥锁，main.js:313/315）

【autoDeploy 主流程 main.js:314-354】
 1. env = provisioner.checkEnv()                           main.js:319
 2. needEngine = !env.emulator.ok || !env.sysimg.ok        main.js:320
 3. if needEngine && settings.runtime.preferGithubRuntime:
      installRuntimePack(progress)                          provision.js:522
        ├─ resolveRuntimePack()                             provision.js:476
        │    ├─ runtimePackUrl 自定义？直接用                :477
        │    ├─ 并发 GET GitHub / Gitee releases?per_page=15  :487
        │    └─ 找 assets /^ApkStart-runtime-.*\.zip$/，cmpVer 取最高  :497-515
        ├─ guardDisk('runtime', root)   [512+1024=1536MB]    :525 → :262
        ├─ sources.rank(sources.candidates(url))  串行测速   :534-536 → sources.js:399
        ├─ downloadMulti(urls, _tmp/runtime-pack.zip)        :541 → download.js:338
        │    ├─ 并发 Range 探测 → 只混用「总大小一致」的源   download.js:355-381
        │    ├─ 分块 8 线程轮转分配 + .chunks.json 边车     download.js:391-416
        │    └─ 空闲看门狗 20s / 低速 45s&<120KB/s 换源      download.js:449-503
        ├─ 体积闸门 <200MB → 抛「整包下载不完整」            :556
        ├─ extractZip(zip, root)   >64MB 用 ZipFile 流式     :559 → :591
        ├─ 写 <root>/.runtime-pack.json，删 zip              :566-571
        └─ materializeImages()  .img.xz/.gz → .img           :573-576 → :722
      afterPack = checkEnv()                                 main.js:328
      if emulator.ok && sysimg.ok → return {ok:true,source:'github'}
      else → 继续走官方源补齐（main.js:330）
 4. 官方源逐组件兜底（仅当上一步失败/不完整）：
      installAdb()          provision.js:428  → downloadAny  platform-tools.zip
      installEmulator()     provision.js:905  → downloadAnyParallel + extractZip + ensurePlatformTools
      installSystemImage()  provision.js:966  → installPlayImage(:1004) → downloadAnyParallel + extractZip
 5. after = checkEnv()；ok = adb.ok && emulator.ok && sysimg.ok   main.js:347-348
 6. finally deploying=false                                 main.js:351-353

【UI 接着开机 app.js:381-387】
 api.runtimeStart() → main.js:880 → runtime.ensure()        engine.js:787 起
   ├─ provisioner.materializeImages(onLog).catch(()=>{})     engine.js:848
   ├─ checkEnv()                                             engine.js:849
   ├─ killOrphanEmulators()                                  engine.js:856
   └─ boot()  失败则 doctor 诊断 + 变体重试（GPU/accel/内存逐级降）

【启动后的两条后台链】
 A. 自动部署（延迟 20s）main.js:1657-1661 → autoDeploy()   ← 与 UI 同一个函数
 B. 更新检查（打包后延迟 8s）main.js:1665-1676
      updater.check()                     updater.js:73
        └─ sources.latest({force})        sources.js:277
             ├─ fetchReleases() 并发 GitHub/Gitee            :237
             ├─ 403/429 → 熔断 15min                          :286-290
             ├─ 全部失败 → 上一次结果 + stale                  :292-298
             └─ 同版本资产合并（urls[] + sizes{}）、parts 保留  :304-348
      info.hasUpdate → notify + send('update:state')

【用户点「立即更新」】
 main.js:579 runUpdate()  （updateBusy 互斥）
   ├─ updater.prepare(info)                              updater.js:121
   │    ├─ parts?  _downloadParts()  每片单独测速+下载+顺序拼  :182
   │    └─ 否则    candidates→rank→downloadMulti          :140-163
   │    └─ .zip → _extract 到 update/<ver>/payload         :166-173
   ├─ updater.apply(job)                                  updater.js:258
   │    ├─ 生成 PS 脚本（Wait-Process 90s → 复制/静默安装 → 重启 → 清理 → exit 0）
   │    ├─ 落盘 update/apply.log.ps1（排障）               :310
   │    └─ spawn powershell -EncodedCommand（**非 detached**）+ unref  :319-323
   └─ setTimeout(900ms) → quitting=true; app.quit()        main.js:596
        └─ 脚本等进程退出 → 覆盖安装目录 → Start-Process exe → 删 update/<ver>
```

关键时序数字（都是一次性常量，接手时不要随便调小）：
- `autoDeploy` 延迟 **20s**（`main.js:1661`，注释：冷启动磁盘/CPU 已打满）；
- 更新检查延迟 **8s** 且仅 `app.isPackaged`（`main.js:1665-1675`）；
- `apply` 里 `Wait-Process -Timeout 90`、复制 **12 轮 ×600ms**、重启后 400ms 清理（`updater.js:271-306`）；
- `apply` 返回后 **900ms** 退出应用（`main.js:596`）；
- `downloadMulti`：块空闲 **20s**、低速阈值 **45s + 120KB/s**、每块重试 **6** 次、换源上限 **2** 次；
- `download`（单流）：空闲 **30s**、非 2xx 重试 **2** 次 ×1.5s。

### 8.2 这条链上最容易出问题的环节

| # | 现象（用户视角） | 代码位置 | 机理 / 备注 |
|---|---|---|---|
| 1 | **「卡在准备运行时」**，进度条长时间停在 1~3% | `provision.js:531`（固定 `percent:1`）+ `sources.js:412-417`（**串行**测速，每地址 ≤9s）+ `sources.js:52`（256KB/次） | 4 个候选（直连+2 镜像+Gitee）就是 30s+ 的「没有任何字节进度」。网络越差候选越多，越像卡死 |
| 2 | 进度 **停在 99% 很久**，随后又跳回「改用官方源补齐」 | `provision.js:575-576`（`materializeImages(...).catch(()=>0)`）+ `:790`（单镜像失败只 onLog） | `.xz` 展开失败被两层 catch 吞掉 → `checkEnv().sysimg.ok=false` → `autoDeploy` 走 `main.js:330` 再下一套 1.4GB；下次启动还会重试展开 |
| 3 | `@napi-rs/lzma` 相关的乱错 | `provision.js:771-781`（`require.resolve('@napi-rs/lzma')` 再按文件路径 require `index.js`） | 打包时若 lzma 二进制没被带上/被 asar 压住 → `Cannot find module`；注释解释了为什么不能直接 `require('@napi-rs/lzma')`（ESM polyfill） |
| 4 | **「设了运行时目录，还是下到 AppData」** | `provision.js:217-224`（`sysImgRoot` 三分支）、`:726`（`materializeImages` 目标）、`:237`（`avdHome`）、`store.js:67-98`（`runtime.dir` 默认空）、`main.js:97-171`（`bootstrapBundledRuntime` **会覆盖** `runtime.dir`） | ① 老用户 `<DATA_DIR>/system-images` 已存在 → 分支 2 继续用它，不会搬；② 便携版 exe 旁带 `runtime/` 时，`bootstrapBundledRuntime` 在 `main.js:165-168` 直接 `saveSettings({runtime:{dir: bundled}})`，用户手设的目录被覆盖（只有 `sameTree && emulator.exe 存在` 才尊重旧设置，`:144-148`）；③ AVD 另有 `avdDir` 设置，可能与运行时目录不同盘 |
| 5 | 磁盘明明够却报「空间不足」，或反过来解压到一半失败 | `provision.js:262-277`（`need` 表 264-265 无 `'runtime'`）、`main.js:940`（自检阈值 8192MB） | `guardDisk('runtime')` 只估 1536MB，整包 + 展开实际要 ~5GB；guard 通过后仍可能撑爆 |
| 6 | 进度 **卡在 95% 不动**（历史 issue） | 已有对策：`download.js:446-451,492-503`（低速换源）、`:466-480`（保证 settle）；单流路径仍只有 `idleMs=30s`（`:112`） | 慢源拖尾块；边车（`.chunks.json`）保证重试只补缺块，不会整包重下 |
| 7 | 「连接被中断 / 停滞」后整个下载作废 | `download.js:155`（`close` 且 `!complete` → reject）、`:526-528`（块耗尽重试 → 抛 + 存边车） | 设计上可续传；但 `downloadParallel` 见半截文件就降级单流（`:188-191`），多线程退化为单线程 |
| 8 | 更新卡在「正在替换程序并重启」 | `updater.js:315-323`（**不能 detached** 的兼容性注释）、`:271`（Wait-Process 90s）、`:280-285`（复制 12 轮） | 安全软件拦「分离进程」→ 脚本没跑；或卸载/安装被 UAC 挡住；`update/update.log` 是唯一现场 |
| 9 | 更新完程序目录里多了 1.5GB 的奇怪文件 | `updater.js:80`（便携版兜底 `/\.zip$/i`） | 若某版本只有 `ApkStart-runtime-vX.zip` 而没有 `portable` 资产，会被当成更新包解压进安装目录 |
| 10 | Gitee 上「有一个版本没有安装包」 | `.github/workflows/release.yml:36-44,78-100`（100MiB 闸门 + `GITEE_TOKEN` 缺失直接失败）；消费端 `sources.js:172-204`、`updater.js:182-227` | 编译期问题，但现象出现在这里；分片必须 `part1..N` 连续，否则整组被丢弃（`sources.js:196-203`） |
| 11 | 换源/改镜像前缀后仍走老地址 | `main.js:819-825` 只 `sources.reset()`；`provision.js:479,514,642,664,984` 的 `_cache.*` 无失效入口 | 需要重启进程才彻底生效 |
| 12 | 状态轮询把 CPU/进程拉满 | `provision.js:687-714`（`emulatorVersion` 失败不缓存）、`:298-315`（adb 30s 缓存）、`:845-902`（accel 30s + 落盘 6h/10min） | 未安装 emulator 时每次 `checkEnv` 都 `execFile` 探测多路径 |
| 13 | AVD 判定「已被占用」而起不来 | `layers.js:87-90`（锁文件清单）、`main.js:963-969`（自检发现 `.lock`）、`engine.js:856`（`killOrphanEmulators`） | 上次异常退出残留 `*.lock`，清理面板能回收 |
| 14 | 首启把「已装应用/数据」丢掉 | `store.js:179-184`（三处强制迁移）、`engine.js:848`（`materializeImages`）、`doctor.snapshotKey`/`imageIdentity`（快照指纹，`auto-test.js:88,98`） | 迁移是单向的；快照指纹**不含数据分区大小**（`auto-test:1395`），扩容不会清数据 |

### 8.3 给接手者的三条「先看这里」

1. **只看一个函数就能解释八成的部署问题**：`Provisioner.checkEnv()`（`provision.js:367`）。它同时决定了 UI 的「差什么」、`autoDeploy` 的分支、`engine.ensure()` 走 emulator 还是 qemu、以及诊断报告的内容。
2. **路径规则只有一处**：`Provisioner.paths()`（`provision.js:197`）。任何新代码要落运行时文件，必须从这里拿路径，不要自己拼 `DATA_DIR`。
3. **下载策略都收敛在 `Sources` + `downloadMulti`**：新增源只要进 `candidates()`；新增「限速/选优」逻辑只需要改 `rank()` 与 `downloadMulti` 的混源条件，不要在 `provision.js` 里另写一套。
