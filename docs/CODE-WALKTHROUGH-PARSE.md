# ApkStart 离线解析栈代码走读（WIP）

> 面向对象：要接手本项目、继续开发「APK → 图标 → 快捷方式」这条链的工程师。
> 阅读方式：只读代码 + grep 调用点，未运行任何会改状态的命令。
> 版本基准：`package.json` version `0.3.4`（electron ^33.4.11，node >=20）。
> 所有 `文件:行号` 均对应当前工作区快照，改动后请顺手更新。

被走读的文件（`src/core/*.js` 一共 29 个，这里只覆盖解析/图标/关联/版本/日志这一组）：

| 文件 | 行数 | 一句话定位 |
|---|---|---|
| `src/core/zip.js` | 236 | 只用 `zlib` 的 ZIP 读取器（内存版 + fd 流式版） |
| `src/core/axml.js` | 167 | AndroidManifest.xml 的二进制 XML 解析器 |
| `src/core/arsc.js` | 233 | resources.arsc 精简解析器（@0x7f 引用还原） |
| `src/core/png.js` | 132 | 零依赖 PNG 编码器 + 程序化品牌图标 |
| `src/core/apk.js` | 190 | APK 元信息总入口 `parseApk()` |
| `src/core/shortcut.js` | 183 | 多尺寸 ICO 生成 + .lnk 写入 |
| `src/core/assoc.js` | 68 | HKCU 下的 .apk 文件关联 |
| `src/core/version.js` | 36 | 版本号比较（为避免循环依赖单列） |
| `src/core/logfile.js` | 52 | 追加写 + 按大小滚动（日志/工具小模块） |
| `src/core/display.js` | 59 | 显示适配纯计算（附：同属「纯工具」小模块） |

---

## 1. `src/core/zip.js`

### 职责
用 Node 内置 `zlib` 实现的最小 ZIP 读取器：只解析中央目录，按需解压单个条目；另有一个基于文件描述符的流式版本，专门对付 GB 级系统镜像。

### 对外接口
```js
const { ZipArchive, ZipFile } = require('./zip');

new ZipArchive(buffer /*: Buffer，整包 */)
  .entries        // Map<string, {name, flags, method, compSize, uncompSize, localOffset}>  ← 公开字段，外部直接读
  .has(name)      // → boolean
  .names()        // → string[]
  .find(re)       // (RegExp) → string[]（匹配条目名）
  .read(name)     // → Buffer | null（条目不存在返回 null；本地头损坏/压缩方式不支持则 throw）
  .pipeTo(name, dest /*: Writable */)  // → Promise<number>（resolve 未压缩大小，便于校验落盘字节数）

new ZipFile(filePath /*: string */)
  .size           // 文件字节数
  .entries        // 同上
  .has / .names / .find          // 同上
  .close()        // 幂等；fd 置 null
  .read(name)     // → Buffer（不存在时 throw，不是返回 null —— 与 ZipArchive 不一致！）
  .pipeTo(name, dest)  // → Promise<number>
```
> 注意接口不对称：`ZipArchive.read` 缺条目返回 `null`，`ZipFile.read` 抛 `条目不存在`。`apk.js` 里对 `zip.read(...)` 的结果有 `if (data && ...)` 的空值判断，是因为前者。

### 内部关键实现

**ZipArchive —— 整包读内存（不是流式）**
- 构造函数直接吃调用方给的 `Buffer`（`zip.js:14`），自己不碰磁盘。所以「是否整包读内存」取决于调用方：`apk.js:78` 是 `fs.readFileSync`，`installer.js:27` 也是 → **APK 解析路径 100% 整包驻留内存**。
- `_parse()`（`zip.js:20`）：从尾部 `buf.length-22` 往前扫 `EOCD_SIG`，下界 `buf.length - 65557`（`zip.js:23`，= 22 字节 EOCD + 65535 字节最大注释）。找到后 `total` 取 `+10`（u16），中央目录偏移取 `+16`（u32）。
- 中央目录循环（`zip.js:32-47`）：按 46 + nameLen + extraLen + commentLen 步进，字段偏移 8/10/20/24/28/30/32/42 与 PKZIP 规范一致；名字一律按 UTF-8 解（`zip.js:42`），**没有处理 GP flags bit 11**。
- `read()`（`zip.js:54`）：先校验本地文件头签名 `LOC_SIG`，再用**本地头**里的 nameLen/extraLen 算数据起点（`zip.js:61-63`，不能用中央目录的长度，两者可以不等）；`method 0` 返回 `Buffer.from(raw)`（**复制一份**，`zip.js:65`）；`method 8` 用 `zlib.inflateRawSync`（`zip.js:66`）。
- `pipeTo()`（`zip.js:80`）：把 `raw` 按 1MB 切片喂 `createInflateRaw`，用 `write()` 返回 false 时 `once('drain')` 续推（`zip.js:105-116`）；`dest.on('finish')` 与 `dest.on('error')` 共用 `done`，成功后 resolve `e.uncompSize`（调用方可拿它校验字节数）。**注意数据本来就在内存里，分片只是避免 zlib 一次吞 GB 数据，不是省内存。**

**ZipFile —— fd + 尾部窗口**
- 构造：`fs.openSync(path,'r')` + `statSync`（`zip.js:134-135`），`_parse()` 失败时自动 `close()` 再抛（`zip.js:137`，防 fd 泄漏）。
- 只读尾部 `min(size, 22 + 65557 + 4096)` 字节（`zip.js:152`，最多 69675B）做 EOCD 扫描；若中央目录不在这个窗口里（超长注释等），单独 `readAt(cdOffset, min(eocdAbs-cdOffset, 64MB))`（`zip.js:166-172`）。
- `_readAt`（`zip.js:145`）：`Buffer.alloc(len)` + **一次** `fs.readSync`。POSIX 允许短读，这里没有循环重试 → 理论上 64MB 中央目录可能被静默截断（Windows 本地文件通常不会触发，换网络盘/虚拟盘要小心）。
- `read()`（`zip.js:206`）把整条 `compSize` 读进内存再 inflate —— **大条目依旧撞 2GB 上限**；`pipeTo()`（`zip.js:214`）才是流式：`createReadStream(null,{fd, autoClose:false, start, end})`，`end` 是**闭区间**（`zip.js:203` 已经是 `start+compSize-1`）。
- `_range()`（`zip.js:195`）每次读 30 字节本地头校验签名，返回 `{e,start,end}`。

**2GB 限制到底在哪几行**
| 位置 | 含义 |
|---|---|
| `zip.js:75-79`（注释） | 明确记录「GB 级条目无法整块 inflate，会撞 Node 的 2GB 单 Buffer 上限」，这是 `pipeTo` 存在的原因 |
| `zip.js:37` / `zip.js:180` | `uncompSize`、`compSize` 用 `readUInt32LE` 读 → **没有 Zip64**，>4GiB 的条目会读到被截断/别名的值 |
| `zip.js:29-30` / `161-162` | `total` 是 u16（条目数 >65535 就不成立），`cdOffset` 是 u32（Zip64 下为 `0xffffffff`，会命中 `zip.js:166` 的「偏移异常」分支并抛错） |
| `zip.js:208` | `ZipFile.read()` 为整条 `compSize` 分配一次 Buffer → 单条 >2GB 直接 `ERR_BUFFER_TOO_LARGE` |
| `apk.js:78` | `readFileSync` 整包 → 单个 APK >2GB（或 >`buffer.constants.MAX_LENGTH`）在读取阶段就失败，根本进不到 zip 层 |

### 坑点与不变量
1. **本地头 vs 中央目录的 nameLen/extraLen 必须各自读**（`zip.js:61-63`、`198-202`）。两者可能不同（尤其带 data descriptor 或对齐填充时），拿中央目录的值去算本地数据起点是最常见的改坏方式。
2. **data descriptor（GP bit 3）不需要特殊处理**：因为压缩后大小取自中央目录（`zip.js:36/179`），本地头里那三个字段是 0 也无所谓。这一点比很多流式 ZIP 解析器稳。
3. **加密位没有检查**：`flags` 只被保存（`zip.js:34`），从未判断 bit 0；加密条目会以「inflate 失败」的形式报错，错误信息不指向真正原因。
4. **中央目录截断会静默少条目**：`zip.js:176` 的 `break` 在 `off+46 > cd.length` 或签名不对时直接退出，不抛错。表现是「APK 明明有 lib/，abis 却是空」。
5. `ZipArchive.entries` 是公开 `Map`，`apk.js:31`、`apk.js:44`、`provision.js:608` 都直接 `entries.get(name)` 读 `uncompSize`，改数据结构会牵连三处。
6. `pipeTo` 的 `dest` 必须是可写流且由调用方创建（`provision.js:611`、`updater.js:239` 都是 `fs.createWriteStream`），函数内部不 close dest、只等 `finish`。
7. `ZipFile` 用完必须 `close()`（`provision.js:619` 用 `finally`，`updater.js:249` 也是），否则 fd 泄漏。
8. 名字解码统一 `utf8`，GBK 文件名的老 ZIP 会乱码，但 APK 场景都是 ASCII 路径，无实际影响。

### 被谁调用
`ZipArchive`：
- `src/core/apk.js:8`（require）、`apk.js:79`（`parseApk` 主路径）
- `src/core/installer.js:12`、`installer.js:27`（`parseBundle`，拆 .apks/.xapk）
- `src/core/provision.js:15`、`provision.js:595`（小包走内存版）
- `test/run-tests.js:29`、`57`；`test/run-tests.js:119`、`124`（真实夹具）
- `test/engine-test.js:167`、`194`
- `test/auto-test.js:277`、`319`

`ZipFile`：
- `src/core/provision.js:15`、`595`（>64MB 走文件版）
- `src/core/updater.js:21`、`230`（`_extract`，更新包解压）
- `test/auto-test.js:277`、`320`（与 `ZipArchive` 一致性对比）

