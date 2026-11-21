'use strict';
/**
 * 在线更新：从 GitHub Releases（RoutineMiku/apkstart）取最新版本，下载并原地替换。
 *
 * 三个形态都要照顾到：
 *   - 安装版（NSIS）：下载 `ApkStart-x.y.z-Setup.exe`，静默安装（/S）；
 *   - 轻量版（便携 zip，运行时按需下载）：下载 `ApkStart-vX-win64-portable.zip`，
 *     解压后覆盖程序目录 —— 运行时目录（%APPDATA%\apkstart\runtime）与已装应用、
 *     快照全都在用户目录里，替换程序文件不会动它们；
 *   - 完整版（便携但带 runtime）：同轻量版，只是目录里多了 resources\runtime。
 *
 * 替换不能在本进程里做（exe 正被占用），所以生成一段 PowerShell 脚本交给独立进程：
 * 等本进程退出 → 复制文件 → 重新拉起。
 * [-EncodedCommand 长度] 脚本已增长到 UTF-16LE base64 后接近 Windows 32767 字符
 * 命令行上限，且真实安装/数据路径还会更长。因此生产调度改为：把带 UTF-8 BOM 的
 * 完整脚本写入 update 目录下的唯一文件，命令行只传一段很短的 bootstrap；
 * bootstrap 一次性读入字节、校验 SHA-256、从同一份字节解析并执行，避免
 * 「命令行过长」和「写完后被替换再读」两个问题。
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { downloadAny, downloadAnyParallel, downloadMulti, sha256File } = require('./download');
const { ZipFile, resolveZipEntry } = require('./zip');
const { cmpVer } = require('./version');
const { Sources } = require('./sources');
const inc = require('./incremental');

const OWNER = 'RoutineMiku';
const REPO = 'apkstart';

/** PowerShell 单引号字符串：内部的 ' 要写成 '' */
function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** 在目录第一层里按名字（大小写不敏感）找文件，返回实际名字或 null */
function findInDir(dir, name) {
  try {
    const lower = name.toLowerCase();
    return fs.readdirSync(dir).find((n) => n.toLowerCase() === lower) || null;
  } catch (_) {
    return null;
  }
}

/**
 * [R4] 保守的资产名边界检查。资产名可能来自官方元数据（可信但不免役）或本地
 * marker（本地可写、不可信），无论来源，进入路径拼接前都必须通过：
 * 不含路径分隔符/空字节、不含 `..`、长度有界、首个字符为字母数字或点。
 */
function saneAssetName(n) {
  return typeof n === 'string' && n.length >= 1 && n.length <= 200
    && !/[\\/\u0000]/.test(n)
    && !n.includes('..')
    && /^[\w.][\w.\- ]*$/.test(n)
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(n);
}

/** [R4] 版本目录名边界检查：resume 扫描 update/<v>/ 时防止畸形/穿越目录名。 */
function saneVersionDir(n) {
  return typeof n === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n)
    && !n.includes('..')
    // Windows 会剥掉结尾的点/空格（"9.9.9." 实际落盘成 "9.9.9"），设备名保留字一并拒收
    && !/[. ]$/.test(n)
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(n);
}

/** [R4-fix] staging/备份目录的唯一后缀；碰撞由 mkdir/rename 自身失败兜底。 */
function uniqueSuffix() {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 生产调度 bootstrap：命令行只带脚本文件路径与 SHA-256，长度与脚本体量无关。
 * 字节只读一次，先校验摘要再从同一份 Buffer 解码执行 —— 读完到执行之间没有
 * 第二次按路径读取，外部替换文件无法绕过校验。UTF-8 BOM 在解码后剥掉。
 */
function buildApplyBootstrap(helperFile, digest) {
  return [
    `$p = ${psq(helperFile)}`,
    `$h = '${digest}'`,
    `$b = [System.IO.File]::ReadAllBytes($p)`,
    `$sha = [System.Security.Cryptography.SHA256]::Create()`,
    `try { $d = [System.BitConverter]::ToString($sha.ComputeHash($b)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }`,
    `if ($d -ne $h) { throw 'update helper digest mismatch: refusing to execute' }`,
    `try { [System.IO.File]::Delete($p) } catch { }`,
    `$t = [System.Text.Encoding]::UTF8.GetString($b)`,
    `if ($t.Length -gt 0 -and [int]$t[0] -eq 0xFEFF) { $t = $t.Substring(1) }`,
    `& ([scriptblock]::Create($t))`,
  ].join('\r\n');
}

/**
 * [T-WEB-002] Windows 上「刚写完就 rename 目录」偶发 EPERM/EBUSY：解压流在
 * 'finish'（已 flush 到 OS）而不是 'close'（fd 已关闭）时就 resolve，紧随其后的
 * rename 可能撞上尚未关闭的句柄，杀软/索引器扫描新文件也会短暂占用。旧代码
 * 一次失败就抛错 —— prepare 退完整包、续做返回 null，用户看到「更新没续上」。
 * 有界重试（约 200ms 内 5 次）只消化这类瞬时占用；持续占用仍如实抛错，
 * 「失败保留旧载荷/归档」的语义不变。
 */
async function renameWithRetry(from, to, attempts = 5) {
  for (let i = 1; ; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= attempts) throw e;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20 * i));
    }
  }
}

/**
 * [R4-fix] 残留 staging/备份目录清扫：只匹配本更新器自己的 payload.* 临时名
 * （payload.rebuild / payload.staging-* / payload.old-*），绝不碰归档与载荷。
 * lstat 先行：链接形态只 unlink 链接本身，绝不递归进链接目标。
 */
function sweepStaleStaging(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  for (const n of names) {
    if (!/^payload\.(?:rebuild|staging-|old-)/.test(n)) continue;
    try {
      const st = fs.lstatSync(path.join(dir, n));
      if (st.isSymbolicLink()) { fs.unlinkSync(path.join(dir, n)); continue; }
      fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    } catch (_) { /* 清不掉就留着，不阻断主流程 */ }
  }
}

/**
 * [R4-fix] 校验 update/<v> 是「真目录」：非符号链接/junction、非文件，且
 * realpath 恰好等于 update 根下的该名字。junction 会把后续 rm/extract/写入
 * 重定向到更新根之外（root 审查 R4-B01 实锤），这里直接判否，调用方 fail
 * closed 且不做任何清理动作。
 * @returns {string|null} 通过时返回该目录路径
 */
function realVersionDir(updateDir, v) {
  if (!saneVersionDir(v)) return null;
  const p = path.join(updateDir, v);
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    if (fs.realpathSync(p) !== path.join(fs.realpathSync(updateDir), v)) return null;
  } catch (_) { return null; }
  return p;
}

/**
 * [R4-fix] 载荷落点被符号链接/junction 占用时，只摘除链接本身（绝不递归进
 * 目标目录 —— 目标可能是更新根之外的用户数据），让随后的重建走真实路径。
 * 目录占用原样返回 false，交回调用方 fail closed。
 * @returns {boolean} true = 落点是空位/链接已摘除，可安全重建
 */
function clearPayloadOccupant(payload) {
  let st = null;
  try { st = fs.lstatSync(payload); } catch (_) { return true; /* ENOENT：空位 */ }
  if (st.isSymbolicLink()) {
    try { fs.unlinkSync(payload); return true; } catch (_) { return false; }
  }
  return true; // 真目录/文件占用由 _rebuildPayloadFromArchive 的 rename 备份流程接管
}

/**
 * 在程序目录里找 NSIS 卸载器，找不到返回 null。
 * electron-builder 的默认命名是 `Uninstall <productName>.exe`（updater.flavor 认这个），
 * 老版本/自定义打包也可能叫 `uninstaller.exe`（main.js 旧代码只认这个）。
 * 两处必须用同一套规则，否则安装版点「一键卸载」会被误判成便携版（issue #51）。
 */
function findUninstaller(installDir) {
  try {
    const names = fs.readdirSync(installDir);
    return names.find((n) => /^Uninstall .*\.exe$/i.test(n))
      || names.find((n) => /^uninstall(er)?\.exe$/i.test(n))
      || null;
  } catch (_) {
    return null;
  }
}

class Updater {
  /**
   * @param {{currentVersion:string, exePath:string, isPackaged:boolean, dataDir:string,
   *          electronVersion?:string, onProgress?:Function}} o
   */
  constructor(o) {
    this.current = o.currentVersion || '0.0.0';
    this.exePath = o.exePath;
    this.installDir = path.dirname(o.exePath || '');
    this.isPackaged = !!o.isPackaged;
    this.dataDir = o.dataDir;
    this.onProgress = o.onProgress || (() => {});
    // 增量更新的前提：本机 Electron 版本与发版时一致（外壳 ABI 没变）。
    // Electron 运行时由调用方（main.js）传 process.versions.electron；测试里可注入。
    this.electronVersion = o.electronVersion || '';
    this.settings = typeof o.settings === 'function' ? o.settings : () => (o.settings || {});
    // settings() 给 sources 用：决定「走 GitHub 还是 Gitee」「有没有镜像前缀」
    this.sources = new Sources(this.settings);
    this.latest = null;
    this._last = null;
  }

  /** 安装形态：安装版（有卸载器）还是便携包 */
  get flavor() {
    return findUninstaller(this.installDir) ? 'setup' : 'portable';
  }

  get updateDir() {
    return path.join(this.dataDir, 'update');
  }

