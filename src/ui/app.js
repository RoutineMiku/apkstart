'use strict';

const api = window.apkstart;
const $ = (id) => document.getElementById(id);

const state = {
  apps: [],
  settings: null,
  status: null,
  filter: '',
  installing: false,
  setupBusy: null,
  setupDismissed: false,
  menuPkg: null,
};

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function initialOf(label) {
  const t = String(label || '?').trim();
  return (t[0] || '?').toUpperCase();
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  if (d < 86400000 * 30) return `${Math.floor(d / 86400000)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/**
 * 迷你 toast
 */
function toast({ title, body = '', type = 'info', progress = null, sticky = false, spinner = false }) {
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.innerHTML = `
    <div class="t-title">
      ${spinner ? '<span class="spinner"></span>' : ''}
      <span class="t-title-text">${esc(title)}</span>
    </div>
    <div class="t-body">${esc(body)}</div>
    ${progress === null ? '' : '<div class="bar"><i></i></div>'}
  `;
  $('toastWrap').appendChild(el);

  const dismiss = () => {
    el.style.transition = 'opacity .18s, transform .18s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => el.remove(), 200);
  };

  const ctl = {
    el, dismiss,
    update({ title: t2, body: b2, progress: p2, type: ty } = {}) {
      if (t2 !== undefined) el.querySelector('.t-title-text').textContent = t2;
      if (b2 !== undefined) el.querySelector('.t-body').textContent = b2;
      if (p2 !== undefined && el.querySelector('.bar i')) {
        el.querySelector('.bar i').style.width = `${Math.max(2, Math.min(100, p2))}%`;
      }
      if (ty === 'error') el.classList.add('error');
      if (ty === 'ok') {
        el.querySelector('.spinner')?.remove();
        el.classList.remove('error');
      }
    },
  };

  if (!sticky) setTimeout(dismiss, type === 'error' ? 6000 : 3200);
  return ctl;
}

/* ---------------- 渲染 ---------------- */

function visibleApps() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.apps;
  return state.apps.filter((a) => (
    a.label.toLowerCase().includes(q)
    || a.package.toLowerCase().includes(q)
  ));
}

function renderGrid() {
  const apps = visibleApps();
  const grid = $('grid');
  const empty = $('empty');

  const hasAny = state.apps.length > 0;
  grid.classList.toggle('hidden', apps.length === 0);
  empty.classList.toggle('hidden', apps.length > 0);

  if (!hasAny) {
    const s = state.status;
    $('emptyHint').textContent = s && s.adbOk === false
      ? '首次使用：请先在设置里指定 adb 位置或系统镜像，然后回来安装应用。'
      : '提示：所有应用共享同一个 Android 运行时，所以第二个应用的启动几乎是瞬时的。';
    grid.innerHTML = '';
    return;
  }

  grid.innerHTML = apps.map((a) => `
    <div class="card" data-pkg="${esc(a.package)}" title="${esc(a.label)} · ${esc(a.package)}">
      ${a.pinned ? '<span class="pin">★</span>' : ''}
      ${a.running ? '<span class="badge-run" title="正在运行"></span>' : ''}
      <div class="icon">
        ${a.iconUrl
          ? `<img src="${esc(a.iconUrl)}" alt="" draggable="false" />`
          : `<div class="fallback" style="background:${esc(a.accent || '#9aa6b2')}">${esc(initialOf(a.label))}</div>`}
      </div>
      <div class="name">${esc(a.label)}</div>
      <div class="meta">${a.running ? '运行中' : `v${esc(a.versionName)}${a.lastLaunchAt ? ' · ' + relTime(a.lastLaunchAt) : ''}`}</div>
      <div class="open-hint">${a.running ? '切换到前台' : '打开'}</div>
    </div>
  `).join('');
}

/* ---------------- 数据刷新 ---------------- */

async function refreshApps() {
  try {
    state.apps = await api.listApps();
    renderGrid();
    updateStats();
  } catch (e) {
    console.error(e);
  }
}

function updateStats() {
  const n = state.apps.length;
  $('statusStats').textContent = n ? `${n} 个应用` : '暂无应用';
}

async function refreshStatus() {
  try {
    state.status = await api.runtimeStatus();
    const s = state.status;
    const dot = $('statusDot');
    const text = $('statusText');
    const tag = $('engineTag');

    if (!s.adbOk) {
      dot.className = 'dot err';
      text.textContent = '运行时未部署 —— 点击右上角「运行时」开始一键部署';
      tag.textContent = '需要部署';
      tag.className = 'brand-tag';
    } else if (s.deviceOnline) {
      dot.className = 'dot ok';
      text.textContent = `运行时已就绪 · Android ${s.android || '?'}${s.freeform ? ' · 独立窗口已启用' : ''}`;
      tag.textContent = `Android ${s.android || ''}`.trim();
      tag.className = 'brand-tag ok';
    } else if (s.vmStarting) {
      dot.className = 'dot';
      text.textContent = '运行时正在启动…';
      tag.textContent = '启动中';
      tag.className = 'brand-tag';
    } else {
      dot.className = 'dot';
      text.textContent = s.installed
        ? '运行时待机（安装或打开应用时会自动拉起）'
        : '运行时尚未安装 Android 系统 —— 点击右上角「运行时」继续';
      tag.textContent = s.installed ? '待机' : '待安装';
      tag.className = 'brand-tag';
    }
    $('statusDevice').textContent = s.deviceOnline ? '127.0.0.1:5555' : '';

    renderSetup(s);
  } catch (e) {
    $('statusText').textContent = `状态检查失败：${e.message}`;
  }
}

/* ---------------- 运行时部署向导 ---------------- */

function showSetup(on) {
  $('setupView').hidden = !on;
  $('content').hidden = !!on;
  if (!on) $('setupGuide').hidden = true;
}

function fmtGB(n) { return n ? `${(n / 1073741824).toFixed(2)} GB` : ''; }

function stepRow(opt) {
  const cls = ['step'];
  if (opt.done) cls.push('done');
  if (opt.busy) cls.push('busy');
  return `
    <div class="${cls.join(' ')}" data-step="${opt.key}">
      <div class="idx">${opt.done ? '✓' : opt.index}</div>
      <div class="body">
        <div class="t">${esc(opt.title)}${opt.tag ? `<span class="tag ${opt.req ? 'req' : ''}">${esc(opt.tag)}</span>` : ''}</div>
        <div class="d" data-desc>${esc(opt.desc)}</div>
        <div class="bar"><i data-bar></i></div>
      </div>
      <div class="act">${opt.actions || ''}</div>
    </div>`;
}

function renderSetup(s) {
  if (!s) return;
  const env = s.env || {};
  const hv = env.hypervisor || {};
  const needSetup = !!s.needsSetup;

  // 自动进入部署页：还没装过应用、且运行时未就绪
  if (needSetup && !s.ready && !state.setupDismissed && state.apps.length === 0 && !state.setupBusy) {
    showSetup(true);
  }

  $('setupHv').textContent = hv.whpx ? 'WHPX 硬件加速：已启用' : 'WHPX：未启用（软件模拟）';
  $('setupHv').className = `setup-hv ${hv.whpx ? 'ok' : ''}`;
  $('setupHv').title = hv.note || '';

  const isoDone = !!(env.iso && env.iso.ok);
  const diskDone = !!(env.disk && env.disk.ok);
  const installed = !!s.installed;
  const busy = state.setupBusy;

  const steps = [
    {
      key: 'adb',
      index: 1,
      title: 'adb 工具链',
      tag: '必需',
      req: true,
      done: !!(env.adb && env.adb.ok),
      busy: busy === 'adb',
      desc: env.adb && env.adb.ok
        ? `adb ${env.adb.version} · ${env.adb.path}`
        : 'Android 调试桥，ApkStart 用它安装/启动应用（约 8 MB）',
      actions: env.adb && env.adb.ok ? '' : '<button class="btn ghost sm" data-act="adb">下载</button>',
    },
    {
      key: 'qemu',
      index: 2,
      title: 'QEMU 虚拟机引擎',
      tag: '必需',
      req: true,
      done: !!(env.qemu && env.qemu.ok),
      busy: busy === 'qemu',
      desc: env.qemu && env.qemu.ok
        ? `QEMU ${env.qemu.version} · ${env.qemu.path}`
        : 'ApkStart 自带的虚拟机引擎（约 200 MB，静默安装，不污染系统）',
      actions: env.qemu && env.qemu.ok ? '' : '<button class="btn ghost sm" data-act="qemu">下载</button>',
    },
    {
      key: 'iso',
      index: 3,
      title: 'Android 系统镜像',
      tag: '必需',
      req: true,
      done: isoDone,
      busy: busy === 'iso',
      desc: isoDone
        ? `已就绪 ${fmtGB(env.iso.size)} · ${env.iso.path}`
        : 'Android-x86 9.0-r2（约 900 MB）；也可以导入本机已有的 ISO/IMG',
      actions: isoDone
        ? ''
        : '<button class="btn ghost sm" data-act="iso">下载</button><button class="btn ghost sm" data-act="isoImport">导入</button>',
    },
    {
      key: 'disk',
      index: 4,
      title: '系统虚拟磁盘',
      tag: '必需',
      req: true,
      done: diskDone,
      busy: busy === 'disk',
      desc: diskDone
        ? `${fmtGB(env.disk.size)} · ${env.disk.path}`
        : `${store_getDiskSize()} GB 稀疏磁盘，只占实际使用空间；也可以导入已装好 Android 的磁盘镜像`,
      actions: diskDone
        ? ''
        : '<button class="btn ghost sm" data-act="disk">创建</button><button class="btn ghost sm" data-act="diskImport">导入</button>',
    },
    {
      key: 'install',
      index: 5,
      title: '安装 Android 系统',
      tag: installed ? '已完成' : '一次性操作',
      done: installed,
      desc: installed
        ? `已完成${s.android ? ` · 当前 Android ${s.android}` : ''}`
        : '在虚拟机窗口里走 6 步安装（ApkStart 会给出逐步提示），装好后永久免装',
      actions: installed
        ? `<button class="btn ghost sm" data-act="vmStart">${s.deviceOnline ? '已启动' : '启动运行时'}</button>
           <button class="btn ghost sm" data-act="vmStop">停止</button>`
        : `<button class="btn primary sm" data-act="install" ${isoDone && diskDone ? '' : 'disabled'}>开始安装</button>`,
    },
  ];

  $('setupSteps').innerHTML = steps.map(stepRow).join('');
  $('btnDeployAll').disabled = !!busy;
  $('btnDeployAll').textContent = busy ? '部署中…' : (installed ? '检查更新' : '一键部署');
  $('setupNote').textContent = hv.note && !hv.whpx ? '提示：未启用 WHPX 时首次启动较慢（纯软件模拟）' : '';
}

function store_getDiskSize() {
  return (state.settings && state.settings.runtime && state.settings.runtime.diskSizeGB) || 24;
}

function setStepBusy(key, on) {
  state.setupBusy = on ? key : null;
  const row = $('setupSteps').querySelector(`[data-step="${key}"]`);
  if (row) {
    row.classList.toggle('busy', !!on);
    if (on) {
      row.querySelector('[data-bar]').style.width = '3%';
    }
  }
}

function updateStepProgress(component, p) {
  if (!component) return;
  const row = $('setupSteps').querySelector(`[data-step="${component}"]`);
  if (!row) return;
  if (p.percent !== undefined) {
    const bar = row.querySelector('[data-bar]');
    if (bar) bar.style.width = `${Math.max(3, Math.min(100, p.percent))}%`;
  }
  if (p.message) {
    const d = row.querySelector('[data-desc]');
    if (d) d.textContent = p.message;
  }
}

async function deployAll() {
  const steps = ['adb', 'qemu', 'iso', 'disk'];
  for (const key of steps) {
    const env = (state.status && state.status.env) || {};
    const done = key === 'adb' ? env.adb && env.adb.ok
      : key === 'qemu' ? env.qemu && env.qemu.ok
        : key === 'iso' ? env.iso && env.iso.ok
          : env.disk && env.disk.ok;
    if (done) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await runStep(key);
    if (!r.ok) {
      toast({ title: `${key} 部署失败`, body: r.error, type: 'error', sticky: true });
      return;
    }
  }
  await refreshStatus();
  toast({ title: '运行时组件已就绪', body: '下一步：点击「开始安装」，在虚拟机窗口里完成 Android 安装。', type: 'ok' });
}

async function runStep(key) {
  if (state.setupBusy) return { ok: false, error: '已有部署任务进行中' };
  setStepBusy(key, true);
  let r;
  try {
    if (key === 'adb') r = await api.installAdb();
    else if (key === 'qemu') r = await api.installQemu();
    else if (key === 'iso') r = await api.downloadIso();
    else if (key === 'disk') r = await api.createDisk(store_getDiskSize());
    else r = { ok: false, error: '未知步骤' };
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  setStepBusy(key, false);
  await refreshStatus();
  return r;
}

async function startInstall() {
  const r = await api.startInstaller();
  if (!r.ok) {
    toast({ title: '无法启动安装环境', body: r.error, type: 'error', sticky: true });
    return;
  }
  $('setupGuide').hidden = false;
  $('setupGuide').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast({ title: '虚拟机窗口已打开', body: '按下方 6 步完成安装；装好后点「我已安装完成」。', type: 'ok', sticky: true });
}

async function markInstalled() {
  await api.markInstalled();
  await api.runtimeStop();
  $('setupGuide').hidden = true;
  await refreshStatus();
  toast({ title: '安装完成，运行时已接管', body: '现在可以直接把 APK 拖进来安装了。', type: 'ok' });
}



/* ---------------- 安装 ---------------- */

async function installFiles(paths) {
  if (!paths || !paths.length) return;
  if (state.installing) {
    toast({ title: '已有安装任务在进行', body: '请等当前应用装完再继续。' });
    return;
  }
  state.installing = true;
  let ok = 0;
  let failed = 0;

  for (const p of paths) {
    try {
      const name = p.split(/[\\/]/).pop();
      const t = toast({ title: `正在安装 ${name}`, body: '解析 APK…', progress: 8, sticky: true, spinner: true });
      const off = api.on('install:progress', (pr) => {
        const pct = { parse: 12, 'parse-done': 24, runtime: 38, install: 62, shortcut: 88, done: 100 }[pr.stage] || 50;
        t.update({ title: pr.meta ? `正在安装 ${pr.meta.label}` : `正在安装 ${name}`, body: pr.message, progress: pct });
      });
      try {
        const r = await api.installApk(p);
        t.update({ title: `${r.app.label} 已安装`, body: r.app.shortcutPath ? '桌面快捷方式已创建，双击即可直接打开。' : '可在应用卡片右键创建桌面快捷方式。', progress: 100, type: 'ok' });
        t.el.querySelector('.spinner')?.remove();
        setTimeout(t.dismiss, 3600);
        if (r.warnings && r.warnings.length) {
          toast({ title: `${r.app.label} 兼容性提示`, body: r.warnings.join(' '), type: 'error', sticky: false });
        }
        ok++;
      } finally {
        off();
      }
    } catch (e) {
      failed++;
      toast({ title: '安装失败', body: e.message, type: 'error' });
    }
  }

  state.installing = false;
  await refreshApps();
  if (ok && !failed) $('search').value = '';
}

/* ---------------- 应用操作 ---------------- */

async function launchApp(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  const t = toast({
    title: `正在打开 ${app ? app.label : pkg}`,
    body: '首次启动需要预热运行时，请稍候…',
    sticky: true,
    spinner: true,
  });
  const r = await api.launch(pkg);
  if (r.ok) {
    t.update({ title: '已启动', body: '应用以独立窗口运行，可在任务栏中找到它。', type: 'ok' });
    setTimeout(t.dismiss, 2200);
    setTimeout(refreshApps, 1200);
  } else {
    t.update({ title: '启动失败', body: r.error, type: 'error' });
    setTimeout(t.dismiss, 6000);
  }
}

async function createShortcut(pkg) {
  try {
    const r = await api.createShortcut(pkg);
    toast({ title: '桌面快捷方式已创建', body: r.path, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: '创建快捷方式失败', body: e.message, type: 'error' });
  }
}

async function uninstall(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  if (!app) return;
  const ok = window.confirm(`确定卸载「${app.label}」？\n\n应用数据会一并被清除，桌面快捷方式也会被删除。`);
  if (!ok) return;
  try {
    await api.uninstall(pkg);
    toast({ title: '已卸载', body: app.label, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: '卸载失败', body: e.message, type: 'error' });
  }
}

/* ---------------- 右键菜单 ---------------- */

const MENU_ITEMS = [
  { key: 'open', label: '打开应用', kbd: 'Enter' },
  { key: 'shortcut', label: '创建桌面快捷方式' },
  { key: 'pin', label: '固定到顶部' },
  { divider: true },
  { key: 'reveal', label: '打开 APK 所在位置' },
  { key: 'clear', label: '清除应用数据' },
  { divider: true },
  { key: 'uninstall', label: '卸载', danger: true },
];

function showMenu(x, y, pkg) {
  const menu = $('ctxmenu');
  state.menuPkg = pkg;
  const app = state.apps.find((a) => a.package === pkg);
  menu.innerHTML = MENU_ITEMS.map((it) => {
    if (it.divider) return '<div class="divider"></div>';
    const label = it.key === 'pin' ? (app && app.pinned ? '取消固定' : '固定到顶部') : it.label;
    return `<div class="item ${it.danger ? 'danger' : ''}" data-act="${it.key}">
      <span>${esc(label)}</span>${it.kbd ? `<span class="k">${it.kbd}</span>` : ''}
    </div>`;
  }).join('');
  menu.classList.add('on');

  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 10)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 10)}px`;
}