`pipeTo`：
- `src/core/provision.js:611`、`src/core/updater.js:239`、`src/core/zip.js:80`（自身）

### 测试覆盖
- `test/run-tests.js:30` 「能解析自身所在项目的 package.json 压缩包结构」——名字唬人，实际是手搓一个最小 stored zip（`run-tests.js:32-57`），只覆盖 `has` + `read`。
- `test/engine-test.js:166` 「内置 ZIP 解压可用」——经由 `Provisioner.extractZip`（`provision.js:591`）间接覆盖 `ZipArchive` + `pipeTo`。
- `test/auto-test.js:275` 「ZipFile 与 ZipArchive 对同一压缩包的解析结果一致（含 deflate 与流式 pipeTo）」——唯一同时压 stored/deflate、`read`/`pipeTo`、两个类的用例，`auto-test.js:278-315` 自己拼字节。
- **缺口**：没有 Zip64、没有「中央目录被截断」、没有加密位、没有 `find()` 的用例；`ZipFile.read()` 的大条目路径无覆盖。

---

## 2. `src/core/axml.js`

### 职责
把 APK 里编译后的 `AndroidManifest.xml`（二进制 XML / AXML）解析成普通 DOM 树，供上层按标签/属性查询。

### 对外接口
```js
const { parseAxml, attr, attrValue, children, ANDROID_NS, TYPE_REFERENCE } = require('./axml');

parseAxml(buffer /*: Buffer */)   // → node（根为 manifest；不是 AXML 或空清单会 throw）
// node = { name: string, attrs: Attr[], children: node[], parent: node|null }
// Attr = {
//   ns: string,        // '' 表示无命名空间（nsIdx = 0xffffffff）
//   prefix: string,    // 由命名空间 start/end 事件维护，取到的是「最后声明」的 prefix
//   name: string,      // 属性名（字符串池）
//   value: string|number|boolean|null,  // rawValue 优先，其次按 dataType 解释
//   refId: number|null,   // 仅 dataType=TYPE_REFERENCE(0x01) 时有值（无符号）
//   dataType: number,  // Res_value.dataType 原值
//   typed: string|number|boolean|null,  // reference 时为 null，其余同 value
// }

attr(node, name, ns = ANDROID_NS)   // → Attr | null；ns 传 null 表示不限命名空间
attrValue(node, name, ns = ANDROID_NS)  // → Attr.typed | null
children(node, name)                // → node[]（按标签名过滤，不递归）
ANDROID_NS = 'http://schemas.android.com/apk/res/android'
TYPE_REFERENCE = 0x01
```

### 内部关键实现

**`readStringPool(buf, start)`（`axml.js:26-62`）**
- 头：`type@0`、`headerSize@2`、`chunkSize@4`、`count@8`、`flags@16`、`stringsStart@20`；`isUtf8 = flags & 0x100`（`axml.js:34`）。
- 偏移表紧跟头：`start + headerSize + i*4`（`axml.js:38`）；字符串基址 `start + stringsStart`（`axml.js:40`）。
- UTF-8 池要读**两个**变长长度：先是「UTF-16 长度」（可 1~2 字节，`axml.js:47-48`），再是「UTF-8 字节长度」（`axml.js:50-51`），切片用**后者**。UTF-16 池则是 1~2 个 u16 的长度，且单位是 code unit（切片 `len*2`，`axml.js:58`）。
- 返回 `{ strings, chunkSize }`，调用方只取 `strings`（`axml.js:88`）。

**`parseAxml(buffer)`（`axml.js:67-150`）**
- 头部校验 `RES_XML_TYPE(0x0003)`（`axml.js:69`），`pos = readUInt16LE(2)`（headerSize），`total = readUInt32LE(4)`（`axml.js:72-73`）。
- 逐 chunk 循环 `while (pos + 8 <= total && pos < buf.length)`（`axml.js:81`），读 `type/headerSize/chunkSize`，`chunkSize <= 0` 直接 `break` 防死循环（`axml.js:85`）。
- 命名空间：`nsStack` 存 uri，`prefixByUri` 记 uri→prefix（`axml.js:76-77`）；START 时同时 push + set，END 时只 pop（`axml.js:89-97`）。**同一 uri 多次声明时 prefix 是「后覆盖前」**，`prefixByUri` 从不清理。
- START_ELEMENT（`axml.js:98`）：
  ```js
  nameIdx   = readUInt32LE(pos + 20)
  attrStart = readUInt16LE(pos + 24)   // 相对 ResXMLTree_attrExt 的偏移
  attrSize  = readUInt16LE(pos + 26)   // 单个属性大小，正常 20
  attrCount = readUInt16LE(pos + 28)
  const attrBase = pos + 16 + attrStart;   // ★ axml.js:106
  ```
- 每个属性 20 字节：`ns@0`、`name@4`、`rawValue@8`、`value.size@12`、`value.res0@14`、`value.dataType@15`、`value.data@16`（`axml.js:109-113`）。
- 取值顺序：**rawValue 存在就用池字符串**（`axml.js:120-121`）→ 否则 `TYPE_STRING` 拿 `data` 当池索引（`122-123`）→ `TYPE_REFERENCE` 只记 `refId`（`124-126`）→ boolean（`127-128`）→ dec/hex（`129-130`，`| 0` 变有符号 32 位）。
- 树构建：新节点 `parent` 指向栈顶，push 进父节点后自身入栈（`axml.js:104`、`139-140`）；END_ELEMENT 只弹一层（`141-142`）。
- 收尾：找 `root.children` 里名为 `manifest` 的，找不到就取第一个（`axml.js:147`）；完全没有则抛「APK 清单为空」（`148`）。

### 坑点与不变量

1. **`attributeStart` 的基准（`axml.js:105-106`）是全文件最容易被改坏的一行。**
   `ResXMLTree_node` 头是 16 字节（type 2 + headerSize 2 + chunkSize 4 + lineNumber 4 + comment 4），`ResXMLTree_attrExt` 从 chunk+16 开始，而 `attributeStart` 是**相对 attrExt 的偏移**（正常值 20 = attrExt 自身的 sizeof）。所以正确公式是 `pos + 16 + attrStart`。
   改成 `pos + attrStart` 或 `pos + headerSize + attrStart` 都不会崩，只会**静默解出错位的属性名/命名空间**，外部表现是：应用名退回包名、图标走启发式兜底、`package` 变 `undefined`。目前**没有任何断言或合成字节用例**守住它。

2. **`package` 属性没有命名空间**：`apk.js:88` 用 `attrValue(manifest,'package',null)` 才能取到；`attr()` 的 `ns===null` 分支（`axml.js:154`）就是为此存在。

3. **`rawValue` 与 `dataType` 必须都试**：`android:label`、`android:name` 这类经常 `rawValue = 0xffffffff` 而 `dataType = 0x03`，只读 raw 会得到 null。反过来，有些工具链会写 raw 而不写类型，所以顺序不能反。

4. **`typed` 与 `value` 的区别是刻意的**：`refId` 存在时 `typed = null`（`axml.js:136`），保证 `attrValue()` 不会把「资源 id 数字」当字符串返回。所有上层逻辑（`apk.js:111`、`apk.js:141`）都先看 `refId` 再看 `typed`。

5. **`chunkSize < 8` 没有保护**（只有 `<= 0`，`axml.js:85`），一份畸形 AXML 理论上可以原地打转；APK 场景不会出现，但如果将来解析用户上传的任意文件要补。

6. **不支持的 chunk 被静默跳过**：CDATA(0x0104) 没有分支，靠 `pos += chunkSize` 掠过（`axml.js:144`）。`RES_XML_RESOURCE_MAP(0x0180)` 也只跳过——所以属性名拿的是字符串池里的名字，而不是 resource map 的 attr id。这对本项目够用（按名字查），但**换语言/换 resources 时属性名可能被混淆成 `a`/`b`**（加固/资源混淆的 APK 会这样，此时只能靠 resource map 的 id 反查）。

7. 只解析出 `manifest` 这一棵子树，命名空间 END 之后的兄弟节点不再关心。

### 被谁调用
- `parseAxml`：`src/core/apk.js:9`（require）、`apk.js:86`（清单）、`apk.js:54`（自适应图标 XML 也复用同一个解析器）
- `attr`：`src/core/apk.js:62`（`attr(node,'drawable')`）
- `attrValue`：`apk.js:18`、`19`（intent-filter 的 action/category）、`88`、`91`、`92`、`96`、`97`、`124`、`125`
- `children`：`apk.js:16`、`19`、`95`、`99`、`121`
- `ANDROID_NS`：**只在 `apk.js:9` 被 import，没有任何使用**（死导入）；真正用到它的是 `attr()` 的默认参数（`axml.js:152`）
- 测试：`test/run-tests.js:80`（require）、`run-tests.js:120`
- 无其他模块直接消费（`arsc.js` 自己另写了一份字符串池）

### 测试覆盖
- `test/run-tests.js:118` 「AXML 根节点是 manifest」——**依赖真实 APK 夹具**（`run-tests.js:86-100` 找 `APKSTART_TEST_APK` / `test/fixtures/sample.apk` / `Documents/*.apk`）；找不到就整段跳过（`run-tests.js:130-132`）。
- 没有合成 AXML 字节级用例 → 在没夹具的机器（CI）上 `axml.js` 等于零覆盖，`attributeStart` 这类偏移错误不会被发现。
- `attr` / `attrValue` / `children` / `ANDROID_NS` / `TYPE_REFERENCE` 的导出没有直接单测。

---

## 3. `src/core/arsc.js`

### 职责
精简版 `resources.arsc` 解析器：把 Manifest 里的 `@0x7f...` 资源引用还原成应用名字符串和图标文件路径。