  /**
   * 检查更新：GitHub / Gitee 并发问，取版本号更高的，资产取并集。
   * 具体下载地址在 prepare() 里再做一次真实测速排序。
   */
  /**
   * @param {{force?:boolean}} [opts] force=true 时跳过 10 分钟的版本缓存
   *        （用户主动点「检查更新」应该拿到最新结果；启动时的静默检查走缓存）
   */
  async check(opts = {}) {
    const merged = await this.sources.latest({ force: !!opts.force });
    const pick = (re) => merged.assets.find((a) => re.test(String(a.name || '')));
    // 发行版里同时挂着「便携包」和「运行时整包」（ApkStart-runtime-*.zip）。
    // 兜底的 .zip 匹配必须把运行时整包排除掉：某次发布如果只有运行时整包、
    // 没有便携包，旧逻辑会把它当更新包解压进程序目录（多出 1.5GB 文件、程序也被换坏）。
    const isRuntimePack = (a) => inc.isAuxAsset((a && a.name) || '');

    const wantSetup = this.flavor === 'setup';
    const asset = wantSetup
      ? (pick(/Setup\.exe$/i) || merged.assets.find((a) => /\.exe$/i.test(a.name) && !isRuntimePack(a)))
      : (pick(/portable.*\.zip$/i) || pick(/win64.*\.zip$/i)
        || merged.assets.find((a) => /\.zip$/i.test(a.name) && !isRuntimePack(a)));

    // 增量资产：清单 + 代码包。两者都在、且本机 Electron 版本对得上时才可能走增量；
    // 完整包始终作为兜底留在 asset 里——增量任何一步出问题都能无缝退回整包。
    const manifestAsset = pick(inc.MANIFEST_RE);
    const appAsset = pick(inc.APP_PACK_RE);

    this.latest = {
      version: merged.version,
      tag: merged.tag,
      name: merged.name,
      notes: merged.notes,
      htmlUrl: merged.htmlUrl,
      publishedAt: merged.publishedAt,
      // 注意带上 parts：Gitee 的分片包没有单一 url，丢掉 parts 就变成「有资产但没地址」
      asset: asset
        ? {
          name: asset.name,
          size: asset.size,
          url: asset.url,
          // 同名资产在 GitHub / Gitee 都有：两个地址都带着，prepare() 里测速择快。
          // sizes 是「每个地址各自的大小」——两个源压出来的字节数并不相同。
          urls: asset.urls,
          sizes: asset.sizes,
          source: asset.source,
          parts: asset.parts,
          partial: asset.partial,
          // [PR3] 官方 GitHub 身份锚，从 merged asset 原样透传（null 保真）。
          digest: asset.digest,
          digestUrl: asset.digestUrl,
        }
        : null,
      assets: merged.assets,
      // 两个源各自的最新版本 / 谁不可达，界面上可以如实显示「这次走的哪个源」
      sources: merged.sources,
      unreachable: merged.unreachable,
      flavor: this.flavor,
      hasUpdate: cmpVer(merged.tag, this.current) > 0,
      current: this.current,
      canAutoApply: !!asset && (!!asset.url || !!(asset.parts && asset.parts.length)),
      // 是否有可能走增量：prepare() 会下载清单解析后再做最终判定（版本/哈希）
      incremental: this.flavor === 'portable' && !!manifestAsset && !!appAsset
        ? { manifest: manifestAsset, app: appAsset }
        : null,
    };
    this._last = this.latest;
    return this.latest;
  }

  /**
   * 下载并准备好「载荷」：便携版解压到 update/<ver>/payload，安装版直接留 Setup.exe。
   * @returns {Promise<{mode:'zip'|'setup', payload:string, version:string}>}
   */
  async prepare(info) {
    const it = info || this.latest;
    if (!it || !it.asset) throw new Error('这个版本没有可自动安装的安装包，请到 GitHub 发布页手动下载');
    // [R4-fix] 版本号与资产名在任何落盘动作（mkdir/下载/解压）之前先过边界检查：
    // 穿越分量、分隔符、保留名一律拒绝。此前这两个字段不检查，`../../x` 会把
    // 文件直接写出更新根（root 审查 R4-B02/R4-B03 实锤）。
    if (!saneVersionDir(it.version)) throw new Error(`更新版本号非法：${JSON.stringify(String(it.version))}`);
    if (!saneAssetName(it.asset.name)) throw new Error(`更新包文件名非法：${JSON.stringify(String(it.asset.name))}`);
    const dir = path.join(this.updateDir, it.version);
    fs.mkdirSync(dir, { recursive: true });
    // [R4-fix] update/<v> 若是预先放置的 junction/symlink（或是个文件），上面
    // 的 mkdir 不会报错、随后的写入会被重定向出更新根 —— 必须在下载前验证。
    // 形状非法时只抛错，不做清理（不是我们创建的对象不动它）。
    const dirSt = fs.lstatSync(dir);
    if (!dirSt.isDirectory() || dirSt.isSymbolicLink()) throw new Error('更新目录形状非法（符号链接/文件），已中止本次更新');
    if (fs.realpathSync(dir) !== path.join(fs.realpathSync(this.updateDir), it.version)) {
      throw new Error('更新目录越界（重定向到更新根之外），已中止本次更新');
    }

    // 优先尝试增量：只下清单 + 代码包（几 MB），本机 Electron 版本一致、逐文件
    // 哈希都对得上才采用。任何一步不满足就当作没增量，无缝退回下面的完整包下载。
    // 上次增量替换失败过 → 这次直接走完整包，别再重放坏载荷（resumable 也认这个标记）
    const forcedFull = fs.existsSync(path.join(dir, '.apkstart-force-full'));
    if (it.incremental && it.hasUpdate !== false && !forcedFull) {
      try {
        const job = await this._prepareApp(it, dir);
        if (job) return job;
      } catch (e) {
        this.onProgress({
          stage: 'download', percent: 1,
          message: `增量更新不可用（${e.message}），改用完整包…`,
        });
      }
    }
    return this._prepareFull(it, dir);
  }

  /** 完整包路径：下载 portable zip / Setup.exe 并解压备好（原来的逻辑） */
  async _prepareFull(it, dir) {
    const file = path.join(dir, it.asset.name);
    // [R4-fix] 归档落点若被预先放成符号链接，写入会跟随链接逃出更新根；
    // 链接只 unlink 链接本身。目录等非文件占用则直接中止。
    let preSt = null;
    try { preSt = fs.lstatSync(file); } catch (_) { /* ENOENT：正常，落点尚不存在 */ }
    if (preSt && preSt.isSymbolicLink()) { try { fs.unlinkSync(file); } catch (_) { throw new Error('更新包落点是被链接占用的位置且无法清除，已中止本次更新'); } }
    else if (preSt && !preSt.isFile()) throw new Error('更新包落点被目录等非文件对象占用，已中止本次更新');
    let total = it.asset.size || 0;
    const conns = Math.max(1, Math.min(16, Number((this.settings().runtime || {}).downloadConnections) || 8));

    // [PR3] 锚定判定提到函数顶部：marker 身份化（zip 路径）也要用。
    const anchored = !it.asset.partial && !!it.asset.digest && !!it.asset.digestUrl;
    const out = path.join(dir, 'payload');
    // [R4-fix] issue98 重试效率门：锚定期望下先校验留存归档（上次 prepare 的
    // 下载产物）。SHA-256 == 官方 digest ⇒ 直接从归档重建载荷，不做测速/传输；
    // 旧 extracted 字节被改过也没关系 —— 重建从不信任旧载荷字节。归档缺失或
    // 字节不符才走正常验证下载。marker 字段不参与授权：身份只来自调用方独立
    // 提供的 info.asset.digest。
    if (anchored) {
      const cached = this._stagedArchivePath(it.version, it.asset.name);
      if (cached) {
        let cachedOk = false;
        try { cachedOk = (await sha256File(cached)) === it.asset.digest; } catch (_) { cachedOk = false; }
        if (cachedOk) {
          this.onProgress({ stage: 'download', percent: 100, message: '本地更新包校验通过（SHA-256 与官方一致），无需重新下载' });
          await this._rebuildPayloadFromArchive(cached, out, it.version, { digest: it.asset.digest, assetName: it.asset.name });
          this.onProgress({ stage: 'ready', percent: 100, message: '更新包已解压完成' });
          return { mode: 'zip', payload: out, version: it.version };
        }
        // [R4-fix] 坏归档必须真正重下：下载器对「同大小已存在文件」按续传/完整
        // 处理，坏字节留着只会每次都卡在终验失败。这里删除坏归档（lstat 已确认
        // 是本版本目录内的真实文件），让后面的验证下载从零落盘。
        try { fs.rmSync(cached, { force: true }); } catch (_) { /* 删不掉则下载/终验会如实报错 */ }
      }
    }
    // Gitee 附件单文件上限 100MB，所以发布时会把包切成 .part1/.part2。
    // 每个分片单独测速选源（可以一部分来自 Gitee、一部分来自 GitHub 镜像），
    // 下完按顺序拼回整包 —— 对用户来说仍然只是「下载 + 解压」。
    if (it.asset.parts && it.asset.parts.length) {
      await this._downloadParts(it.asset, file, conns, total);
    } else {
      this.onProgress({ stage: 'download', percent: 1, message: `正在下载 ${it.asset.name}…` });
      // 候选地址 = 源站 + 镜像前缀；先各下 256KB 实测速度，再拿最快的那个分块下载。
      // 这是「GitHub 直连几十 KB/s、镜像能跑几 MB/s」时唯一靠谱的选路方式：
      // 按域名猜没用，同一天不同时段差别很大。
      // [PR3] 锚定时只从 digest 绑定的 GH 直连 URL（+其镜像）取字节，排除 Gitee URL——
      // 异字节候选终验必然拒绝，白白浪费带宽。无锚逐字保持 PR2 的多源候选。
      const cands = anchored
        ? this.sources.candidates(it.asset.digestUrl)
        : this.sources.candidates(it.asset);
      const ranked = await this.sources.rank(cands, { onProgress: (p) => this.onProgress(p) }).catch(() => cands);
      // 进度用的总大小要取「真正在下那个源」的：GitHub 与 Gitee 的包不是同一份字节
      // （压缩器不同，能差好几 MB），拿错就会一直显示 92% 再突然跳到完成。
      const sizes = it.asset.sizes || {};
      for (const u of ranked) {
        if (sizes[u]) { total = sizes[u]; break; }
      }
      // downloadMulti：分块同时从「GitHub 直连」和「镜像」拉，带宽叠加；
      // 只有一个源可用或对方不支持 Range 时，它自己退回单源分块。
      await downloadMulti(ranked, file, {
        connections: conns,
        // [PR3] 锚定字节由 downloadMulti 终验；无锚保持 PR2 调用形状（不传该字段）。
        ...(anchored ? { expectSha256: it.asset.digest } : {}),
        onProgress: (pr) => {
          const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
          const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
          const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
          this.onProgress({
            stage: 'download',
            percent: Math.max(1, Math.min(99, pct)),
            message: `下载中 ${mb}${sp}`,
            speed: pr.speed,
          });
        },
      });
    }

    if (/\.zip$/i.test(file)) {
      // 无锚（Gitee/自定义/无 digest）保持 PR2 的 marker 复用语义，身份如实
      // 标注 UNVERIFIED，仅限用户主动发起的更新流程。锚定路径不走 marker 复用：
      // marker 与旧载荷都是本地可写文件，不能自证字节身份；刚通过 expectSha256
      // 终验（或缓存校验）的归档才是字节来源。
      if (!anchored && this._payloadReady(out, it.version, undefined)) {
        this.onProgress({ stage: 'ready', percent: 100, message: '已有下载好的更新包，直接复用' });
        return { mode: 'zip', payload: out, version: it.version };
      }
      // [R4-fix] 统一走「唯一 staging + 主 exe 校验 + 原子换名」重建：
      //  - 解压/校验失败时旧载荷与 marker 原样保留（留存缓存可继续续做）；
      //  - 不再就地 rm+mkdir+解压 —— 旧做法会把并发场景下已返回给启动续做
      //    调用方的载荷半途截断（root 审查 R4-C01 实锤）。
      await this._rebuildPayloadFromArchive(file, out, it.version,
        anchored ? { digest: it.asset.digest, assetName: it.asset.name } : undefined);
      this.onProgress({ stage: 'ready', percent: 100, message: '更新包已解压完成' });
      return { mode: 'zip', payload: out, version: it.version };
    }
    this.onProgress({ stage: 'ready', percent: 100, message: '安装包已下载完成' });
    return { mode: 'setup', payload: file, version: it.version };
  }