function hideMenu() {
  $('ctxmenu').classList.remove('on');
  state.menuPkg = null;
}

async function handleMenu(act) {
  const pkg = state.menuPkg;
  const app = state.apps.find((a) => a.package === pkg);
  hideMenu();
  if (!app) return;
  switch (act) {
    case 'open': return launchApp(pkg);
    case 'shortcut': return createShortcut(pkg);
    case 'pin': return api.pin(pkg, !app.pinned).then(refreshApps);
    case 'reveal': return api.revealApk(pkg);
    case 'clear': {
      if (!window.confirm(`清除「${app.label}」的全部数据？此操作不可撤销。`)) return;
      try {
        await api.clearData(pkg);
        toast({ title: '数据已清除', body: app.label, type: 'ok' });
      } catch (e) {
        toast({ title: '清除失败', body: e.message, type: 'error' });
      }
      return;
    }
    case 'uninstall': return uninstall(pkg);
    default: return undefined;
  }
}

/* ---------------- 设置 ---------------- */

function fillSettings(s) {
  $('setEngineMode').value = s.engine.mode;
  $('setAdbPath').value = s.adbPath || '';
  $('setDevice').value = s.device || '';
  $('setSystemImage').value = s.runtime.isoPath || '';
  $('setMemory').value = s.engine.memoryMB;
  $('setCores').value = s.engine.cores;
  $('setIdle').value = s.engine.idleShutdownMinutes;
  $('setAutoShortcut').checked = !!s.createShortcutOnInstall;
  $('setFreeform').checked = !!s.freeform;
  $('setHideAfterLaunch').checked = !!s.hideAfterLaunch;
  $('setShortcutDir').value = s.shortcutDir || '';
  $('setSharedDir').value = s.sharedDir || '';
  $('setDeviceSharedDir').value = s.deviceSharedDir || '';
}