### 对外接口
```js
const { ResTable, TYPE_REFERENCE } = require('./arsc');

new ResTable(buffer /*: Buffer，整份 resources.arsc */)
  .globalStrings   // string[]：文件级字符串池（value.data 就是这里的下标）
  .packages        // Array<{ id:number, typeStrings:string[], keyStrings:string[],
                   //         types: Map<number /*typeId*/, Array<{id, config, entries: Map<number, {dataType,data} >}>> }>
  .resolve(ref /*: number, 0xPPTTEEEE*/, prefer /*: 'string'|'file'|'any' = 'any' */, depth = 0)
                   // → string | number | boolean | null
TYPE_REFERENCE = 0x01   // 导出但项目内没有外部使用者
```

### 内部关键实现

**三层结构（`arsc.js:9-15`）**
`ResTable`(0x0002) → `ResTable_package`(0x0200) → `ResTable_type`(0x0201)。`RES_TABLE_TYPE_SPEC_TYPE`(0x0202) 有常量但从不处理。

**`readStringPool(buf,start)`（`arsc.js:23-46`）**
和 `axml.js:26` 是**同一份逻辑的复制粘贴**（UTF-8/UTF-16 双分支、两个 varint 长度）。两处必须同步维护。

**`_parse()`（`arsc.js:87-106`）**
- 校验 `RES_TABLE_TYPE`（`89`），`total@+4`，`pkgCount@+8`（读了但只在循环里用 `pos<total` 控制，`pkgCount` 实际未用于计数）。
- 只把**第一个**字符串池当 `globalStrings`（`99-100` 的 `this.globalStrings.length === 0` 条件），后续包内的池不会被误当全局池。

**`_parsePackage(start,size)`（`arsc.js:108-139`）**
- 字段：`id@+8`、`typeStrings@+268`、`keyStrings@+276`、`headerSize@+2`（`111-113`）——这是 `ResTable_package` 的固定布局（name[128] UTF-16 占 12..268）。
- 两个字符串池读取包在 `try/catch` 里（`117-120`），失败只是丢掉类型名/键名，**不影响 `resolve`**（这是刻意的容错，不变量见下）。
- 子 chunk 循环 `while (pos + 8 <= end)`，只处理 `RES_TABLE_TYPE_TYPE`（`125-137`），按 `typeId` 聚成 `Map<number, chunk[]>`（同 typeId 的多个 config 各占一项）。

**`_parseType(start)`（`arsc.js:141-179`）**
- 头：`headerSize@+2`、`id@+8`（u8）、`flags@+9`（u8）、`entryCount@+12`（u32）、`entriesStart@+16`（u32）、`config@+20`。
- 偏移表从 `start + headerSize` 开始，条目数据从 `start + entriesStart` 开始（`151-152`）。
- 三种编码：
  - `FLAG_SPARSE(0x01)`：每项 4 字节 `{idx:u16, offset:u16}`，**offset 单位是 4 字节**（`157-158` 的 `*4`）
  - `FLAG_OFFSET16(0x02)`：`offset:u16`，`0xffff` 表示空，**同样 `*4`**（`165-167`）
  - 普通：`offset:u32`，`0xffffffff` 表示空（`172-173`）
- 三个 `*4` 是 Android 的 compact entry 编码，删掉就全部错位。

**`_readValue(at)`（`arsc.js:181-192`）**
- `ResTable_entry`：`size@0`（u16）、`flags@2`（u16）；`flags & 0x0001` = `FLAG_COMPLEX`（bag/map，样式、数组、attr 都在这里）→ **直接返回 null**（`186`）。
- `valueAt = at + entrySize`（`187`，entrySize 可以是 8 或 16），`Res_value` 的 `dataType@+3`、`data@+4`（`189-190`）。
- 没有校验 `Res_value.size`（约定为 8），也没有做 `at+8` 之外的边界检查（只有 `183` 一处）。

**`parseConfig` / `score`**
- `ResTable_config` 布局：`size@0`、`imsi@4`、`locale(language@8,country@10)`、`screenType(orientation@12,touchscreen@13,**density@14**)`、`input@16`、`screenSize@20`、`version(**sdkVersion@24**)`、`screenConfig(screenLayout@28,**uiMode@29**)`（`48-59`）。
- `isDefault = !language && !country && density===0 && !sdkVersion`（`60`）——**没有把 `uiMode` 算进去**，所以只带 `uiMode` 的 config 会被当成 default。
- 打分（`65-77`）：
  - `prefer='file'`：`s += density`（高密度优先），`anydpi(0xfffe)` 额外 `-500`（怕拿到 xml 自适应图标，注释 `69`）
  - 其它：无密度优先，`language` −40、`sdkVersion/1000`、`uiMode` −20（即偏好「无语言、低 sdk、无 uiMode」的默认配置）

**`resolve(ref,prefer,depth)`（`arsc.js:200-230`）**
- `depth > 6` 或 `ref` 为 0 直接 null（防循环引用，`201`）。
- 拆包名 `pkgId = ref>>>24`、`typeId = (ref>>>16)&0xff`、`entryIdx = ref&0xffff`（`202-204`）。
- **包找不到时退化到 `packages[0]`**（`206`）——多包 APK（共享库 0x02/0x03）可能查错包。
- 在同 typeId 的所有 config 里挑 `score` 最高的（`211-217`）。
- `TYPE_STRING` → `globalStrings[data]`（`220-222`，undefined 返回 null）；`TYPE_REFERENCE` → 递归（`224-226`）；boolean/dec/hex 直接返回（`227-228`）；其它 null（如 `TYPE_DIMENSION`、颜色，这里不解析）。

### 坑点与不变量

1. **`globalStrings` 必须是文件级池**：`value.data` 是全局池下标；包内的 `typeStrings/keyStrings` 只用于调试展示。所以 `_parsePackage` 里那个 `try/catch` 吞掉错误是安全的——`resolve` 不依赖它。**改代码时不要把 `resolve` 改成用 `keyStrings`。**
2. **`score()` 里的常量都是经验值**：`anydpi` 罚 500、`language` 罚 40。目的是「中文应用优先拿默认资源、图标优先拿最高密度」；但代价是**应用名可能拿到英文**（`values/` 是默认，`values-zh/` 被扣分）。当前只寻求「能显示」，不做系统语言匹配。
3. **`FLAG_COMPLEX` 的资源一律拿不到**：`android:icon` 若指向 `<bitmap>`/`<shape>` 这类 bag 资源会返回 null，然后落到 `apk.js` 的启发式兜底。
4. **稀疏/16 位偏移的 `*4` 不能省**（`158`、`167`）。
5. **`pkgCount` 读了不用**（`92`）：顶层 chunk 遍历靠 `pos<total`，如果文件里混入非包 chunk 也不会错，但 `pkgCount` 是个 dead variable。
6. 没有 `ResTable_typeSpec`、没有 overlayable/staged alias、没有 locale 匹配、没有 `0x00` 动态包。
7. `TYPE_REFERENCE` 常量导出但无人使用（`arsc.js:233`），属于 API 噪音。

### 被谁调用
- `ResTable`：`src/core/apk.js:10`（require）、`apk.js:104`（`try/catch` 内构造，失败降级为 `res=null`）
- `resolve`：`apk.js:65`（自适应图标 `drawable`）、`apk.js:111`（`label`，`'string'`）、`apk.js:141`（`icon`/`roundIcon`，`'file'`）、`arsc.js:225`（自身递归）
- 测试：`test/run-tests.js:81`（require）、`run-tests.js:126`
- `TYPE_REFERENCE`：全项目无消费者

### 测试覆盖
- `test/run-tests.js:123` 「resources.arsc 可解析」——只断言 `res.packages.length > 0`，同样依赖真实 APK 夹具，无夹具则跳过。
- 没有 `resolve()` 的用例（没有一条断言「某个 ref 能解析出预期字符串/路径」），也没有 FLAG_SPARSE / FLAG_OFFSET16 / FLAG_COMPLEX 的用例。
- 结论：**这条链里 `arsc.js` 的测试是最薄的**，逻辑却最难（三种 entry 编码 + config 打分）。

---

## 4. `src/core/png.js`

### 职责
零依赖 PNG **编码**器 + 程序化绘制 ApkStart 品牌图标（避免往仓库塞二进制素材，也方便换主题色）。

> 注意方向：只有编码（RGBA → PNG），**没有解码**。解 WebP/PNG 全靠 Electron 的 `nativeImage` / Chromium（见第 6 节）。

### 对外接口
```js
const { encodePng, drawAppIcon } = require('./png');

encodePng(width, height, rgba /*: Uint8Array，长度必须 = w*h*4，RGBA 顺序 */)  // → Buffer(PNG)
drawAppIcon(size = 256)  // → Buffer(PNG)，size×size
```

### 内部关键实现
- **CRC32**（`png.js:8-22`）：标准反射多项式 `0xedb88320`，查表 256 项，`Int32Array` 存；`crc32()` 返回 `>>> 0` 的无符号值。
- **chunk()**（`png.js:24-31`）：`[len BE][type ascii][data][crc BE]`，CRC 覆盖 type+data。
- **`encodePng`**（`png.js:34-55`）：
  - IHDR 13 字节：`width/height` BE、bitDepth=8、colorType=6（RGBA）、compression/filter/interlace 全 0（`png.js:36-40`）
  - 原始数据 `raw = (width*4+1)*height`，每行首字节写 filter 0（None），其余用 `Buffer.from(rgba.buffer, byteOffset + y*stride, stride)` 拷贝（`png.js:43-48`）——**要求 `rgba` 的 `byteOffset` 是有效偏移**，传 `Uint8ClampedArray` 视图也可以
  - 只有一个 IDAT，`zlib.deflateSync(raw, {level:9})`（`png.js:52`），`level:9` 对 256×256 约几十毫秒