  /**
   * 增量更新：下载清单 + 代码包，校验通过后解压成 app 载荷。
   * 返回 null 表示「这次不走增量」（调用方改走完整包）；抛异常也等价，由 prepare 兜底。
   * @returns {Promise<{mode:'app', payload:string, version:string}|null>}
   */
  async _prepareApp(it, dir) {
    if (!it.incremental || !it.incremental.manifest || !it.incremental.app) return null;
    const conns = Math.max(1, Math.min(16, Number((this.settings().runtime || {}).downloadConnections) || 8));

    // 1) 清单与代码包都很小，用双源候选 + 测速排序（GitHub / Gitee / 镜像）下载。
    const fetchAsset = async (asset, name, label) => {
      const target = path.join(dir, name);
      const ranked = await this.sources.rank(this.sources.candidates(asset), {}).catch(() => this.sources.candidates(asset));
      this.onProgress({ stage: 'download', percent: 1, message: `正在获取${label}…` });
      await downloadAny(ranked, target, {});
      return target;
    };

    const manifestFile = await fetchAsset(it.incremental.manifest, `manifest-${it.version}.json`, '更新清单');
    const manifest = inc.parseManifest(fs.readFileSync(manifestFile, 'utf8'));
    if (String(manifest.version).replace(/^v/i, '') !== String(it.version).replace(/^v/i, '')) {
      throw new Error('清单版本与发行版不一致');
    }
    // 清单声明的 app 资产必须真的是这次 release 里那个（防止挂错旧包）
    const appAsset = it.assets && it.assets.find((a) => a && a.name === manifest.app.asset);
    const choice = inc.chooseMode({
      flavor: this.flavor,
      electronVersion: this.electronVersion,
      manifest,
      assets: appAsset ? [appAsset] : [],
      current: this.current,
    });
    if (choice.mode !== 'app') return null;

    const appFile = await fetchAsset(choice.appAsset, manifest.app.asset, '增量代码包');
    const gotHash = await sha256File(appFile);
    if (String(gotHash).toLowerCase() !== String(manifest.app.sha256).toLowerCase()) {
      throw new Error('增量代码包校验失败（sha256 不符）');
    }

    const payload = path.join(dir, 'app-payload');
    // 不信任 marker/旧载荷字节：刚下完并已按清单 sha256 校验的是归档字节，
    // 载荷一律从它重建（app 模式 + 换名前逐文件校验）。上次下载解压成功但
    // 替换失败的场景因此同样是「复用归档、重建载荷」—— 旧代码在这里直接
    // 返回 marker 声称就绪的载荷，被篡改/截断的字节会被原样复用（T-WEB-002 缺陷 3）。
    if (!clearPayloadOccupant(payload)) throw new Error('增量载荷落点被占用且无法清除，已中止本次更新');
    await this._rebuildPayloadFromArchive(appFile, payload, it.version, {
      mode: 'app',
      validate: async (root) => {
        // 逐文件校验：下载被截断 / 镜像给了错文件都能在这里拦下，且发生在
        // marker 写入与载荷换名之前。
        const bad = await inc.verifyExtracted({ payload: root, files: manifest.app.files });
        if (bad.length) throw new Error(`增量代码包有 ${bad.length} 个文件校验不通过`);
      },
    });
    this.onProgress({ stage: 'ready', percent: 100, message: '增量包已校验完成' });
    return { mode: 'app', payload, version: it.version, manifest };
  }

  /**
   * 下载并拼装分片包。
   * @param {{name:string, size:number, parts:Array<{index:number,size:number,urls:string[]}>}} asset
   */
  async _downloadParts(asset, target, conns, total) {
    const dir = path.dirname(target);
    let doneBytes = 0;
    const fd = fs.openSync(target, 'w');
    try {
      for (const part of asset.parts) {
        const tmp = path.join(dir, `${asset.name}.${part.index}.tmp`);
        const cands = [];
        for (const u of part.urls) {
          for (const c of this.sources.candidates(u)) if (!cands.includes(c)) cands.push(c);
        }
        // eslint-disable-next-line no-await-in-loop
        const ranked = await this.sources.rank(cands, {
          onProgress: (p) => this.onProgress({ ...p, percent: Math.max(1, Math.min(99, Math.round((doneBytes / (total || 1)) * 100))) }),
        }).catch(() => cands);
        // eslint-disable-next-line no-await-in-loop
        await downloadAnyParallel(ranked, tmp, {
          connections: conns,
          onProgress: (pr) => {
            const got = doneBytes + (pr.got || 0);
            const pct = total ? Math.round((got / total) * 100) : 0;
            const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
            this.onProgress({
              stage: 'download',
              percent: Math.max(1, Math.min(99, pct)),
              message: `下载中 ${(got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`
                + `（第 ${part.index}/${asset.parts.length} 片）${sp}`,
              speed: pr.speed,
            });
          },
        });
        const buf = fs.readFileSync(tmp);
        if (part.size && buf.length !== part.size) {
          throw new Error(`分片 ${part.index} 大小不对（${buf.length} ≠ ${part.size}），已中止，可重试`);
        }
        fs.writeSync(fd, buf, 0, buf.length, doneBytes);
        doneBytes += buf.length;
        fs.rmSync(tmp, { force: true });
      }
    } finally {
      fs.closeSync(fd);
    }
    if (total && doneBytes !== total) {
      throw new Error(`更新包拼装后大小不对（${doneBytes} ≠ ${total}），已中止，可重试`);
    }
  }

  async _extract(zipPath, dest) {
    const zf = new ZipFile(zipPath);
    try {
      const names = zf.names().filter((n) => !n.endsWith('/'));
      let i = 0;
      for (const n of names) {
        i += 1;
        // 防 zip-slip：统一走 zip.js 的守卫（挡 ../、绝对路径、盘符、反斜杠绕过）
        const target = resolveZipEntry(dest, n);
        if (!target) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await zf.pipeTo(n, fs.createWriteStream(target));
        if (i % 20 === 0) {
          this.onProgress({
            stage: 'extract',
            percent: Math.min(99, Math.round((i / names.length) * 100)),
            message: `正在解压 ${i}/${names.length}`,
          });
        }
      }
    } finally {
      try { zf.close(); } catch (_) { /* ignore */ }
    }
  }

  /** 载荷就绪标记文件：解压完整落盘后才写，供跨进程复用判断 */
  _readyFile(payload) { return path.join(payload, '.apkstart-ready'); }

  /** [PR3] identity = {digest, assetName} | undefined；增量模式写 mode:'app'。 */
  _markPayloadReady(payload, version, identity, mode = 'zip') {
    try {
      const marker = { version, at: Date.now() };
      if (identity && identity.digest && identity.assetName) {
        marker.digest = identity.digest;
        marker.assetName = identity.assetName;
      }
      if (mode !== 'zip') marker.mode = mode;
      fs.writeFileSync(this._readyFile(payload), JSON.stringify(marker), 'utf8');
    } catch (_) { /* 标记写不了就下次重下，不影响正确性 */ }
  }

  /**
   * [R4] 读取并校验就绪 marker。marker 是本地可写文件（同用户账号被攻破时
   * 不可信），只作「上次解压完成」的本地声明；这里仅做形状/大小/字段合法性
   * 检查，任何畸形/投毒内容都抛错，由调用方 fail closed。
   */
  _readMarker(payload) {
    const f = this._readyFile(payload);
    // [R4-fix] lstat：marker 若被换成指向外部的符号链接，读取（以及后续任何
    // 以它为前提的写入）都可能越界 —— 只认真实文件。
    const st = fs.lstatSync(f);
    if (!st.isFile() || st.size > 4096) throw new Error('ready marker 缺失或超界');
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('ready marker 形状非法');
    if (typeof m.version !== 'string' || !m.version || m.version.length > 64) throw new Error('ready marker version 非法');
    if (m.digest !== undefined && !/^[0-9a-f]{64}$/.test(m.digest)) throw new Error('ready marker digest 非法');
    if (m.assetName !== undefined && !saneAssetName(m.assetName)) throw new Error('ready marker assetName 非法');
    return m;
  }

  /** [PR3] 期望锚定时，marker 必须含匹配的 digest+assetName，否则重下。无锚保持 PR2 语义。 */
  _payloadReady(payload, version, expectIdentity) {
    try {
      const m = this._readMarker(payload);
      // 版本不符 = 上次下的是别的版本，不能复用
      if (m.version !== version) return false;
      // 锚定期望：必须逐字匹配 digest 与 assetName，否则视为过期载荷重下。
      if (expectIdentity && expectIdentity.digest) {
        if (m.digest !== expectIdentity.digest || m.assetName !== expectIdentity.assetName) return false;
      }
      if (m.mode === 'app') {
        // 增量载荷没有 exe；它的「主文件」是 resources/app/package.json
        return fs.existsSync(path.join(payload, 'resources', 'app', 'package.json'));
      }
      // 关键：程序主 exe 必须在载荷里。没有它说明解压被中断/被杀软删过。
      const exeName = path.basename(this.exePath || 'ApkStart.exe');
      return !!findInDir(payload, exeName);
    } catch (_) {
      return false;
    }
  }