async function openSettings() {
  state.settings = await api.getSettings();
  fillSettings(state.settings);
  const info = await api.info();
  $('setDataDir').value = info.dataDir;
  const assoc = await api.assocStatus();
  const btn = $('btnAssoc');
  btn.textContent = assoc.registered ? '已关联 · 点击取消' : '未关联 · 点击开启';
  btn.dataset.on = assoc.registered ? '1' : '0';
  $('settingsMask').classList.add('on');
}

function closeSettings() {
  $('settingsMask').classList.remove('on');
}

function bindSettings() {
  const save = async (patch) => {
    state.settings = await api.setSettings(patch);
  };

  $('setEngineMode').addEventListener('change', (e) => save({ engine: { mode: e.target.value } }));
  $('setAdbPath').addEventListener('change', (e) => save({ adbPath: e.target.value.trim() }));
  $('setDevice').addEventListener('change', async (e) => {
    await save({ device: e.target.value.trim() });
    refreshStatus();
  });
  $('setSystemImage').addEventListener('change', (e) => save({ runtime: { isoPath: e.target.value.trim() } }));
  $('setMemory').addEventListener('change', (e) => save({ engine: { memoryMB: Number(e.target.value) || 4096 } }));
  $('setCores').addEventListener('change', (e) => save({ engine: { cores: Number(e.target.value) || 4 } }));
  $('setIdle').addEventListener('change', (e) => save({ engine: { idleShutdownMinutes: Number(e.target.value) || 0 } }));
  $('setAutoShortcut').addEventListener('change', (e) => save({ createShortcutOnInstall: e.target.checked }));
  $('setFreeform').addEventListener('change', (e) => save({ freeform: e.target.checked }));
  $('setHideAfterLaunch').addEventListener('change', (e) => save({ hideAfterLaunch: e.target.checked }));
  $('setShortcutDir').addEventListener('change', (e) => save({ shortcutDir: e.target.value.trim() }));
  $('setSharedDir').addEventListener('change', (e) => save({ sharedDir: e.target.value.trim() }));
  $('setDeviceSharedDir').addEventListener('change', (e) => save({ deviceSharedDir: e.target.value.trim() }));

  $('btnOpenShared').addEventListener('click', () => api.openSharedDir());
  $('btnOpenData').addEventListener('click', async () => {
    const info = await api.info();
    window.open(`file:///${info.dataDir.replace(/\\/g, '/')}`);
  });

  $('btnProbe').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = '探测中…';
    const found = await api.runtimeProbe();
    if (!found.length) {
      el.textContent = '未发现已运行的运行时';
      return;
    }
    el.textContent = `发现：${found.map((f) => f.name).join('、')}`;
    await api.setSettings({ device: found[0].serial });
    $('setDevice').value = found[0].serial;
    refreshStatus();
  });

  $('btnRuntimeStart').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = '正在启动…';
    const r = await api.runtimeStart();
    el.textContent = r.ok ? `已就绪：${r.engine}` : `启动失败：${r.error}`;
    refreshStatus();
  });

  $('btnRuntimeStop').addEventListener('click', async () => {
    await api.runtimeStop();
    $('probeResult').textContent = '已停止内置虚拟机';
    refreshStatus();
  });

  $('btnAssoc').addEventListener('click', async () => {
    const btn = $('btnAssoc');
    if (btn.dataset.on === '1') {
      await api.assocUnregister();
      btn.textContent = '未关联 · 点击开启';
      btn.dataset.on = '0';
      toast({ title: '.apk 关联已取消' });
    } else {
      const r = await api.assocRegister();
      btn.textContent = '已关联 · 点击取消';
      btn.dataset.on = '1';
      toast({ title: '.apk 关联已开启', body: r.ok ? '现在双击 APK 会直接安装到 ApkStart' : '', type: r.ok ? 'ok' : 'error' });
    }
  });
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('btnSettings').addEventListener('click', openSettings);
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnDoneSettings').addEventListener('click', closeSettings);
  $('settingsMask').addEventListener('click', (e) => {
    if (e.target === $('settingsMask')) closeSettings();
  });

  // 运行时部署
  $('btnRuntime').addEventListener('click', async () => {
    state.setupDismissed = false;
    showSetup(true);
    await refreshStatus();
  });
  $('btnDeployAll').addEventListener('click', deployAll);
  $('btnMarkInstalled').addEventListener('click', markInstalled);
  $('btnGuideClose').addEventListener('click', () => { $('setupGuide').hidden = true; });
  $('btnSetupAdvanced').addEventListener('click', () => openSettings());

  $('setupSteps').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'adb' || act === 'qemu' || act === 'iso' || act === 'disk') {
      const r = await runStep(act);
      if (!r.ok) toast({ title: '操作失败', body: r.error, type: 'error', sticky: true });
      return;
    }
    if (act === 'isoImport') {
      const r = await api.importIso();
      if (r.ok) { toast({ title: '系统镜像已导入', body: r.path, type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: '导入失败', body: r.error, type: 'error' });
      return;
    }
    if (act === 'diskImport') {
      const r = await api.importDisk();
      if (r.ok) { toast({ title: '虚拟磁盘已导入', body: '可直接启动运行时', type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: '导入失败', body: r.error, type: 'error' });
      return;
    }
    if (act === 'install') { await startInstall(); return; }
    if (act === 'vmStart') {
      const t = toast({ title: '正在启动运行时…', body: '首次启动需要引导 Android 系统', sticky: true, spinner: true });
      const r = await api.runtimeStart();
      if (r.ok) { t.update({ title: '运行时已就绪', type: 'ok' }); setTimeout(t.dismiss, 2200); }
      else t.update({ title: '启动失败', body: r.error, type: 'error' });
      refreshStatus();
      return;
    }
    if (act === 'vmStop') {
      await api.runtimeStop();
      toast({ title: '运行时会话已结束' });
      refreshStatus();
    }
  });

  const pick = async () => {
    const files = await api.pickApk();
    if (files.length) installFiles(files);
  };
  $('btnInstall').addEventListener('click', pick);
  $('btnInstall2').addEventListener('click', pick);
  $('btnShare').addEventListener('click', async () => {
    await api.syncShared();
    api.openSharedDir();
  });

  $('search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderGrid();
  });

  $('grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) launchApp(card.dataset.pkg);
  });

  $('grid').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, card.dataset.pkg);
  });

  $('grid').addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card) createShortcut(card.dataset.pkg);
  });

  $('ctxmenu').addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (item) handleMenu(item.dataset.act);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxmenu')) hideMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
      closeSettings();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search').focus();
    }
  });

  // 拖放安装
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('dropzone').classList.add('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropzone').classList.remove('on');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').classList.remove('on');
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files
      .map((f) => { try { return api.pathForFile(f); } catch (_) { return null; } })
      .filter((p) => p && /\.apk$/i.test(p));
    if (paths.length) installFiles(paths);
    else toast({ title: '只能拖入 .apk 文件', type: 'error' });
  });

  // 主进程事件
  api.on('install:error', (p) => toast({ title: '安装失败', body: p.message, type: 'error' }));
  api.on('toast', (p) => toast({ title: p.message, type: p.type === 'error' ? 'error' : 'info' }));
  api.on('app:launched', () => setTimeout(refreshApps, 800));
  api.on('runtime:log', (m) => console.log('[runtime]', m));
  api.on('ui:navigate', (v) => {
    if (v === 'settings') openSettings();
    if (v === 'setup') { state.setupDismissed = false; showSetup(true); refreshStatus(); }
  });
  api.on('provision:progress', (p) => updateStepProgress(p.component, p));
}

/* ---------------- 启动 ---------------- */

async function init() {
  bindEvents();
  bindSettings();
  state.settings = await api.getSettings();
  await refreshStatus();
  await refreshApps();
  setInterval(refreshStatus, 6000);
  setInterval(refreshApps, 15000);
}

init().catch((e) => {
  console.error(e);
  toast({ title: '初始化失败', body: e.message, type: 'error', sticky: true });
});