- **`drawAppIcon`**（`png.js:80-130`）：
  - 4× 超采样：`SS=4`、`S=size*4`；`acc = Float32Array(size*size*4)` 累积颜色（`png.js:83`）
  - 形状：圆角矩形 `pad = 6%`、半径 `24%`（`85-86`），用 `roundRectAlpha()`（`59-65`，「把点夹到内矩形、算到最近圆心距离」）判定；三角形 `pointInTriangle()`（`67-74`，三次叉积同号判内）
  - 配色：对角渐变 `t = (x/S)*0.6 + (y/S)*0.4` → `r 20..34 / g 26..44 / b 33..57`；三角纯色 `#3ddc84` = (61,220,132)（`105-111`）
  - 采样只累计盒内样本（`102` 的 `if (!inBox) continue;`），盒外 alpha 保持 0；最后统一除以 `n = SS*SS = 16`（`122-127`）→ 边缘得到 0..255 的覆盖率，即抗锯齿
- **性能边界**：`size=256` → `S=1024`，1,048,576 次迭代，每次 1~2 次几何判定；单次调用约 5–15ms 量级。`size=512` 是 4M 次迭代（约 4 倍）。`main.js:175` 在启动时算一次 `ICON_PNG` 并缓存，所以不是热路径。

### 坑点与不变量
1. **`acc` 必须是 `Float32Array`**：16 个样本累加，`Uint8Array` 会溢出/截断成 255，出现色块。改成 Uint16 也可以，但除法那行要同步。
2. `encodePng` 假定 `rgba.length >= w*h*4`，**没有长度校验**；短的会 `copy` 抛 RangeError，长的被忽略。
3. 只支持 RGBA8 / filter 0 / 单个 IDAT —— 这是「够用就好」的编码器，想加 filter 优化（Paeth）要重写 `raw` 填充循环。
4. `drawAppIcon` 的坐标全部相对 `S`（超采样空间），改 `SS` 不影响构图；改 `size` 只影响清晰度/耗时。
5. 这是「品牌占位图标」的来源，也是 `iconToIco` 第三级兜底的输入（`shortcut.js:128-129`），所以在**任何图标抽取失败**的场景，用户桌面上看到的都是这个绿色三角。

### 被谁调用
- `drawAppIcon`：`src/main.js:15`（require）、`main.js:28`（`loadBrandIcon()` 的兜底，`LOGO_FILE` 不存在时用）
- `src/core/shortcut.js:128`（require）、`129`（占位 ICO）
- `encodePng`：仅 `png.js:129`（`drawAppIcon` 内部）+ 测试
- 测试：`test/run-tests.js:63`（require）、`66`、`73`；`test/auto-test.js:496`、`497`；`test/electron-integration.js:22`、`27`

### 测试覆盖
- `test/run-tests.js:64` 「PNG 编码器输出合法签名与 IHDR」——查签名 `0x89 0x50`、`IHDR`、长度 > 50，**不校验 CRC、不校验像素**。
- `test/run-tests.js:71` 「应用图标可按任意尺寸绘制」——16/32/64/256 输出宽度等于入参。
- `test/auto-test.js:494` 间接用 `drawAppIcon(64)` 当 PNG-in-ICO 的素材。
- 缺口：`drawAppIcon` 的**像素正确性**没有任何断言（只测尺寸）；`encodePng` 的尺寸/长度异常入参没测。

---

## 5. `src/core/apk.js`（总入口）

### 职责
离线提取 APK 元信息：包名 / 版本 / 应用名 / 启动 Activity / 图标 / ABI。不依赖 aapt、adb、网络。

### 对外接口
```js
const { parseApk, quickCheck } = require('./apk');

parseApk(filePath /*: string */) → {
  ok: true,
  filePath,          // 原样返回
  sizeBytes,         // fs.statSync 的 size
  package: string,   // 必须有，否则 throw
  label: string,     // 已折叠空白 + trim + 截断 60 字符
  versionName: string,   // 缺省 '1.0'
  versionCode: number,   // 非 number 时为 0
  minSdk: number,        // 缺省 0
  targetSdk: number,     // 缺省 0
  launchActivity: string|null,
  abis: string[],        // ['arm64-v8a', ...]，无 lib/ 时 []
  iconPng: Buffer|null,  // 图标原始字节（PNG 或 WebP！字段名有误导）
  iconFile: string|null, // APK 内路径，如 'res/mipmap-xxxhdpi-v4/ic_launcher.png'
}   // 失败一律 throw（不返回 ok:false）

quickCheck(filePath /*: string */) → boolean   // 只读前 4 字节判 'PK'，任何异常返回 false
```

### 内部关键实现（`parseApk`，`apk.js:75-175`）

1. `fs.statSync` → `size < 1024` 抛「文件过小」（`76-77`）。
2. `const buf = fs.readFileSync(filePath)`（`78`）→ **整包进内存**，这是全链最重的一步。
3. `new ZipArchive(buf)`（`79`）。
4. 必须有 `AndroidManifest.xml`，否则提示「可能是 .apks/.xapk 拆分包」（`81-83`）。
5. `zip.read` + `parseAxml`（`85-86`）。
6. `package`：**先按无命名空间查**（`88`，`attrValue(manifest,'package',null)`），再退回默认命名空间（兜底写法）。
7. `versionName` 缺省 `'1.0'`，`versionCode` 只接受 number（`91-93`）。
8. `uses-sdk` 的 `minSdkVersion` / `targetSdkVersion` 用 `| 0` 归一（`95-97`）——`null | 0 === 0`。
9. `application` 节点取第一个，兜底一个空对象（`99`）。
10. 资源表：有 `resources.arsc` 才构造 `ResTable`，**整体 try/catch**（`103-105`）→ arsc 坏掉时 `res=null`，后续所有 `refId` 解析失败并自动落到默认值。
11. 应用名（`108-117`）：`attr(app,'label')` → `res.resolve(refId,'string')` → 否则 `typed` 是 string 就用 → 否则**包名最后一段首字母大写**。
12. 启动 Activity（`120-134`）：
    - 候选 = `activity` + `activity-alias`（`121`）
    - `isLauncherActivity`（`15-25`）：**同一个 `intent-filter` 内**必须同时包含 `android.intent.action.MAIN` 和 `android.intent.category.LAUNCHER`（不是跨 filter 组合）
    - 名字补全：`.` 开头 → `package + n`；不含 `.` → `package.n`；否则原样（`127-129`）
    - `activity-alias` 且带 `targetActivity` 时**覆盖**为 target（`130-132`，判断用的是节点名 `launcher.name === 'activity-alias'`）
13. 图标（`137-152`）：`icon` 优先、`roundIcon` 兜底（`138`）→ `res.resolve(refId,'file')` 或 `typed` 字符串 → `zip.has(file)` 校验 → `.xml` 走 `iconFromAdaptiveXml`，否则直接 `zip.read(file)` → 最后 `!icon` 时 `pickIconFromZip`。
14. ABI（`155-158`）：`lib/` 前缀条目取第 2 段去重。
15. 返回对象（`160-174`）。

**`iconFromAdaptiveXml(zip, xmlBuffer, res)`（`apk.js:51-73`）**
- 解析自适应图标 XML，按 `['foreground','background','monochrome']` 顺序找**直接子节点**（`58-60`），也接受根节点本身就是其中之一（`60` 的后半段）
- 取 `android:drawable`：`refId` → `res.resolve(...,'file')`，否则 `typed` 字符串（`62-66`）
- **只接受 `.png`/`.webp`**（`67`）且必须 `zip.has(file)`（`68`），`data.length > 100` 才返回（`70`）
- 不会递归进 `<inset>`、`<layer-list>`、`<bitmap>`；XML 自身解析失败返回 null（`53-57`）

**`pickIconFromZip(zip)`（`apk.js:27-48`，启发式兜底）**
- 候选：`/^res\/.*\.(png|webp)$/i`（`29`）
- 评分 = `entries.get(n).uncompSize` **未压缩字节数**（不是像素尺寸），再乘名字权重：
  - `ic_launcher|app_icon|ic_app` ×6（`33`）
  - `_round|_foreground|_background` ×0.4（`34`）
  - `xxxhdpi` ×1.6 / `xxhdpi` ×1.4 / `xhdpi` ×1.2（`35-37`）
- 降序排序后只试前 30 个（`41`），`data.length > 100` 才接受（`44`），否则 null。

### 坑点与不变量
1. **整包 `readFileSync`（`apk.js:78`）**：解析一个 500MB 的 APK 会让进程多占 500MB 常驻内存；`>2GB` 直接 `ERR_FS_FILE_TOO_LARGE`。`.apks`/`.xapk` 走 `installer.parseBundle` 时更糟（外层 ZIP 也整包读，再把每个 split 写盘、再各自 `parseApk`）。
2. **`iconPng` 字段名骗人**：`apk.js:172` 返回的是**原始图标字节**，可能是 WebP（`res/mipmap-*/ic_launcher.webp`）。所以 `shortcut.iconToIco` 必须做三级兜底，`installer.js:208-209` 把它当 `.png` 存盘也是「文件名 .png、内容可能 WebP」——Chromium/nativeImage 读时按魔数识别，能显示，但用外部工具打开会不一致。
3. **`launchActivity` 只是「APK 里声明的」**：`installer.js:227-234` 明确注释「APK 里解析到的主 Activity 经常不是真正的 LAUNCHER 入口」，安装后会再用 `client.resolveLauncher(pkg)` 覆盖。**不要在这里加启动逻辑。**
4. **`activity-alias` 的 target 处理**：`130-132` 用的是 `launcher.name`（标签名），如果同一个 activity 既有 alias 又有真实声明，两次都命中时取先找到的那个；顺序是 `activity` 在前、`activity-alias` 在后（`121`）。
5. **`pickIconFromZip` 的 `apk.js:38`** 是遗留死代码：`if (/\//.test(n.split('/')[1] || '')) { /* noop */ }`，没有任何作用，删掉安全。
6. **评分用 `uncompSize`**：一个「高压缩比、像素极大」的图（纯色启动图）可能因为压缩后小反而排后；纯色图标也可能排在照片前面。这是启发式的天然缺陷。
7. **`label` 兜底**：`a.b.c` → `C`，所以包名 `com.example.game` 会显示成 `Game`。中文应用在 arsc 解析失败时会退化成英文段，属于可接受降级。
8. **`res` 为 null 时不会抛错**，`label`/`icon` 都退回默认——这条容错路径让「ARSC 解析器坏了」表现为「图标变丑、名字变英文」，而不是报错。排查时要先看 `iconFile` 是不是兜底挑出来的。
9. `quickCheck`（`178-188`）**在 `src/` 里没有任何调用者**（只有测试用），是死代码；`apk:parse` IPC 通道（`main.js:756`）也只被 `preload.js:10` 暴露，`src/ui/app.js` 没有消费（UI 实际走 `installApk`，`ui/app.js:484`）。