  /**
   * [R4] 启动续做的唯一元数据入口：一次权威拉取，供「便携整包锚」与
   * 「增量代码包锚」共用（两次 findResumableJob 内部拉取会被计数/加延迟）。
   * 离线 / 全源失败（stale）一律返回 null。
   * @returns {Promise<object|null>} merged release 元数据
   */
  async _officialMetadata() {
    const timeoutMs = Number(this._metadataTimeoutMs) || 15000; // _metadataTimeoutMs 仅供测试收紧
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      if (timer.unref) timer.unref();
    });
    let merged = null;
    try {
      // [R4-fix] 续做授权依据的是「此刻」官方权威元数据：显式 force 跳过
      // sources 的 10 分钟内存缓存（可能已过期/对应已被替换的 release）。
      // 有界超时与 stale（全源失败兜底缓存）拒绝语义保持不变。
      merged = await Promise.race([this.sources.latest({ force: true }).catch(() => null), deadline]);
    } catch (_) { merged = null; }
    clearTimeout(timer);
    // stale = 全源失败后拿旧缓存凑数：不是本次权威元数据，不能作锚
    if (!merged || merged.stale) return null;
    return merged;
  }

  /**
   * [R4] 取「当前官方最新 release」里可用于便携续做的锚定资产。
   * 这是启动续做的唯一信任根：digest 来自 GitHub REST（TLS 到 api.github.com），
   * 与 marker 字段无关 —— marker 是本地可写文件，永不作为身份来源。
   * 离线 / 全源失败（stale）/ Gitee-only / synthetic / 无 digest 一律返回 null，
   * 即拿不到可信身份就不自动续做（fail closed）。
   * @param {object} [merged] 已拉取的权威元数据（findResumableJob 共用一次拉取）；
   *                          省略时自行拉取。
   * @returns {Promise<{version:string,name:string,digest:string,size:number}|null>}
   */
  async _officialUpdateAsset(merged) {
    const meta = merged || await this._officialMetadata();
    if (!meta) return null;
    // 便携续做只认 zip 资产；选择规则与 check() 的便携分支一致。
    // 清单 / 代码包 / 运行时整包是辅助资产，绝不能当整包锚：某次发布若只有
    // app.zip，旧兜底会把它当便携包，随后缺 exe 的重建必然失败（R2 反例）。
    const assets = Array.isArray(meta.assets) ? meta.assets : [];
    const asset = assets.find((a) => /portable.*\.zip$/i.test(String(a.name || '')))
      || assets.find((a) => /win64.*\.zip$/i.test(String(a.name || '')))
      || assets.find((a) => /\.zip$/i.test(String(a.name || '')) && !inc.isAuxAsset(String(a.name || '')));
    if (!asset || !asset.digest || !asset.digestUrl) return null;
    if (!saneAssetName(asset.name)) return null;
    return {
      version: meta.version,
      name: asset.name,
      digest: String(asset.digest).toLowerCase(),
      size: asset.size || 0,
    };
  }

  /**
   * [R4] 取「当前官方最新 release」里可用于「增量续做」的锚定资产：
   *   - digest 锚：ApkStart-*-app.zip（增量代码包，APP_PACK_RE）必须带官方
     GitHub digest（PR3 元数据锚定），否则增量续做没有可信身份，fail closed；
   *   - manifest 锚：ApkStart-*-manifest.json（其 app.sha256 + app.asset 也要
   *     与官方一致才能定位代码包）。
   * 都取不到（离线/无增量资产/无 digest）→ null。
   * @returns {Promise<{version:string,name:string,digest:string,size:number,manifestAsset:object|null}|null>}
   */
  async _officialIncrementalAsset(merged) {
    const assets = Array.isArray(merged && merged.assets) ? merged.assets : [];
    const appAsset = assets.find((a) => inc.APP_PACK_RE.test(String(a.name || '')));
    if (!appAsset || !appAsset.digest || !appAsset.digestUrl) return null;
    if (!saneAssetName(appAsset.name)) return null;
    // 清单本身也只认官方 GitHub 源携带 digest 的那份；拿不到就用官方 assets 里的无 digest 清单
    // （清单不作为身份来源，只提供 app.asset 的映射；身份锚永远是 app.zip 的官方 digest）。
    const manifestAsset = assets.find((a) => inc.MANIFEST_RE.test(String(a.name || ''))) || null;
    if (manifestAsset && !saneAssetName(manifestAsset.name)) return null;
    return {
      version: merged.version,
      name: appAsset.name,
      digest: String(appAsset.digest).toLowerCase(),
      size: appAsset.size || 0,
      digestUrl: appAsset.digestUrl,
      manifestAsset,
    };
  }

  /**
   * [R4] 校验并重建一个「增量（app-payload）」可自动执行的续做任务。信任链：
   *   官方 app.zip digest（元数据） == 留存 app 归档字节（SHA256）
   *     ⇒ 从归档重建载荷（app 模式：resources/app/package.json 为真文件）
   *     ⇒ marker 写 mode:'app' + 官方 digest/assetName。
   * marker（本地可写）永不授权字节身份；.apkstart-force-full 存在时不续做
   * （由 findResumableJob 把关）。归档缺失/字节不符 → null（保留数据，不自动执行）。
   */
  async _verifiedAppResumeJob(appPayload, v, official) {
    try {
      const appArchive = this._stagedArchivePath(v, official.name);
      if (!appArchive) return null;
      let verified = false;
      try {
        verified = (await sha256File(appArchive)) === official.digest;
      } catch (_) { verified = false; }
      if (!verified) return null;
      // 与整包续做同样的落点规则：载荷被 junction/symlink 占用时只摘链接本身，
      // 绝不递归进目标；真目录由重建的 rename 备份流程接管。
      if (!clearPayloadOccupant(appPayload)) return null;
      // 不信任旧 app-payload 字节（可能被篡改/来自异源/上次解压中断）：
      // 从已验证归档按 app 模式重建（唯一 staging + 原子换名）。
      await this._rebuildPayloadFromArchive(appArchive, appPayload, v,
        { digest: official.digest, assetName: official.name, mode: 'app' });
      const m = this._readMarker(appPayload);
      if (m.version !== v || m.mode !== 'app') return null;
      if (!fs.existsSync(path.join(appPayload, 'resources', 'app', 'package.json'))) return null;
      return { mode: 'app', payload: appPayload, version: v };
    } catch (_) {
      return null;
    }
  }

  /**
   * [R4] 校验并重建一个可自动执行的续做任务。信任链：
   *   官方 digest（元数据） == 留存归档字节（SHA256） ⇒ 从归档重建载荷 ⇒ 主 exe 存在。
   * marker 只提供「上次解压完整完成」的本地声明；它与官方身份冲突或畸形时
   * fail closed。归档缺失/字节不符/版本不符 → null（保留数据，不自动执行）。
   */
  async _verifiedResumeJob(payload, v, official) {
    try {
      // [R4-fix] marker 先照实读取（junction 形态的载荷其 marker 在链接目标里，
      // 读取本身不落盘、无越界风险）；身份/字节全部校验通过、真正要重建时，
      // clearPayloadOccupant 只摘链接本身（绝不递归进目标），再从已验证归档
      // 重建出真实目录（root R4-B01/P34）。真目录占用交由重建的 rename 备份流程。
      const m = this._readMarker(payload);
      if (m.version !== v) return null;
      // marker 携带身份声明（PR3+ 写入）时必须与官方元数据一致；遗留 marker
      // （无身份字段，PR2 时代）不携带声明，仅由下面的归档校验把关。
      if (m.digest && m.digest !== official.digest) return null;
      if (m.assetName && m.assetName !== official.name) return null;
      const archive = this._stagedArchivePath(v, official.name);
      if (!archive) return null;
      let verified = false;
      try {
        verified = (await sha256File(archive)) === official.digest;
      } catch (_) { verified = false; }
      if (!verified) return null;
      // 全部校验通过，准备重建：落点若被 junction/symlink 占用，此刻只摘链接
      // 本身（不递归进目标）；真目录由 _rebuildPayloadFromArchive 的 rename
      // 备份流程接管。摘不掉（被占用）→ fail closed，保留数据。
      if (!clearPayloadOccupant(payload)) return null;
      // 不信任旧载荷字节（可能被篡改/来自异源）：从已验证归档重建。
      await this._rebuildPayloadFromArchive(archive, payload, v, { digest: official.digest, assetName: official.name });
      const exeName = path.basename(this.exePath || 'ApkStart.exe');
      if (!findInDir(payload, exeName)) return null;
      return { mode: 'zip', payload, version: v };
    } catch (_) {
      return null;
    }
  }

  /** [R4] 留存归档路径（prepare() 下载产物，apply 成功前一直保留）；缺失/越界 → null。 */
  _stagedArchivePath(v, name) {
    if (!saneAssetName(name) || !saneVersionDir(v)) return null;
    const p = path.join(this.updateDir, v, name);
    try {
      // [R4-fix] lstat：符号链接/junction 形态的「归档」一律不认，跟随读取
      // （乃至以此为前提的重建写入）都可能落在更新根之外。
      const st = fs.lstatSync(p);
      if (!st.isFile() || !st.size) return null;
    } catch (_) { return null; }
    return p;
  }

  /**
   * [R4] 从已验证归档重建载荷（无第二次整包下载）。[R4-fix] 改为
   * 「唯一 staging + 主文件校验 + 原子换名」：
   *   - staging 名字带唯一后缀：并发重建/prepare 互不踩踏，也不会把别的
   *     调用方已经拿到的载荷就地截断（root 审查 R4-C01）；
   *   - 换名前先确认主文件是真实文件：整包模式要求主 exe，增量模式要求
   *     resources/app/package.json（官方 app.zip 只含代码层，没有也不该有 exe）；
   *   - identity.validate 在换名前跑（增量清单逐文件哈希），不通过则不写
   *     marker、不换载荷；
   *   - 解压/校验失败：清掉 staging，旧载荷、marker、归档原样保留（缓存不丢）；
   *   - rm→rename 之间崩溃（毫秒级窗口）：载荷+marker 丢失但归档还在，
   *     下次启动拿不到 marker → 不自动续做，由静默查新接管（诚实降级）。
   * @param {object} [identity] {digest, assetName, mode:'zip'|'app', validate?:Function}
   */
  async _rebuildPayloadFromArchive(archive, payload, v, identity) {
    const dir = path.dirname(payload);
    const mode = identity && identity.mode === 'app' ? 'app' : 'zip';
    // [R4-fix] 注意：这里绝不做残留清扫 —— 并发场景下另一个重建可能正持有
    // 自己的 staging（旧 probe R4-C01 曾实锤清扫误删活跃 staging）。残留由
    // findResumableJob 启动入口统一清扫。
    const staging = path.join(dir, `payload.staging-${uniqueSuffix()}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
      await this._extract(archive, staging);   // zip-slip 守卫在 zip.js resolveZipEntry
      if (mode === 'app') {
        // 增量代码包的主文件是 resources/app/package.json（真文件、非空）。
        const pkg = path.join(staging, 'resources', 'app', 'package.json');
        let pkgOk = false;
        try { const st = fs.lstatSync(pkg); pkgOk = st.isFile() && st.size > 0; } catch (_) { pkgOk = false; }
        if (!pkgOk) throw new Error('增量代码包里没有可用的 resources/app/package.json，已中止替换');
      } else {
        // [R4-fix] 主 exe 必须存在于重建树里且是真实文件（目录假扮/零字节都拒绝），
        // 否则不换名 —— 旧载荷保持可用。
        const exeName = path.basename(this.exePath || 'ApkStart.exe');
        const exeRel = findInDir(staging, exeName);
        let exeOk = false;
        if (exeRel) {
          const est = fs.lstatSync(path.join(staging, exeRel));
          exeOk = est.isFile() && est.size > 0;
        }
        if (!exeOk) throw new Error('更新包里没有可用的主程序文件，已中止替换');
      }
      // 清单逐文件校验必须在写 marker / 换名之前：不过就不留「已就绪」假象。
      if (identity && typeof identity.validate === 'function') await identity.validate(staging);
      this._markPayloadReady(staging, v, identity, mode);
      const backup = path.join(dir, `payload.old-${uniqueSuffix()}`);
      let moved = false;
      if (fs.existsSync(payload)) { await renameWithRetry(payload, backup); moved = true; }
      try {
        await renameWithRetry(staging, payload);
      } catch (e) {
        if (moved) { try { await renameWithRetry(backup, payload); } catch (_) { /* 恢复失败只能靠归档重试 */ } }
        throw e;
      }
      if (moved) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch (_) { /* 残留交给清扫 */ } }
    } catch (e) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      throw e;
    }
  }

  /**
   * 启动时调用（异步）：找回「上次已下载解压、但替换/重启失败」的更新并续做。
   * 仍然不再重新下载整包（issue #98 的死循环根治）—— 但 [R4] 起续做前必须先
   * 拿官方 release 元数据校验留存归档的身份；拿不到可信身份（离线/无锚/版本
   * 不符/字节不符）就返回 null，保留数据交给静默查新，绝不拖垮启动。
   * 元数据只拉一次：同一次结果既给便携整包锚（_officialUpdateAsset），也给
   * 增量代码包锚（_officialIncrementalAsset）—— 双资产发布与「只有 app.zip」
   * 的发布都能各取所需，缺哪个就跳过对应的续做路径。
   * @returns {Promise<{mode:'zip'|'app', payload:string, version:string}|null>}
   */
  async findResumableJob() {
    try {
      if (!fs.existsSync(this.updateDir)) return null;
      const versions = fs.readdirSync(this.updateDir)
        .filter((n) => saneVersionDir(n) && cmpVer(n, this.current) > 0)   // 只认比当前更新的版本，避免反复重启
        .sort((a, b) => cmpVer(b, a));
      if (!versions.length) return null;
      const merged = await this._officialMetadata();
      if (!merged) return null;
      const official = await this._officialUpdateAsset(merged);
      const officialApp = await this._officialIncrementalAsset(merged);
      if (!official && !officialApp) return null;
      for (const v of versions) {
        // 只续做「目录版本 == 官方最新版本」的载荷；过期/超前版本交给查新流程
        if (v !== merged.version) continue;
        // [R4-fix] 版本目录若是 junction/symlink（指向更新根之外），整个续做跳过：
        // 不读里面的载荷/归档，更不删除外面的文件（root 审查 R4-B01 实锤）。
        if (!realVersionDir(this.updateDir, v)) continue;
        // [R4-fix] 启动入口统一清扫本版本目录下的残留 staging/备份（唯一清扫点：
        // 此时本流程尚未创建自己的 staging，也不会碰并发方尚未存在的目录）。
        sweepStaleStaging(path.join(this.updateDir, v));
        const forceFull = fs.existsSync(path.join(this.updateDir, v, '.apkstart-force-full'));
        // 增量载荷（上次增量替换失败标记了强制完整包 → 不重放）
        const appPayload = path.join(this.updateDir, v, 'app-payload');
        if (!forceFull && officialApp && this._payloadReady(appPayload, v)) {
          // [R4] 增量续做也必须经官方身份校验：官方 app.zip digest（PR3 元数据
          // 锚定）+ 留存 app 归档 SHA-256 一致才重建并续做；拿不到官方身份或
          // 字节不符一律 null（保留数据，不自动执行）。
          const appJob = await this._verifiedAppResumeJob(appPayload, v, officialApp);
          if (appJob) return appJob;
        }
        // 完整包载荷
        if (official) {
          const payload = path.join(this.updateDir, v, 'payload');
          const job = await this._verifiedResumeJob(payload, v, official);
          if (job) return job;
        }
      }
    } catch (_) { /* 启动续做绝不拖垮启动 */ }
    return null;
  }

  /**
   * 生成并启动「替换 + 重启」脚本，然后调用方负责退出应用。
   * @param {{mode:'zip'|'setup', payload:string, version:string}} job
   * @param {{waitPid?:number, spawn?:boolean, powershellPath?:string}} [opts]
   *        测试时可指定别的 pid / 不真启动 / 替换助手可执行文件路径（用于
   *        验证「调度失败如实抛错」）
   */
  apply(job, opts = {}) {
    const exe = this.exePath;
    const dir = this.installDir;
    const logFile = path.join(this.updateDir, 'update.log');
    fs.mkdirSync(this.updateDir, { recursive: true });
    const waitPid = opts.waitPid || process.pid;
    const versionDir = path.join(this.updateDir, job.version);

    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = ${psq(logFile)}`,
      `function Note($m) { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }`,
      // 公共文件工具：相对路径与 SHA-256。不用 Get-FileHash —— 某些机器的
      // PSModulePath 不完整（Utility 模块不可见），.NET 的 SHA256 在 Windows
      // PowerShell 5.1 上始终可用。
      `function RelPath([string]$base, [string]$full) { return $full.Substring($base.TrimEnd('\\').Length).TrimStart('\\') }`,
      `function HashFile([string]$p) { $s = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); try { $h = [System.Security.Cryptography.SHA256]::Create(); try { return [System.BitConverter]::ToString($h.ComputeHash($s)).Replace('-', '').ToLowerInvariant() } finally { $h.Dispose() } } finally { $s.Dispose() } }`,
      `Note 'updater start'`,
      // 成功、回滚、重启必须分开记账：applyOk 只表示文件替换已按字节验证；
      // relaunchOk 只表示「请求启动」返回成功，不代表应用健康。
      `$applyOk = $false`,
      `$rollbackFailed = $false`,
      `$relaunchOk = $false`,
      `$relaunchAllowed = $true`,
      `$relaunchSkipReason = ''`,
      // 等本进程真正退出（最多 90 秒），否则 exe/dll 仍被占用
      `try { Wait-Process -Id ${waitPid} -Timeout 90 } catch { }`,
      `Start-Sleep -Milliseconds 700`,
    ];

    if (job.mode === 'zip') {
      // 旧实现只比对「目标 exe 的字节数」：只要 exe 长度碰巧一致，哪怕别的资源
      // 一个都没复制成功（被锁/被杀软拦截），也会被当成成功并删掉载荷。
      // 新实现：先把载荷里所有文件复制到程序目录下的临时 staging 区并逐个校验
      // SHA256；全部通过后才用 File.Replace 替换（旧文件留在 backup 区）。
      // staging 失败时不动任何已安装文件；commit 失败时回滚已替换文件。两种失败
      // 都保留载荷与备份，并让 helper 以非 0 退出。
      const exeName = path.basename(exe);
      lines.push(
        // 单文件替换走一个函数边界：生产环境就是 File.Replace；回归测试可用同名
        // 函数模拟 ReplaceFileW 在「旧目标已改名到 backup、替换文件尚未就位」时
        // 抛错的文档化状态（error 1177）。测试注入仅存在于测试进程，不写产品状态。
        `if (-not (Get-Command Invoke-ApkstartReplace -CommandType Function -ErrorAction SilentlyContinue)) {`,
        `  function Invoke-ApkstartReplace([string]$Stage, [string]$Target, [string]$Backup) {`,
        `    [System.IO.File]::Replace($Stage, $Target, $Backup)`,
        `  }`,
        `}`,
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$versionDir = ${psq(versionDir)}`,
        `$exeName = ${psq(exeName)}`,
        `$target = Join-Path $dst $exeName`,
        `$srcExe = Join-Path $src $exeName`,
        `$stageRoot = Join-Path $dst ('.apkstart-stage-' + $PID)`,
        `$backupRoot = Join-Path $dst ('.apkstart-backup-' + $PID)`,
        `$files = @()`,
        `$dirs = @()`,
        `try {`,
        // -Force 必须带：默认枚举会跳过 Hidden/System 文件与目录，导致载荷里
        // 隐藏资源被静默漏装，却仍以「全部文件已校验」成功收尾。
        `  $files = @(Get-ChildItem -LiteralPath $src -Recurse -File -Force -ErrorAction Stop | Where-Object { $_.Name -ne '.apkstart-ready' } | Sort-Object FullName)`,
        `  $dirs = @(Get-ChildItem -LiteralPath $src -Recurse -Directory -Force -ErrorAction Stop | Sort-Object FullName)`,
        `} catch { Note ("payload scan failed: " + $_.Exception.Message) }`,
        `$hasExe = $false`,
        `foreach ($f in $files) { if ($f.FullName -ieq $srcExe) { $hasExe = $true } }`,
        `if (($files.Count -eq 0) -or (-not $hasExe)) {`,
        `  Note ("payload incomplete: " + $files.Count + " files, exe=" + $hasExe + "; keeping payload")`,
        `} else {`,
        `  $stageOk = $false`,
        `  try {`,
        `    if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction Stop }`,
        `    New-Item -ItemType Directory -Path $stageRoot -Force -ErrorAction Stop | Out-Null`,
        `    $stageOk = $true`,
        `  } catch { Note ("stage init failed: " + $_.Exception.Message) }`,
        `  if ($stageOk) {`,
        `    foreach ($d in $dirs) {`,
        `      $rel = RelPath $src $d.FullName`,
        `      try { New-Item -ItemType Directory -Path (Join-Path $stageRoot $rel) -Force -ErrorAction Stop | Out-Null }`,
        `      catch { Note ("stage mkdir failed for " + $rel + " : " + $_.Exception.Message); $stageOk = $false; break }`,
        `    }`,
        `  }`,
        `  if ($stageOk) {`,
        `    foreach ($f in $files) {`,
        `      $rel = RelPath $src $f.FullName`,
        `      $stage = Join-Path $stageRoot $rel`,
        `      $copied = $false`,
        `      $srcHash = $null`,
        `      try {`,
        `        New-Item -ItemType Directory -Path (Split-Path -Parent $stage) -Force -ErrorAction Stop | Out-Null`,
        `        $srcHash = HashFile $f.FullName`,
        `      } catch { Note ("stage read failed for " + $rel + " : " + $_.Exception.Message); $stageOk = $false; break }`,
        `      for ($i = 1; $i -le 12; $i++) {`,
        `        try {`,
        `          Copy-Item -LiteralPath $f.FullName -Destination $stage -Force -ErrorAction Stop`,
        `          $gotHash = HashFile $stage`,
        `          if ($gotHash -eq $srcHash) { $copied = $true; break }`,
        `          Note ("stage hash mismatch for " + $rel + " attempt " + $i)`,
        `        } catch { Note ("stage copy failed for " + $rel + " attempt " + $i + " : " + $_.Exception.Message) }`,
        `        Start-Sleep -Milliseconds 600`,
        `      }`,
        `      if (-not $copied) { Note ("staging FAILED for " + $rel); $stageOk = $false; break }`,
        `    }`,
        `  }`,
        `  if ($stageOk) {`,
        `    try {`,
        `      $staged = @(Get-ChildItem -LiteralPath $stageRoot -Recurse -File -Force -ErrorAction Stop)`,
        `      if ($staged.Count -ne $files.Count) { Note ("staging incomplete: " + $staged.Count + "/" + $files.Count + " files"); $stageOk = $false }`,
        `    } catch { Note ("stage verification failed: " + $_.Exception.Message); $stageOk = $false }`,
        `  }`,
        `  if (-not $stageOk) {`,
        `    Note 'apply failed during staging; installed files untouched; keeping payload for retry'`,
        `    try { Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction Stop } catch { Note ("stage cleanup failed: " + $_.Exception.Message) }`,
        `  } else {`,
        `    $commitOk = $true`,
        `    $committed = New-Object System.Collections.ArrayList`,
        `    try { New-Item -ItemType Directory -Path $backupRoot -Force -ErrorAction Stop | Out-Null }`,
        `    catch { Note ("backup init failed: " + $_.Exception.Message); $commitOk = $false }`,
        `    if ($commitOk) {`,
        `      foreach ($d in $dirs) {`,
        `        $rel = RelPath $src $d.FullName`,
        `        try { New-Item -ItemType Directory -Path (Join-Path $dst $rel) -Force -ErrorAction Stop | Out-Null }`,
        `        catch { Note ("target mkdir failed for " + $rel + " : " + $_.Exception.Message); $commitOk = $false; break }`,
        `      }`,
        `    }`,
        `    if ($commitOk) {`,
        `      foreach ($f in $files) {`,
        `        $rel = RelPath $src $f.FullName`,
        `        $stage = Join-Path $stageRoot $rel`,
        `        $target = Join-Path $dst $rel`,
        `        $backup = Join-Path $backupRoot $rel`,
        `        $hadTarget = Test-Path -LiteralPath $target`,
        `        $oldHash = $null`,
        `        $newHash = $null`,
        `        $mutated = $false`,
        `        try {`,
        `          New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force -ErrorAction Stop | Out-Null`,
        `          $newHash = HashFile $stage`,
        `          if ($hadTarget) {`,
        `            $oldHash = HashFile $target`,
        `            New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force -ErrorAction Stop | Out-Null`,
        `            $mutated = $true`,
        `            Invoke-ApkstartReplace $stage $target $backup`,
        `          } else {`,
        `            $mutated = $true`,
        `            [System.IO.File]::Move($stage, $target)`,
        `          }`,
        `          [void]$committed.Add([pscustomobject]@{ Rel = $rel; HadTarget = $hadTarget; Backup = $backup; OldHash = $oldHash; NewHash = $newHash })`,
        `        } catch {`,
        `          Note ("commit failed for " + $rel + " : " + $_.Exception.Message)`,
        `          $commitOk = $false`,
        // 失败的 Replace 不能假定目标没动：ReplaceFileW 的 error 1177 表示
        // 旧目标已改名到 backup、替换文件还没就位。当前这一条也必须从实际
        // 存在的 backup 恢复并校验；做不到就标记 rollbackFailed，让 helper
        // 不重启一个状态不明的安装。
        `          if (-not $mutated) {`,
        `            Note ("commit failed before replace for " + $rel + "; target untouched")`,
        `          } elseif ($hadTarget) {`,
        `            try {`,
        `              $backupExists = Test-Path -LiteralPath $backup`,
        `              $targetExists = Test-Path -LiteralPath $target`,
        `              if ($backupExists) {`,
        `                $backupHash = HashFile $backup`,
        `                $expectedHash = $oldHash`,
        `                if ($null -eq $expectedHash) { $expectedHash = $backupHash }`,
        `                if ($backupHash -ne $expectedHash) { throw ("backup hash mismatch for " + $rel) }`,
        `                if ($targetExists) { $targetHash = HashFile $target } else { $targetHash = $null }`,
        `                if ($targetHash -eq $expectedHash) {`,
        `                  Note ("current file unchanged after failed replace: " + $rel)`,
        `                } else {`,
        `                  Copy-Item -LiteralPath $backup -Destination $target -Force -ErrorAction Stop`,
        `                  if ((HashFile $target) -ne $expectedHash) { throw ("restored hash mismatch for " + $rel) }`,
        `                  Note ("restored current file from backup after failed replace: " + $rel)`,
        `                }`,
        `              } elseif ($targetExists -and ($null -ne $oldHash) -and ((HashFile $target) -eq $oldHash)) {`,
        `                Note ("current file unchanged after failed replace: " + $rel)`,
        `              } else {`,
        `                throw ("no usable backup and target bytes are not the pre-update bytes for " + $rel)`,
        `              }`,
        `            } catch {`,
        `              Note ("current-file recovery FAILED for " + $rel + " : " + $_.Exception.Message + "; install state uncertain")`,
        `              $rollbackFailed = $true`,
        `            }`,
        `          } else {`,
        `            try {`,
        `              if (Test-Path -LiteralPath $target) {`,
        `                if (($null -ne $newHash) -and ((HashFile $target) -ne $newHash)) { throw ("new file bytes are unexpected for " + $rel) }`,
        `                Remove-Item -LiteralPath $target -Force -ErrorAction Stop`,
        `                Note ("removed partially moved new file: " + $rel)`,
        `              }`,
        `            } catch {`,
        `              Note ("current-file recovery FAILED for " + $rel + " : " + $_.Exception.Message + "; install state uncertain")`,
        `              $rollbackFailed = $true`,
        `            }`,
        `          }`,
        `          break`,
        `        }`,
        `      }`,
        `    }`,
        `    if ($commitOk -and ($committed.Count -ne $files.Count)) {`,
        `      Note ("commit incomplete: " + $committed.Count + "/" + $files.Count + " files")`,
        `      $commitOk = $false`,
        `    }`,
        `    if (-not $commitOk) {`,
        `      Note 'commit failed; rolling back already replaced files'`,
        `      for ($j = $committed.Count - 1; $j -ge 0; $j--) {`,
        `        $c = $committed[$j]`,
        `        $target = Join-Path $dst $c.Rel`,
        `        try {`,
        `          if ($c.HadTarget) {`,
        `            Copy-Item -LiteralPath $c.Backup -Destination $target -Force -ErrorAction Stop`,
        `            $backupHash = HashFile $c.Backup`,
        `            $targetHash = HashFile $target`,
        `            if ($backupHash -ne $targetHash) { throw ("rollback hash mismatch for " + $c.Rel) }`,
        `            if (($null -ne $c.OldHash) -and ($backupHash -ne $c.OldHash)) { throw ("backup is not pre-update bytes for " + $c.Rel) }`,
        `          } else {`,
        `            if (Test-Path -LiteralPath $target) {`,
        `              $targetHash = HashFile $target`,
        `              if (($null -ne $c.NewHash) -and ($targetHash -ne $c.NewHash)) { throw ("new file bytes changed before rollback for " + $c.Rel) }`,
        `              Remove-Item -LiteralPath $target -Force -ErrorAction Stop`,
        `            }`,
        `          }`,
        `        } catch { Note ("rollback FAILED for " + $c.Rel + " : " + $_.Exception.Message); $rollbackFailed = $true }`,
        `      }`,
        `      try { Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction Stop } catch { Note ("stage cleanup failed: " + $_.Exception.Message) }`,
        `      Note ("apply failed; keeping payload at " + $src + " and backups at " + $backupRoot)`,
        `    } else {`,
        `      $applyOk = $true`,
        `      Note ("apply verified: " + $files.Count + " files staged and committed with SHA256 verification")`,
        `      try { Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction Stop } catch { Note ("stage cleanup failed: " + $_.Exception.Message) }`,
        `      try { Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction Stop } catch { Note ("backup cleanup failed: " + $_.Exception.Message) }`,
        `      try { Remove-Item -LiteralPath (Join-Path $src '.apkstart-ready') -Force -ErrorAction Stop } catch { }`,
        `      try { Remove-Item -LiteralPath $src -Recurse -Force -ErrorAction Stop } catch { Note ("payload cleanup failed: " + $_.Exception.Message) }`,
        `      try { Remove-Item -LiteralPath $versionDir -Recurse -Force -ErrorAction Stop } catch { Note ("version dir cleanup failed: " + $_.Exception.Message + "; residual path " + $versionDir) }`,
        `    }`,
        `  }`,
        `}`,
      );
    } else if (job.mode === 'app') {
      // 增量替换：只替换 resources\app（我们的 JS / 资源 / node_modules）。
      // Electron 外壳（exe / dll / locales / runtime）与用户数据一律不动。
      // 合同与 zip 一致：先把载荷 app 树完整 staging 并逐文件哈希，再整目录
      // 换名提交；提交后按字节验证已安装树。任一步失败都保留载荷与备份，
      // 恢复旧树并做字节验收；恢复无法确认时标记 rollbackFailed，禁止重启。
      // app 是「完整替换」语义：旧 app 独有的文件随旧目录一起进备份，不累积。
      const appRel = path.join('resources', 'app');
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$versionDir = ${psq(versionDir)}`,
        `$appRel = ${psq(appRel)}`,
        `$appDst = Join-Path $dst $appRel`,
        `$appSrc = Join-Path $src $appRel`,
        `$forceFull = Join-Path $versionDir '.apkstart-force-full'`,
        `$stageRoot = Join-Path $dst ('.apkstart-stage-' + $PID)`,
        `$backupRoot = Join-Path $dst ('.apkstart-backup-' + $PID)`,
        `$files = @()`,
        `$dirs = @()`,
        `$newManifest = @{}`,
        `$oldManifest = @{}`,
        `$oldVersion = $null`,
        `$hasBackup = $false`,
        `$changed = $false`,
        `$oldIntact = $true`,
        // 目录换名与「已安装树验证」各走一个函数边界，生产实现就是真实文件
        // 操作；回归测试只能替换这个边界来模拟某一阶段的故障，测试进程之外
        // 不产生任何产品行为。
        `function Test-ApkstartTree([string]$Root, [hashtable]$Manifest, [string]$Version) {`,
        `  if (-not (Test-Path -LiteralPath $Root)) { return $false }`,
        `  try { $got = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction Stop) } catch { return $false }`,
        `  if ($got.Count -ne $Manifest.Count) { return $false }`,
        `  foreach ($f in $got) {`,
        `    $rel = RelPath $Root $f.FullName`,
        `    if (-not $Manifest.ContainsKey($rel)) { return $false }`,
        `    try { $h = HashFile $f.FullName } catch { return $false }`,
        `    if ($h -ne $Manifest[$rel]) { return $false }`,
        `  }`,
        `  if ($null -ne $Version) {`,
        `    try { $pv = (Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw -ErrorAction Stop | ConvertFrom-Json).version } catch { return $false }`,
        `    if ($pv -ne $Version) { return $false }`,
        `  }`,
        `  return $true`,
        `}`,
        `if (-not (Get-Command Invoke-ApkstartAppBackup -CommandType Function -ErrorAction SilentlyContinue)) {`,
        // 目录换名用 .NET Directory.Move：失败时不会像 Move-Item 那样先建出
        // 空的目标目录，也不会把「移动目录」退化成逐项搬运。
        `  function Invoke-ApkstartAppBackup([string]$Tree, [string]$Backup) { [System.IO.Directory]::Move($Tree, $Backup) }`,
        `}`,
        `if (-not (Get-Command Invoke-ApkstartAppCommit -CommandType Function -ErrorAction SilentlyContinue)) {`,
        `  function Invoke-ApkstartAppCommit([string]$Stage, [string]$Tree) { [System.IO.Directory]::Move($Stage, $Tree) }`,
        `}`,
        `if (-not (Get-Command Invoke-ApkstartAppRestoreMove -CommandType Function -ErrorAction SilentlyContinue)) {`,
        `  function Invoke-ApkstartAppRestoreMove([string]$Backup, [string]$Tree) { [System.IO.Directory]::Move($Backup, $Tree) }`,
        `}`,
        `if (-not (Get-Command Invoke-ApkstartAppVerify -CommandType Function -ErrorAction SilentlyContinue)) {`,
        `  function Invoke-ApkstartAppVerify([string]$Root, [string]$Version, [hashtable]$Manifest) {`,
        `    if (-not (Test-ApkstartTree $Root $Manifest $Version)) { throw 'installed app tree failed byte verification' }`,
        `    return $true`,
        `  }`,
        `}`,
        // 改动前先记录旧树清单与版本：恢复后要按这些字节验收，不能只看目录回来了。
        `if (Test-Path -LiteralPath $appDst) {`,
        `  try {`,
        `    $oldFiles = @(Get-ChildItem -LiteralPath $appDst -Recurse -File -Force -ErrorAction Stop)`,
        `    foreach ($f in $oldFiles) { $rel = RelPath $appDst $f.FullName; $oldManifest[$rel] = HashFile $f.FullName }`,
        `    $oldVersion = (Get-Content -LiteralPath (Join-Path $appDst 'package.json') -Raw -ErrorAction Stop | ConvertFrom-Json).version`,
        `  } catch { Note ("old app tree cannot be fully read: " + $_.Exception.Message); $oldIntact = $false }`,
        `}`,
        `try {`,
        `  $files = @(Get-ChildItem -LiteralPath $appSrc -Recurse -File -Force -ErrorAction Stop | Where-Object { $_.Name -ne '.apkstart-ready' } | Sort-Object FullName)`,
        `  $dirs = @(Get-ChildItem -LiteralPath $appSrc -Recurse -Directory -Force -ErrorAction Stop | Sort-Object FullName)`,
        `} catch { Note ("app payload scan failed: " + $_.Exception.Message) }`,
        `$pkgSrc = Join-Path $appSrc 'package.json'`,
        `$hasPkg = $false`,
        `foreach ($f in $files) { if ($f.FullName -ieq $pkgSrc) { $hasPkg = $true } }`,
        `$stageOk = $false`,
        `if ((-not $oldIntact) -or ($files.Count -eq 0) -or (-not $hasPkg)) {`,
        `  Note ("app apply refused before changing installed tree: files=" + $files.Count + " package.json=" + $hasPkg + " oldTreeReadable=" + $oldIntact)`,
        `} else {`,
        `  try {`,
        `    if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction Stop }`,
        `    New-Item -ItemType Directory -Path $stageRoot -Force -ErrorAction Stop | Out-Null`,
        `    $stageOk = $true`,
        `  } catch { Note ("app stage init failed: " + $_.Exception.Message) }`,
        `  if ($stageOk) {`,
        `    foreach ($d in $dirs) {`,
        `      $rel = RelPath $appSrc $d.FullName`,
        `      try { New-Item -ItemType Directory -Path (Join-Path $stageRoot $rel) -Force -ErrorAction Stop | Out-Null }`,
        `      catch { Note ("app stage mkdir failed for " + $rel + " : " + $_.Exception.Message); $stageOk = $false; break }`,
        `    }`,
        `  }`,
        `  if ($stageOk) {`,
        `    foreach ($f in $files) {`,
        `      $rel = RelPath $appSrc $f.FullName`,
        `      $stage = Join-Path $stageRoot $rel`,
        `      $copied = $false`,
        `      $srcHash = $null`,
        `      try {`,
        `        New-Item -ItemType Directory -Path (Split-Path -Parent $stage) -Force -ErrorAction Stop | Out-Null`,
        `        $srcHash = HashFile $f.FullName`,
        `      } catch { Note ("app stage read failed for " + $rel + " : " + $_.Exception.Message); $stageOk = $false; break }`,
        `      for ($i = 1; $i -le 12; $i++) {`,
        `        try {`,
        `          Copy-Item -LiteralPath $f.FullName -Destination $stage -Force -ErrorAction Stop`,
        `          if ((HashFile $stage) -eq $srcHash) { $copied = $true; break }`,
        `          Note ("app stage hash mismatch for " + $rel + " attempt " + $i)`,
        `        } catch { Note ("app stage copy failed for " + $rel + " attempt " + $i + " : " + $_.Exception.Message) }`,
        `        Start-Sleep -Milliseconds 600`,
        `      }`,
        `      if (-not $copied) { Note ("app staging FAILED for " + $rel); $stageOk = $false; break }`,
        `      $newManifest[$rel] = $srcHash`,
        `    }`,
        `  }`,
        `  if ($stageOk) {`,
        `    try {`,
        `      $staged = @(Get-ChildItem -LiteralPath $stageRoot -Recurse -File -Force -ErrorAction Stop)`,
        `      if ($staged.Count -ne $files.Count) { Note ("app staging incomplete: " + $staged.Count + "/" + $files.Count + " files"); $stageOk = $false }`,
        `    } catch { Note ("app stage verification failed: " + $_.Exception.Message); $stageOk = $false }`,
        `  }`,
        `  if (-not $stageOk) {`,
        `    Note 'app apply failed during staging; installed tree untouched; keeping payload for retry'`,
        `    try { Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction Stop } catch { Note ("app stage cleanup failed: " + $_.Exception.Message) }`,
        `  } else {`,
        // 旧树整目录换名到备份区。备份没完成时绝不动已安装树。
        `    if (Test-Path -LiteralPath $appDst) {`,
        `      try { Invoke-ApkstartAppBackup $appDst $backupRoot; $hasBackup = $true } catch { Note ("app backup failed: " + $_.Exception.Message) }`,
        `    }`,
        `    if ((Test-Path -LiteralPath $appDst) -and (-not $hasBackup)) {`,
        `      Note 'app backup did not complete; installed tree untouched; keeping payload for retry'`,
        `      try { Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction Stop } catch { Note ("app stage cleanup failed: " + $_.Exception.Message) }`,
        // 备份没成功时，失败点可能留下空目录；只删「确实为空」的备份，
        // 有任何字节就保留 —— 那可能是唯一可恢复来源。
        `      if (Test-Path -LiteralPath $backupRoot) {`,
        `        try {`,
        `          $left = @(Get-ChildItem -LiteralPath $backupRoot -Recurse -Force -ErrorAction Stop)`,
        `          if ($left.Count -eq 0) { Remove-Item -LiteralPath $backupRoot -Force -ErrorAction Stop }`,
        `          else { Note ("partial backup left at " + $backupRoot + " with " + $left.Count + " entries") }`,
        `        } catch { Note ("backup cleanup failed: " + $_.Exception.Message) }`,
        `      }`,
        `    } else {`,
        `      try { Invoke-ApkstartAppCommit $stageRoot $appDst; $changed = $true; Note 'app tree committed: staged bytes moved into place' } catch { Note ("app commit failed: " + $_.Exception.Message) }`,
        `      $newOk = $false`,
        `      if ($changed) {`,
        `        try { Invoke-ApkstartAppVerify $appDst ${psq(job.version)} $newManifest | Out-Null; $newOk = $true }`,
        `        catch { Note ("app post-commit verification FAILED: " + $_.Exception.Message) }`,
        `      }`,
        `      if ($newOk) {`,
        `        $applyOk = $true`,
        `        Note ("app apply verified: " + $files.Count + " files committed with SHA256 verification")`,
        `        try { Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction Stop } catch { Note ("app backup cleanup failed: " + $_.Exception.Message) }`,
        `        try { Remove-Item -LiteralPath (Join-Path $src '.apkstart-ready') -Force -ErrorAction Stop } catch { }`,
        `        try { Remove-Item -LiteralPath $src -Recurse -Force -ErrorAction Stop } catch { Note ("app payload cleanup failed: " + $_.Exception.Message) }`,
        `        try { Remove-Item -LiteralPath $versionDir -Recurse -Force -ErrorAction Stop } catch { Note ("version dir cleanup failed: " + $_.Exception.Message + "; residual path " + $versionDir) }`,
        `      } else {`,
        `        Note 'app apply failed after changing installed tree; restoring verified backup'`,
        `        $restoreOk = $true`,
        `        if ($changed -or $hasBackup) {`,
        `          if (Test-Path -LiteralPath $appDst) { try { Remove-Item -LiteralPath $appDst -Recurse -Force -ErrorAction Stop } catch { Note ("changed app tree removal FAILED: " + $_.Exception.Message); $restoreOk = $false } }`,
        `          if ($hasBackup) { try { Invoke-ApkstartAppRestoreMove $backupRoot $appDst } catch { Note ("app restore move FAILED: " + $_.Exception.Message); $restoreOk = $false } }`,
        `        } else {`,
        `          Note 'app commit never started; installed tree unchanged'`,
        `        }`,
        `        if ($restoreOk) {`,
        `          if ($hasBackup) { $oldIntact = Test-ApkstartTree $appDst $oldManifest $oldVersion } else { $oldIntact = (-not (Test-Path -LiteralPath $appDst)) }`,
        `          if (-not $oldIntact) { Note 'app restore byte verification FAILED; install state uncertain'; $restoreOk = $false }`,
        `        }`,
        `        if (-not $restoreOk) { $rollbackFailed = $true; Note 'app rollback FAILED; install state uncertain' }`,
        `        else { Note 'app rollback verified: pre-change bytes restored' }`,
        `      }`,
        `    }`,
        `  }`,
        `}`,
        `if (-not $applyOk) {`,
        // 增量应用真失败了：下次启动强制走完整包，避免重放同一个坏载荷，
        // 同时保留载荷/归档/版本目录供续做与诊断（恢复失败时尤其不能删）。
        `  try { New-Item -ItemType File -Force -Path $forceFull | Out-Null } catch { Note ("force-full marker failed: " + $_.Exception.Message) }`,
        `  Note 'app apply failed; keeping payload and version dir for diagnosis'`,
        `  if ((-not $rollbackFailed) -and (-not $changed)) {`,
        `    $unchanged = $true`,
        `    if (Test-Path -LiteralPath $appDst) { try { $unchanged = Test-ApkstartTree $appDst $oldManifest $oldVersion } catch { $unchanged = $false } }`,
        `    if ($unchanged) { Note 'installed tree verified unchanged; old-version relaunch allowed' }`,
        `    else { Note 'installed tree does not match pre-change bytes; suppressing relaunch'; $rollbackFailed = $true }`,
        `  }`,
        `}`,
      );
    } else {
      lines.push(
        `$installer = ${psq(job.payload)}`,
        `$versionDir = ${psq(versionDir)}`,
        `Note 'run installer'`,
        `$installerOk = $false`,
        // 安装器只启动一次，绝不盲目重试。NSIS 静默安装的约定成功码是 0；
        // null/缺失退出码和任何非 0 都按失败处理，不能继续做成功清理。
        `try {`,
        `  $p = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru -Wait -ErrorAction Stop`,
        `  if ($null -eq $p) { Note 'installer start returned no process object; treating as failure' }`,
        `  else {`,
        `    $code = $p.ExitCode`,
        `    if ($null -eq $code) { Note 'installer exit code missing; treating as failure' }`,
        `    elseif ($code -eq 0) { $installerOk = $true; Note 'installer exit 0' }`,
        `    else { Note ("installer reported failure exit " + $code) }`,
        `  }`,
        `} catch { Note ("installer start failed: " + $_.Exception.Message) }`,
        `Start-Sleep -Milliseconds 800`,
        `if ($installerOk) {`,
        `  $applyOk = $true`,
        `  Note 'installer reported success; installed app health is not verified'`,
        `  try { Remove-Item -LiteralPath $versionDir -Recurse -Force -ErrorAction Stop } catch { Note ("version dir cleanup failed: " + $_.Exception.Message) }`,
        `} else {`,
        // 安装器失败可能已经改了一部分安装目录；此时自动重启等于把用户带进
        // 一个未验证的安装状态。保留载荷/版本目录供诊断，绝不自动拉起。
        `  $relaunchAllowed = $false`,
        `  $relaunchSkipReason = 'installer did not report success; install may be partially modified'`,
        `  Note 'installer did not report success; keeping payload for diagnosis; relaunch suppressed'`,
        `}`,
      );
    }

    lines.push(
      // 重启只是「请求启动」，进程创建成功不等于应用健康；helper 用不同退出码
      // 区分「替换/安装成功但重启失败」(2) 和「替换/安装失败」(1)，回滚失败为 (3)。
      `if ($rollbackFailed) { $relaunchAllowed = $false; $relaunchSkipReason = 'rollback failed; install state is uncertain' }`,
      `if ((-not $relaunchAllowed) -and ($relaunchSkipReason -eq '')) { $relaunchSkipReason = 'install state is not verified' }`,
      `if (-not $relaunchAllowed) {`,
      `  Note ("relaunch skipped: " + $relaunchSkipReason)`,
      `} elseif (Test-Path -LiteralPath ${psq(exe)}) {`,
      `  try {`,
      `    Start-Process -FilePath ${psq(exe)} -WorkingDirectory ${psq(dir)} -ErrorAction Stop`,
      `    $relaunchOk = $true`,
      `    Note 'relaunched via Start-Process'`,
      `  } catch {`,
      `    Note ("Start-Process failed: " + $_.Exception.Message + "; fallback to cmd start")`,
      `    try {`,
      `      Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','start','""',${psq(exe)} -WorkingDirectory ${psq(dir)} -WindowStyle Hidden -ErrorAction Stop`,
      `      $relaunchOk = $true`,
      `      Note 'relaunched via cmd start'`,
      `    } catch { Note ("cmd start failed: " + $_.Exception.Message) }`,
      `  }`,
      `} else { Note 'relaunch skipped: exe missing' }`,
      `if ($applyOk -and $relaunchOk) { $exitCode = 0 }`,
      `elseif ($applyOk) { $exitCode = 2 }`,
      `else { $exitCode = 1 }`,
      `if ($rollbackFailed) { $exitCode = 3 }`,
      `Note ("updater done applyOk=" + $applyOk + " relaunchOk=" + $relaunchOk + " rollbackFailed=" + $rollbackFailed + " exit=" + $exitCode)`,
      `Start-Sleep -Milliseconds 400`,
      `exit $exitCode`,
    );

    const script = lines.join('\r\n');
    fs.writeFileSync(path.join(this.updateDir, 'apply.log.ps1'), script, 'utf8');
    // 真正交给 PowerShell 的脚本去掉行首缩进并只用 LF：PowerShell 不以缩进
    // 表达语义，这样每行节省几个字符。排障用的 apply.log.ps1 仍保留可读缩进。
    const execScript = lines.map((l) => l.replace(/^[ \t]+/, '')).join('\n');
    if (opts.spawn === false) return execScript;
    // 脚本本体（~12k 字符）不再进命令行：U+FEFF 开头的 UTF-8 脚本写入 update
    // 目录下的唯一文件，命令行只传一段定长 bootstrap（文件路径 + SHA-256）。
    // bootstrap 一次性读字节、先校验摘要再从同一 Buffer 解码执行；读与执行
    // 之间没有第二次按路径读取，运行前被替换的文件无法绕过校验。PowerShell
    // 5.1 以 .ps1 文件直接运行时需要 BOM；这里显式写入并校验同一份字节。
    const helperFile = path.join(this.updateDir, `apply-helper-${uniqueSuffix()}.ps1`);
    const helperBytes = Buffer.from(`\uFEFF${execScript}`, 'utf8');
    const helperDigest = crypto.createHash('sha256').update(helperBytes).digest('hex');
    fs.writeFileSync(helperFile, helperBytes);
    const bootstrap = buildApplyBootstrap(helperFile, helperDigest);
    // -EncodedCommand 走 UTF-16LE base64：中文路径不会被 GBK 解码搞坏。
    const b64 = Buffer.from(bootstrap, 'utf16le').toString('base64');
    // 命令行上限 32767 字符（含 exe 路径与参数）。bootstrap 只随路径长度变化
    // （<2k 字符），超过 16000 说明调度方式又被改回去了，诚实报错而不是让
    // spawn 静默失败——调用方不会误以为替换已开始。
    if (b64.length > 16000) {
      try { fs.unlinkSync(helperFile); } catch (_) { }
      throw new Error(`更新助手调度命令编码后 ${b64.length} 字符，超过 PowerShell 调度上限，本次替换未开始`);
    }
    const ps = opts.powershellPath || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // 这里**不能**用 detached：某些安全软件 / 沙箱策略会直接拦掉「分离的控制台进程」，
    // 表现为脚本一声不响地根本没跑（更新界面卡在「正在替换程序并重启」）。
    // Windows 上父进程退出并不会杀掉普通子进程，所以用「普通子进程 + unref」同样能在
    // 我们退出之后继续干活，兼容性还更好。
    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-EncodedCommand', b64,
    ], { stdio: 'ignore', windowsHide: true });
    // [R4-fix] 助手调度失败必须如实抛出：spawn 找不到可执行文件时 pid 为空、
    // 错误走异步 error 事件 —— 这里同步发现并抛错，调用方才能做到「不声称
    // 成功、不计划重启、释放更新门闩」。error 监听只为吞掉异步事件，防止
    // 未处理异常击穿进程；调度已失败时该事件没有额外信息。
    if (!child.pid) {
      child.on('error', () => {});
      try { fs.unlinkSync(helperFile); } catch (_) { }
      throw new Error('更新助手（PowerShell）调度失败，本次替换未开始');
    }
    child.unref();
    return true;
  }

  /** 打不开 UI 的场景（或没有可自动安装的资产）时，把发布页丢给浏览器 */
  static repoUrl() {
    return `https://github.com/${OWNER}/${REPO}/releases`;
  }
}

module.exports = { Updater, cmpVer, OWNER, REPO, findUninstaller };