### 被谁调用
- `parseApk`：
  - `src/main.js:14`（require）、`main.js:756`（IPC `apk:parse`）
  - `src/preload.js:10`（`window.apkstart.parseApk`）
  - `src/core/installer.js:11`（require）、`installer.js:40`（拆分包里找 base）、`installer.js:149`（安装主路径）
  - `scripts/selftest.js:18`、`142`
  - 测试：`test/run-tests.js:82`、`106`；`test/electron-integration.js:24`、`55`
- `quickCheck`：**只在 `test/run-tests.js:103-104` 使用**
- 间接（`installer.install`）：`src/main.js:758`（IPC `apk:install`）← `src/ui/app.js:484`

### 测试覆盖
- `test/run-tests.js:103` 「quickCheck 识别 PK 头」
- `test/run-tests.js:107` 「解析出包名 / 版本 / 启动 Activity」——断言 `package` 匹配 `^[\w.]+$`、有 `versionName`、`launchActivity` 含 `.`
- `test/run-tests.js:113` 「解析出可用图标」——`iconPng.length > 100` 且 `label` 非空
- 以上三条都**依赖真实 APK 夹具**，无夹具时整段跳过（`run-tests.js:130-132`）→ CI 上等于没测
- `test/electron-integration.js:54-62` 用真实 APK 跑「APK 图标 → 多尺寸 ICO」，失败时日志写「图标可能是 webp/jpg 之外的格式」
- 缺口：`.apks`/`.xapk`（`installer.parseBundle`）无任何用例；`activity-alias`、无 arsc、无图标 的负例都没测

---

## 6. `src/core/shortcut.js`

### 职责
把 APK 图标转成多尺寸 ICO，并写 Windows 桌面/开始菜单 `.lnk`；三级兜底保证快捷方式**永远**有图标。

### 对外接口
```js
const {
  pngToIco, pngBytesToIco, iconToIco,
  writeShortcut, removeShortcut, safeFileName, ICO_SIZES,
} = require('./shortcut');

ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]   // 9 档，导出但项目内无外部消费者

pngToIco(pngBuffer)                  // → Buffer(ICO, DIB 多尺寸) | null；★ 内部 require('electron')，纯 Node 下会抛 TypeError
pngBytesToIco(png)                   // → Buffer(ICO, PNG-in-ICO 单尺寸) | null；纯 Node 可用
iconToIco(raw, { decode } = {})      // async → Buffer(ICO) | null；三级兜底
writeShortcut({                      // → string（写成功的 shortcutPath）
  shortcutPath, target, args?, iconIcoPath?, description?, cwd?, appUserModelId?,
})                                   // 失败 throw（三种错误文案见下）
removeShortcut(p)                    // → boolean，异常吞掉
safeFileName(name)                   // → string，替换非法字符 + 折叠空白 + 截 60 字符，空则 'Android App'
```

### 内部关键实现

**`buildDib(bgra, size)`（`shortcut.js:13-33`）**
- 手写 40 字节 `BITMAPINFOHEADER`：`biSize=40`、`biWidth=size`、`biHeight=size*2`（XOR + AND 两段）、`biPlanes=1`、`biBitCount=32`、`BI_RGB`、`biSizeImage=size*size*4`（`14-21`）
- XOR 位图**自下而上**翻转行序（`25-28`，ICO/DIB 的 y 轴朝上）
- AND 掩码 1bpp、行按 4 字节对齐、**全 0**（`30-31`，注释说明「交给 alpha 通道」）

**`pngToIco(pngBuffer)`（`shortcut.js:39-73`）—— 多尺寸 DIB 路线**
- `require('electron')` 在函数内（`40`），`nativeImage.createFromBuffer`，`isEmpty()` 返回 null（`41-42`）
- 对 9 档尺寸逐个 `resize({quality:'best'})` → `buildDib(img.toBitmap(), s)`（`45-51`）
- `img.toBitmap()` 在 Windows 上是 **BGRA**，正好是 DIB 需要的顺序，不需要通道交换
- ICONDIR：`reserved=0, type=1, count=n`，每项 16 字节：`width/height` u8、`colorCount=0`、`reserved=0`、`planes=1`、`bitCount=32`、`bytesInRes`、`imageOffset`（`53-72`）
- **宽高字节在 `>=256` 时写 0**（`61-62`）——ICO 目录里单字节 0 表示 256

**`pngBytesToIco(png)`（`shortcut.js:83-101`）—— PNG-in-ICO 路线**
- 校验：`Buffer` 且 `length >= 24` 且 `[1,4)` 是 `'PNG'`（`84`），从 IHDR 读 BE 的 `w@16`、`h@20`，`w/h` 非零且 `<= 1024`（`85-87`）
- ICONDIR 固定 22 字节（6 + 16），`bytesInRes = png.length`，`imageOffset = 22`（`88-99`），数据区**直接就是原 PNG 字节**（不重编码、不丢 alpha）
- Vista 起合法，所以注释说「老的 DIB 路线在这里会整包失败」（`80-82`）

**`iconToIco(raw, {decode})`（`shortcut.js:109-133`）三级兜底**
1. `nativeImage.createFromBuffer(raw)` 能解（真 PNG/JPEG）→ `img.toPNG()` → `pngToIco`（`111-118`）。**`toPNG()` 是必要的**，因为 raw 可能是 JPEG，而 `pngToIco` 只吃 PNG/JPEG 都行但 DIB 需要像素
2. 有 `decode` 回调 → `await decode(raw)` 得到 PNG → `pngBytesToIco`（`120-126`）。WebP 走这条（Chromium 解）
3. 占位：`drawAppIcon(256)` → `pngBytesToIco`（`127-132`）
4. 全失败返回 null

**`writeShortcut(opt)`（`shortcut.js:144-169`）**
- 目录不存在就 `mkdirSync(recursive)`，失败抛「快捷方式目录不可写」（`146-151`）
- **已存在的 .lnk 先 `unlinkSync`**（`152-154`）
- `shell.writeShortcutLink(path,'create',{target,args,icon,iconIndex:0,description,cwd,appUserModelId})`（`155-163`），`icon` 缺省用 `target`
- 返回 false 抛「创建快捷方式失败」（`164`）
- **回读校验**：`fs.existsSync(shortcutPath)` 为假抛「快捷方式未落盘」（`165-167`）——注释（`138-141`）记录了这个坑：安全软件拦截、桌面被重定向到未登录网盘时，「返回 true 但文件不存在」

**`safeFileName`（`shortcut.js:75-77`）**
`[\\/:*?"<>|]` → `_`、`\s+` → 空格、trim、`slice(0,60)`、空则 `'Android App'`。Windows 保留名（CON/PRN/NUL…）**没有处理**。

### 坑点与不变量
1. **`pngToIco` 不能在纯 Node 下跑**：`require('electron')` 在 Node 里返回的是 electron.exe 的**路径字符串**，解构出的 `nativeImage` 是 `undefined`，`createFromBuffer` 直接 TypeError（函数内没有 try/catch）。这就是为什么所有 `pngToIco` 用例都在 `test/electron-integration.js`（用 `electron test/...` 跑），而 `npm test` 只测 `pngBytesToIco`/`iconToIco`。
2. **`shortcut.js:46-48` 的三元两个分支代码完全相同**（只差注释），等价于无条件 `resize`。属于「注释解释了一个并不存在的分支」，可清理。注释表达的真实意图是：**小图放大比缺尺寸好**（会把 64px 图标插值到 256px，显糊但不会出现空图标位）。
3. **`pngBytesToIco` 的尺寸不变量**：目录宽高是单字节，`>=256` 写 0（=256）。如果传入 512×512 的 PNG，目录会**声称 256 而数据是 512**，部分 shell 会拒显。当前靠调用方保证：`main.js:223` 的 `decodeIcon` 用 `Math.min(256, ...)` 钳过，`pngToIco` 最大也只到 256。**这个约束是隐式的，新增调用方时最容易踩。**
4. **DIB 的 AND 掩码全 0**：依赖 32bpp 的 alpha 通道。XP 风格的老 shell 对 32bpp alpha 处理不一致，但 Win10/11 没问题。
5. **`writeShortcut` 先删后建**：会丢失原 .lnk 上的「固定到任务栏」「以管理员身份运行」等属性。`installer.createShortcut` 每次重装都会重建，所以用户手动 pin 的项可能失效（pin 的是 AUMID，通常还能恢复）。
6. **`icon: opt.iconIcoPath || opt.target`**：ico 生成失败时用 exe 图标，不会出现「白纸」图标。
7. **`appUserModelId` 是可选项**（`162`），`installer.js:299` 之后传了「每个应用一个 AUMID」来分组任务栏——注释在 `installer.js:299`，`writeShortcut` 只是透传。
8. `removeShortcut` 吞掉所有异常返回 false；`installer.uninstall` 不检查返回值（`installer.js:373-374`）。

### 被谁调用
- `pngToIco`：`src/main.js:1310`（require）、`1311`（品牌 ICO 缺失时现算）；`shortcut.js:115`（`iconToIco` 内部）；`test/electron-integration.js:23`、`29`、`56`
- `pngBytesToIco`：`shortcut.js:123`、`129`；`test/auto-test.js:495`、`498`、`502`
- `iconToIco`：`src/core/installer.js:13`（require）、`212`（安装时）、`346`（补建图标时）；`test/auto-test.js:495`、`505`、`507`
- `writeShortcut`：`installer.js:13`、`292`（`createShortcut`）；`test/electron-integration.js:23`、`35`
- `removeShortcut`：`installer.js:13`、`373`、`374`（卸载）
- `safeFileName`：`installer.js:13`、`75`（桌面路径）、`88`（开始菜单路径）、`319`（兜底路径）
- `ICO_SIZES`：仅 `shortcut.js:45` 使用；导出无外部消费者
- 调用上下文：`ctx.decodeIcon` 由 `main.js:213` 定义、`main.js:1498` 注入 `Installer`

### 测试覆盖
- `test/auto-test.js:494` 「PNG-in-ICO 与 WebP 图标兜底都能产出可用 ICO」——断言 ICO 头 `type=1/count=1`、`bytesInRes` 等于 PNG 长度、`ico.slice(22)` 与原 PNG 完全相等、非法输入返回 null、WebP 无 decode 时回退占位、有 decode 时用真实图。**这是本文件覆盖最好的一条。**
- `test/electron-integration.js`（`electron test/electron-integration.js`，**不在 `npm test` 里**）：步骤「生成 ICO」「创建 .lnk」「删除 .lnk」「APK 图标 → 多尺寸 ICO」，结果写 `test/out/result.json`。
- 缺口：`pngToIco` 的 DIB 字节结构没有断言（只在 Electron 集成里「能生成且 >1000 字节」）；`safeFileName` 的保留名/超长/非法字符无单测；`writeShortcut` 的「返回 true 但没落盘」分支无法在测试中构造。

---

## 7. `src/core/assoc.js`

### 职责
在 `HKCU\Software\Classes` 下注册/注销 `.apk` 文件关联（不需要管理员权限），双击 APK → `apkstart.exe "%1"`。

### 对外接口
```js
const { registerAssociation, unregisterAssociation, PROGID } = require('./assoc');
PROGID = 'ApkStart.apk'

registerAssociation(exePath /*: string, 必填 */, iconPath /*?: string */, extraArgs /*?: string */)
  // → { ok: true, progId: 'ApkStart.apk' }   ★ 永远 ok:true，即使每条 reg 都失败
unregisterAssociation() → { ok: true }        // 同上
```

### 内部关键实现
- `reg(args)`（`assoc.js:11-18`）：`execFileSync('reg', args, {windowsHide:true, stdio:'pipe'})`，**异常全部吞掉返回 false**，不向上传播。→ 所有注册表写入都是「尽力而为」，调用方拿不到失败信息。
- `notifyShell()`（`assoc.js:20-33`）：PowerShell `Add-Type` P/Invoke 调 `SHChangeNotify(0x08000000=SHCNE_ASSOCCHANGED, 0, NULL, NULL)` 让资源管理器刷新图标/关联；`timeout: 8000`，失败忽略（注释 `32`）。
- `registerAssociation`（`assoc.js:40-56`）写 6 条：
  1. `HKCU\Software\Classes\.apk` 默认值 = `ApkStart.apk`
  2. `.apk\OpenWithProgids` 增加 `ApkStart.apk`（`REG_NONE` 空值，`46`，这是「打开方式」列表里出现的正确写法）
  3. `ApkStart.apk` 默认值 + `FriendlyTypeName` = 「Android 应用包」
  4. `DefaultIcon` = `"<icon>",0`
  5. `shell\open` 默认值 = 「安装到 ApkStart」
  6. `shell\open\command` = `"<exePath>" <extraArgs> "%1"`（`43`）
- `command` 拼接（`assoc.js:43`）：`extraArgs` **由调用方负责带引号**（开发模式要传应用目录）。实际调用点：`main.js:1315` 传 `l.args`（`launcherInfo()` 已带引号），`scripts/assoc.js:22` 传 `"<appDir>"`。
- `unregisterAssociation`（`assoc.js:58-66`）：删 `OpenWithProgids` 里的值 → 删整个 `ApkStart.apk` 子树 → **无条件**把 `.apk` 默认值置空 → 通知 shell。

### 坑点与不变量
1. **★★ 注释与实现不一致（真缺陷）**：`assoc.js:62` 写着「仅当 .apk 仍指向我们自己时才清掉默认值」，但 `assoc.js:63` 是 `reg(['add', ...EXT, '/ve', '/d', '', '/f'])` **无任何条件**。后果：用户原本把 `.apk` 关联到别的解包工具（或系统默认「未知类型」），取消关联后默认值被清空，原关联丢失且没有备份/恢复。修法：先 `reg query` 读当前默认值，等于 `PROGID` 才清。
2. **返回值没有信息量**：`registerAssociation` 恒返回 `ok:true`，`main.js:1315` 的 IPC 因此无法区分「成功」和「全部被策略拦截」。UI 若要做成功提示是假的。
3. **`notifyShell` 依赖 PowerShell + `Add-Type`**：无 PowerShell/受限策略的机器上静默失败，关联不刷新（需要用户重新登录或手动刷新）。`timeout: 8000` 是同步阻塞主进程的，最坏卡 8 秒。
4. **`extraArgs` 的引号责任在调用方**（`assoc.js:43`），传入含空格但没引号的路径会拼出错误命令行。
5. 只写 HKCU，不碰 HKLM —— 这是「不需要管理员」的关键，也意味着**多用户下每个用户都要各自注册**。
6. `PROGID` 是写死的 `'ApkStart.apk'`，与 `EXT='.apk'` 一起构成注册表契约；改名会导致旧版本注册的残留项无法被 `unregisterAssociation` 清掉（它只删 `PROGID` 这一棵）。

### 被谁调用
- `registerAssociation`：`src/main.js:30`（require）、`main.js:1315`（IPC `assoc:register`）；`scripts/assoc.js:10`、`21`
- `unregisterAssociation`：`main.js:1318`（IPC `assoc:unregister`）、`main.js:1351`（卸载流程里 `try/catch`）；`scripts/assoc.js:26`
- `PROGID`：`main.js:1297`（`assoc:status` 用 `reg query` 输出里是否含它判断已关联）
- UI：`src/ui/app.js:754-755` 只消费 `assoc:status` 的 `registered` 字段

### 测试覆盖
**无。** `grep -r assoc test/` 零命中，`auto-test.js` / `engine-test.js` / `run-tests.js` 都没有注册表用例（因为会改状态）。`scripts/assoc.js` 是手动开关。这是全组里唯一「完全没有自动化验证」的模块。

---

## 8. `src/core/version.js`

### 职责
版本号比较。独立成小模块，**为了避免 `updater` ↔ `sources` 循环依赖**（`version.js:3` 注释）。

### 对外接口
```js
const { parseVer, cmpVer } = require('./version');

parseVer(v)     // → Array<number|string>：去 'v' 前缀，按 [.+-] 切，纯数字段转 Number，过滤空段
cmpVer(a, b)    // → 1 (a>b) | -1 (a<b) | 0 (相等)
```

### 内部关键实现
- `parseVer`（`version.js:7-13`）：`String(v||'')` → `replace(/^v/i,'')` → `split(/[.+-]/)` → 数字段转 `Number`，非数字段保留字符串 → `.filter(x => x !== '')`。
  - `'v0.3.2'` → `[0,3,2]`；`'0.3.2-preview'` → `[0,3,2,'preview']`；`'1.0.0+build'` → `[1,0,0,'build']`。
- `cmpVer`（`version.js:16-34`）：取较长者长度逐段比；**一方先耗尽 → 短的更小**（`23-24`）；两边都是 number 走数值比，否则 `String()` 字典序（`25-31`）。

### 坑点与不变量
1. **`cmpVer('1.0','1.0.0') === -1`，不是 0**（`23-24` 的语义）。用于 `updater.hasUpdate`（`updater.js:109`）时，「当前 1.0 / 远端 1.0.0」会判定为有更新——目前版本号始终三段，未触发，但**不要用它做「相等」判断**。
2. **不是 semver**：预发布段按字符串比 → `'preview' > 'beta'`（字典序），`'rc1' > 'rc'`；`1.0.0+build` 会因多一段而**大于** `1.0.0`（semver 里 build metadata 应被忽略）。对「GitHub/Gitee release tag 排序」这个用途足够。
3. 数字段用 `Number()`，所以 `'01'` 和 `'1'` 相等；`'1.10' > '1.9'` 正确（数值比）。
4. 空串 / `null` → `[]`，与任何非空版本比都是 `-1`。
5. 模块刻意零依赖（只 export 两个纯函数），任何一方想加依赖都会重新引入循环。

### 被谁调用
- `cmpVer`：
  - `src/core/provision.js:17`（require）、`513`（`cands.sort((a,b) => cmpVer(b.tag, a.tag))`，挑镜像版本）
  - `src/core/sources.js:20`（require）、`299`（release 列表按 tag 降序）
  - `src/core/updater.js:22`（require）、`109`（`hasUpdate: cmpVer(merged.tag, this.current) > 0`）、`333`（**再导出** `cmpVer`，所以 `updater.js` 的消费者可以绕开 version.js）
- `parseVer`：仅 `version.js:17-18`（`cmpVer` 内部）
- 测试：`test/auto-test.js:821` 从 `../src/core/updater` 引入（走 re-export），不是直接引 `version.js`

### 测试覆盖
- `test/auto-test.js:820` 「版本比较按数字逐段比，v 前缀 / 多段都正确」——4 条断言：`v0.3.2 > 0.3.1`、`v` 前缀相等、`0.10.0 > 0.9.9`（防字符串比）、`1.0.0 < 1.0.1`。
- 缺口：`1.0` vs `1.0.0`、预发布段、`+build`、空值都没有用例。

---

## 9. `src/core/logfile.js`

### 职责
轻量日志追加 + 按大小滚动（只保留一份 `.1.log` 备份），防止 `app.log` / `emulator.log` 无限增长吃磁盘。

### 对外接口
```js
const { append, rotate, trimNow } = require('./logfile');

append(file, line, limitKB = 2048)   // → boolean（true=写入成功；任何异常 false，日志永不抛）
rotate(file, limitKB)                // → boolean（true=本次执行了滚动）
trimNow(file, limitKB = 2048)        // → boolean（= rotate，但绕过计数器；★ src 里无调用者）
```

### 内部关键实现
- 动机注释（`logfile.js:4-9`）：emulator 每次开机内核日志几十 KB，一天开关十几次 + qemu verbose → 几个月几百 MB。
- `counters = new Map()`（`13`）：**进程内**按文件路径计数，跨进程不共享。
- `rotate(file, limitKB)`（`15-26`）：
  - `statSync` 失败（文件不存在）→ catch 返回 false（`23-25`）
  - `size < limitKB*1024` → false（`18`），即**只有超过上限才滚**
  - 备份名：`file.replace(/\.log$/i, '.1.log')`（`19`）；先 `rmSync(bak,{force:true})` 再 `renameSync(file,bak)` → 永远只留一份备份
- `append(file, line, limitKB)`（`33-45`）：
  - `mkdirSync(dirname, {recursive:true})`（`35`，即使写日志也保证目录存在）
  - 计数器 +1；**`n===1`（进程内第一次）或 `n%200===0` 时**才 `rotate`（`39`，注释 `38`：`statSync` 很便宜但没必要每行做）
  - `appendFileSync(file, line.endsWith('\n') ? line : line+'\n')`（`40`，自动补换行）
  - 下限钳制：`Math.max(256, Number(limitKB) || 2048)`（`39` / `49`）——上限最小 256KB
  - 整个函数包在 try/catch，失败返回 false（`41-44`）

### 坑点与不变量
1. **★ 文件名不以 `.log` 结尾时会丢日志**：`bak === file`，于是 `rmSync(bak)` 把文件删掉，`renameSync` 因源不存在失败（ENOENT）→ 返回 false，**原日志已被删除**。当前两处调用都传 `*.log`（`app.log`、`emulator.log`），所以没炸；任何新增调用必须遵守「文件名以 .log 结尾」这个隐式契约。
2. **滚动发生在 append 之前**（`39` 在 `40` 之前）：滚动后立刻写新文件，日志连续，不会出现「滚完这一行丢了」。
3. **计数器是进程级的**：主进程重启后从 1 重新计数 → 每次启动必做一次 `statSync`，行为正确（也意味着**长时间不重启**时最多漏检 199 行）。
4. **多写者无锁**：主进程和（未来的）子进程若写同一文件，`rotate` 有竞态（A 删 bak、B 也删、A rename 成功、B rename 失败 → B 的日志写进新文件，其实可接受）。
5. **`limitKB` 语义是「滚动阈值」不是「硬上限」**：单次 append 的 `line` 可以任意长（emulator 一次写几十 KB 的启动输出），滚动后文件仍可能远超阈值，直到下一次检查。
6. **`trimNow` 是死代码**（`48-50`，全项目零调用）：原本给「启动时先清理」用，实际 `append` 的 `n===1` 分支已经覆盖。
7. 调用方传的 `limitKB` 并不统一：`main.js:84` 用 `settings.engine.logLimitKB`；`emulator.js:576` 用 `logLimitKB * 4`（并再 `Math.max(2048, ...)`）——同一设置项在两处被放大 4 倍，读设置页数字时要记得这一点。

### 被谁调用
- `append`：
  - `src/main.js:85`（`appLog()`，`limit = store.getSettings().engine.logLimitKB || 2048`，见 `main.js:84`）
  - `src/core/emulator.js:577`（`_logWrite()`，`limit = max(2048, logLimitKB*4)`，见 `emulator.js:576`）
  - 注意两处都是**函数内 `require('./logfile')`**（延迟加载），不是模块顶部
- `rotate`：`logfile.js:39`（自身）、`test/auto-test.js:1408`
- `trimNow`：无
- 测试：`test/auto-test.js:1405`

### 测试覆盖
- `test/auto-test.js:1404` 「日志超过上限自动滚动，只保留一份备份」——写 300KB、`rotate(f,256)`、断言文件变成 `rot.1.log`。
- 缺口：`append` 的计数/自动滚动路径（`n===1`、`n%200`）没有用例；`trimNow` 没有；非 `.log` 文件名的丢数据路径没有。

---

## 10. 附：`src/core/display.js`（同属纯工具小模块）

虽然不属于解析链，但它是 `src/core` 里另一个「零依赖纯计算、可单测」的小模块，接盘时值得知道。

- **职责**：显示适配的纯计算（不依赖 Electron/adb），全屏/窗口的窗口矩形与 Android 分辨率（`display.js:2-6`）。
- **接口**：`densityFor(w,h,manual)` → number（manual>0 时 clamp 120..640，否则 `min(w,h)/2.57` clamp 200..480，`7-10`）；`portraitSize(str)` → `{w,h}`（正则 `^(\d{3,4})x(\d{3,4})$`，非竖屏/越界回落 `900x1600`，`12-18`）；`defaultBounds(area)` → `{x,y,w,h}`（高 84%、宽 = 高·9/16、居中，`20-28`）；`fullscreenBounds(portrait,area)`（铺满高度、按竖屏比例算宽、水平居中，`36-46`）；`sizeFor(mode,portrait,area)`（`55-57`）。
- **关键坑点**：`sizeFor` **完全忽略 `mode` 参数**（`55-57`，永远返回竖屏预设）。这不是 bug：注释（`48-54`）说明模拟器窗口宽高比在开机时被 LCD 锁定，改 Android 分辨率会让画面变形；「全屏」只是把窗口最大化。
- **被谁调用**：`src/main.js:32`（require）、`main.js:276`（`display.portraitSize(d.portrait || '540x960')`）；测试 `test/auto-test.js:465`。
- **测试**：`auto-test.js:465` 「显示适配：窗口/全屏共用竖屏分辨率，窗口比例 9:16 可拉伸」，覆盖 `sizeFor`/`defaultBounds`/`fullscreenBounds`/`densityFor`。

---

# 11. 离线解析栈总览

## 11.1 入口与调用链

**四个入口**
| 入口 | 链路 |
|---|---|
| UI 预览解析 | `ui/app.js` → `preload.js:10` `parseApk` → `main.js:756` `apk:parse` → `parseApk` |
| UI 安装（实际主路径） | `ui/app.js:484` `api.installApk` → `main.js:758` `apk:install` → `installer.install`（`installer.js:141`）→ `parseApk`（`149`）或 `parseBundle`（`146`） |
| 双击 .apk（文件关联） | `assoc.js` 写的 `command` → `apkstart.exe "%1"` → `main.js:206` `parseArgs` 识别 `.apk` → 安装流程 |
| 命令行自检 | `scripts/selftest.js:142` → `parseApk` |

**从 `parseApk(filePath)` 开始的文字版调用链**

```
parseApk(filePath)                                   apk.js:75
├─ fs.statSync(filePath)                            apk.js:76   → sizeBytes
├─ fs.readFileSync(filePath)                        apk.js:78   ← 【整包进内存】
├─ new ZipArchive(buf)                              apk.js:79   → zip.js:13
│  ├─ _parse()                                      zip.js:20
│  │  ├─ 尾部倒扫 EOCD（窗口 65557B）               zip.js:23-26
│  │  ├─ total@+10 / cdOffset@+16                   zip.js:29-30
│  │  └─ 中央目录循环 → entries(Map)                zip.js:32-47
│  ├─ has('AndroidManifest.xml')                    apk.js:81   （无 → 抛「可能是 .apks/.xapk」）
│  ├─ read('AndroidManifest.xml')                   apk.js:85   → zip.js:54（inflateRawSync）
│  └─ （兜底图标时才 read 图片）                    apk.js:43
├─ parseAxml(manifestBuf)                           apk.js:86   → axml.js:67
│  ├─ readStringPool（UTF-8/UTF-16 双分支）         axml.js:88  → 26
│  ├─ START_ELEMENT + attr×N（20B/个，基准 +16）    axml.js:98-140
│  └─ 返回 manifest 节点                            axml.js:147
├─ attrValue(manifest,'package', ns=null)           apk.js:88
├─ new ResTable(zip.read('resources.arsc'))         apk.js:104  → arsc.js:79（try/catch，失败→null）
│  ├─ 全局字符串池（只取第一个）                    arsc.js:99-100
│  ├─ packages[].types: Map<typeId, config[]>       arsc.js:101-103 / 141
│  └─ resolve(ref, 'string'|'file')                 arsc.js:200 → score() 选 config
│     ├─ label：  resolve(labelRef,'string')        apk.js:111
│     ├─ icon：   resolve(iconRef,'file')           apk.js:141
│     └─ 自适应：iconFromAdaptiveXml → parseAxml → resolve → zip.read   apk.js:51-73
├─ isLauncherActivity(activity|activity-alias)      apk.js:122 → 15
├─ !icon → pickIconFromZip(zip)                     apk.js:152 → 27（名字+uncompSize 打分）
├─ abis = zip.names() 里 lib/<abi>/ 去重           apk.js:155
└─ return { package,label,versionName,versionCode,minSdk,targetSdk,
            launchActivity,abis,iconPng,iconFile }  apk.js:160-174

──────────────────── installer 侧（元信息 → 图标 → ICO → .lnk） ────────────────────

installer.finishInstall(rt, meta, ...)               installer.js:179
├─ store.iconPath(pkg) → <ICON_DIR>/<pkg>.png 写盘    installer.js:208-209（内容可能是 WebP！）
├─ iconToIco(meta.iconPng, {decode: ctx.decodeIcon}) installer.js:212 → shortcut.js:109
│  ├─ ① nativeImage.createFromBuffer → pngToIco     shortcut.js:112-116 → 39
│  │     └─ resize ×9(16..256) → buildDib → ICONDIR  shortcut.js:13 / 45-72
│  ├─ ② decodeIcon(raw)（隐藏 BrowserWindow+canvas） main.js:213-229
│  │     └─ canvas.toDataURL('image/png') → pngBytesToIco  shortcut.js:83
│  └─ ③ drawAppIcon(256) → pngBytesToIco            shortcut.js:127-129 → png.js:80
├─ 写 <ICON_DIR>/<pkg>.ico                           installer.js:214-215
├─ store.upsertApp(app)                              installer.js:259
└─ createShortcut(app)                               installer.js:265 / 286
   ├─ safeFileName(label) → 桌面 / 开始菜单两个路径   installer.js:75 / 88
   └─ writeShortcut({target,args,iconIcoPath,...})   installer.js:292 → shortcut.js:144
      └─ shell.writeShortcutLink + fs.existsSync 回读 shortcut.js:155-167
```

## 11.2 内存与耗时画像

| 阶段 | 数据形态 | 峰值开销 |
|---|---|---|
| `readFileSync`（`apk.js:78`） | 整个 APK 的 Buffer | ≈ 文件大小（500MB APK → 500MB） |
| `ZipArchive._parse` | 中央目录元信息 `Map` | 每条目 ~100B；1 万条目 ≈ 1MB |
| `zip.read(manifest)` | inflate 结果 | Manifest 通常几十 KB |
| `zip.read(resources.arsc)` | inflate 结果 | 几 MB（大厂 App 可 10MB+） |
| `ResTable._parse` | `packages[].types` 的 Map 树 | 与资源条数成正比，百 MB 级 App 约数 MB~十几 MB |
| `zip.read(icon)` | 图标原始字节 | 通常 < 1MB（xxxhdpi webp 几十 KB） |
| 全程 | 旧 Buffer 不会被回收（`zip.buf` 持有） | **解析结束前 APK 全量常驻** |

耗时：正常 APK（50MB 级）≈ 100–300ms，主要花在 `inflateRawSync(resources.arsc)` 和 `ResTable` 的 entry 遍历；`drawAppIcon(256)` 约 10ms 量级（且 `main.js:175` 启动时只算一次缓存）。

## 11.3 最脆弱、最值得重构的地方（按「收益/风险」排序）

1. **`parseApk` 整包读内存（`apk.js:78`）——最该先改**
   现有 `ZipFile` 已经能只读中央目录 + 按需流式读条目，`provision.js:594-595` 就是「>64MB 用 ZipFile」的先例。把 `parseApk` 改成 `new ZipFile(filePath)` 只读 `AndroidManifest.xml` / `resources.arsc` / 图标三样，峰值内存从「文件大小」降到「几 MB」，顺带绕过 2GB Buffer 上限。改动局限在 `apk.js:75-175` + 一个 `finally close()`，`installer.parseBundle` 里也照抄即可（它现在 `installer.js:27` 也是整包 `readFileSync`）。
   注意 `zip.read` 在两个类上的空值语义不同（`ZipArchive` 返回 null / `ZipFile` 抛错），替换时要补 `has()` 判断。

2. **没有 Zip64（`zip.js:29-30`、`37`、`161-162`、`180`）**
   条目数 >65535、或单条目 >4GiB、或 EOCD 里 `cdOffset === 0xffffffff` 时：
   - `ZipArchive`：`zip.js:30` 拿到 `offset = 0xffffffff`，随后 `zip.js:33` 的 `readUInt32LE(offset)` 直接 `RangeError` 冒泡出构造函数（错误信息与「不是有效 ZIP」无关，排查困难）；
   - `ZipFile`：`cdOffset > eocdAbs` 命中 `zip.js:166-169`，`len` 变负 → 抛「ZIP 中央目录偏移异常」；`total === 0xffff` 时只解析前 65535 条，多余条目**静默丢失**。
   APK 本身很少 >4GB，但**系统镜像/更新包**（`provision.js` / `updater.js` 用同一套代码）迟早会撞上。修法：EOCD 里发现 `0xffff/0xffffffff` 时定位 Zip64 EOCD（`0x06064b50`）与 Zip64 locator（`0x07064b50`），把 `compSize/uncompSize/localOffset/cdOffset/total` 换成 u64（用 `readBigUInt64LE` 再转 Number，注意 2^53 精度）。

3. **WebP 解码依赖 Electron 的隐藏窗口（`main.js:213-229` + `shortcut.js:120-126`）**
   APK 图标大量是 WebP，`nativeImage` 解不了，只能开一个 `BrowserWindow` + `canvas` + base64（`raw.toString('base64')` 让内存瞬时 ×1.33，再叠加 data URL 字符串）。三个问题：
   - 无 GUI / headless / 无 Electron（纯 Node 的 `selftest`、测试）时**静默降级为品牌占位图**，用户看到的是绿色三角而不是真图标；
   - `executeJavaScript` 的错误没有细分，WebP 解码失败和窗口创建失败都是同一个「没图标」；
   - 每次调用都走一遍 IPC 式往返，批量安装时是明显的串行瓶颈。
   建议：内置一个最小 WebP 解码（或至少在 `iconToIco` 里把「占位图」和「真实解码失败」区分开，把原因透出到 `installer` 的 warnings，UI 才能提示「图标无法解析」）。

4. **图标抽取的格式白名单太窄（`apk.js:29`、`apk.js:67`）**
   只认 `.png`/`.webp`。导致：`.jpg`/`.jpeg` 图标、`<adaptive-icon>` 里的 `<inset>`/`<layer-list>`/`<bitmap>` 组合、`drawable` 里的 shape 资源全部落到 `pickIconFromZip` 的启发式兜底，可能抽到启动图/背景图（评分只看 `uncompSize` 和文件名）。建议：候选加 `jpe?g`；对 XML 递归一层取第一个 `<bitmap android:src>`；评分改用 PNG/WebP 头解析出的真实像素尺寸（`png.js` 没有解码器，但读 IHDR/VP8 头是十几行的事）。

5. **`arsc.js` 的 config 选择是启发式（`arsc.js:65-77`）**
   `anydpi` 罚 500、`language` 罚 40、`sdkVersion/1000` 都是拍出来的常数；不做 locale 匹配（中文应用可能拿到英文名），不做「按屏幕密度」的精确匹配。并且三种 entry 编码（sparse / offset16 / u32）**没有任何测试**——一旦某个 Android 工具链版本换了编码，表现是「所有图标和名字突然变默认值」，但不会报错（`apk.js:103-105` 的 try/catch 会把它吞成 `res=null`）。
   建议：给 `ResTable` 加合成字节用例，并把 `score()` 的常数提到显式配置里。

6. **`attributeStart` 的相对基准没有任何防线（`axml.js:105-106`）**
   全链最容易被「顺手重构」改坏的一行，且改坏后**不报错、只错位**。建议加一个手写的 20 行最小 AXML 字节用例（string pool + 一个 start element + 两个属性），断言 `attr()` 能取到 `package` 和 `android:label`。

7. **`assoc.unregisterAssociation` 无条件清空 `.apk` 默认值（`assoc.js:62-63`）**
   注释承诺的保护不存在，会抹掉用户原有 `.apk` 关联；且整个模块零测试。修法见第 7 节坑点 1。

8. **`logfile.rotate` 对非 `*.log` 文件名会先删后 rename（`logfile.js:19-21`）**
   一个 `bak === file` 的边界就足以丢日志；建议加 `if (bak === file) return false;` 的显式守卫。

9. **两份字符串池解析代码重复（`axml.js:26` / `arsc.js:23`）**
   逻辑完全相同（含 UTF-8 的两个 varint 长度这个易错点）。建议抽到 `src/core/respool.js`，一处修两处生效。

10. **散落的死代码/无用导出**（清理成本低，但会误导新接手的人）
    `quickCheck`（`apk.js:178`，仅测试用）、`trimNow`（`logfile.js:48`，零调用）、`TYPE_REFERENCE` 导出（`arsc.js:233`）、`ICO_SIZES` 导出（`shortcut.js:182`）、`ANDROID_NS` 未使用导入（`apk.js:9`）、`apk.js:38` 的 noop、`shortcut.js:46-48` 两支相同的三元、`arsc.js:92` 读了不用的 `pkgCount`、`apk:parse` IPC 无 UI 消费者（`main.js:756` + `preload.js:10`）。

## 11.4 测试缺口清单（按风险）

`npm test` 实际执行 `node test/run-tests.js && node test/engine-test.js && node test/auto-test.js`（`package.json:37`），**`test/electron-integration.js` 不在其中**（要手动 `electron test/electron-integration.js`）。

| 缺口 | 影响 |
|---|---|
| AXML / ARSC 无合成字节用例，真实 APK 夹具缺失时整段跳过（`run-tests.js:130-132`） | CI 上 `axml.js`/`arsc.js`/`apk.js` 等于零覆盖 |
| `arsc.resolve()` 没有任何断言 | 三种 entry 编码 + config 打分全裸奔 |
| `.apks` / `.xapk`（`installer.parseBundle`）无用例 | 拆分包路径完全靠人肉验证 |
| `assoc.js` 零覆盖 | 注册表写错/删错无人知 |
| `pngToIco` / `writeShortcut` 只在 Electron 集成里「能跑通」，不入 `npm test` | `npm test` 绿了不代表 ICO/.lnk 能用 |
| `logfile.append` 的自动滚动路径未测 | 只测了直接调 `rotate` |
| `safeFileName` / `cmpVer` 边界未测 | 非法文件名、`1.0` vs `1.0.0` |
| 无 Zip64 / 超大条目 / 中央目录截断的负例 | 大文件问题只能线上复现 |

---

*本文档为 WIP：行号基于 0.3.4 快照，改动相关文件后请同步更新。*
