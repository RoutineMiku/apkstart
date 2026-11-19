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
  menuPkg: null,
  locale: 'en',
};

const t = (key, params, loc) => {
  if (api && api.t) return api.t(key, params, loc || state.locale);
  if (window.apkstartI18n) return window.apkstartI18n.t(key, params, loc || state.locale);
  return key;
};

// Synchronously apply initial language to avoid any Chinese flash
try {
  const _i18n = window.apkstartI18n || (api && api.i18n);
  if (_i18n) {
    const _initLoc = _i18n.getLocale() || 'en';
    state.locale = _initLoc;
    _i18n.translateDOM(document, _initLoc);
    document.documentElement.lang = _initLoc;
    document.documentElement.dir = (_initLoc === 'ar' ? 'rtl' : 'ltr');
  }
} catch (_) {}


/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function initialOf(label) {
  const txt = String(label || '?').trim();
  return (txt[0] || '?').toUpperCase();
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return t('time.justNow');
  if (d < 3600000) return t('time.minutesAgo', { n: Math.floor(d / 60000) });
  if (d < 86400000) return t('time.hoursAgo', { n: Math.floor(d / 3600000) });
  if (d < 86400000 * 30) return t('time.daysAgo', { n: Math.floor(d / 86400000) });
  const locCode = state.locale === 'zh' ? 'zh-CN' : (state.locale === 'ar' ? 'ar' : 'en-US');
  return new Date(ts).toLocaleDateString(locCode);
}

/**
 * 迷你 toast
 *
 * 同一类消息做去重 + 数量上限：
 * 安装失败时里面有「运行时启动日志」在持续推送，以前每条都新建一个 toast，
 * 于是屏幕上会不停叠加同一条错误，看起来像「失败信息一直循环」。
 */
let _toastSeq = 0;
function toast({ title, body = '', type = 'info', progress = null, sticky = false, spinner = false }) {
  const wrap = $('toastWrap');
  // ① 去重：同样的标题 + 正文（4 秒内）只刷新那一条，不叠加
  const key = `${title}|${body}`;
  const dup = [...wrap.children].find((n) => n.dataset.key === key && Date.now() - Number(n.dataset.at || 0) < 4000);
  if (dup) {
    dup.dataset.at = String(Date.now());
    return {
      el: dup,
      dismiss: () => dup.remove(),
      update: ({ title: t2, body: b2 } = {}) => {
        if (t2 !== undefined) dup.querySelector('.t-title-text').textContent = t2;
        if (b2 !== undefined) dup.querySelector('.t-body').textContent = b2;
      },
    };
  }
  // ② 上限：同时最多 4 条，超出先挤掉最旧的
  while (wrap.children.length >= 4) wrap.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.dataset.key = key;
  el.dataset.at = String(Date.now());
  el.dataset.seq = String(++_toastSeq);
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

/* ---------------- 内置手册 ---------------- */

/** 打开内置手册；传故障信息时由主进程映射到对应章节 */
function openManual(payload) {
  if (!api || typeof api.openManual !== 'function') return Promise.resolve(null);
  return api.openManual(payload || { topic: 'overview' }).catch(() => null);
}

/** 自动检测问题 → 对应教程。reason 只影响主进程的去重策略。 */
function openManualForIssue(issue, reason = 'clicked') {
  if (!issue) return openManual({ topic: 'overview', reason });
  return openManual({
    issue: issue.code,
    title: issue.title,
    detail: issue.detail,
    reason,
  });
}

/** 安装/运行原始报错 → 对应教程 */
function openManualForError(message, reason = 'install-failed') {
  return openManual({ error: message, reason });
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
      ? t('empty.hintFirst')
      : t('empty.hintShared');
    grid.innerHTML = '';
    return;
  }

  // 末尾放一块「添加应用」虚线卡片。
  // 目的不只是好看：应用少的时候下面是一大片空白，用户不知道该干什么；
  // 这块卡片把「还能拖 APK 进来」这件事直接摆在眼前，也顺手填掉了空白。
  grid.innerHTML = apps.map((a) => `
    <div class="card" data-pkg="${esc(a.package)}" title="${esc(a.label)} · ${esc(a.package)}">
      ${a.pinned ? '<span class="pin">★</span>' : ''}
      ${a.running ? `<span class="badge-run" title="${esc(t('card.runningBadge'))}"></span>` : ''}
      <div class="icon">
        ${a.iconUrl
          ? `<img src="${esc(a.iconUrl)}" alt="" draggable="false" />`
          : `<div class="fallback" style="background:${esc(a.accent || '#9aa6b2')}">${esc(initialOf(a.label))}</div>`}
      </div>
      <div class="name">${esc(a.label)}</div>
      <div class="meta">${a.running ? esc(t('card.running')) : `v${esc(a.versionName)}${a.lastLaunchAt ? ' · ' + relTime(a.lastLaunchAt) : ''}`}</div>
      <div class="open-hint">${a.running ? esc(t('card.bringToFront')) : esc(t('card.open'))}</div>
    </div>
  `).join('') + `
    <div class="card card-add" id="cardAdd" role="button" tabindex="0" title="${esc(t('card.addTitle'))}">
      <div class="add-plus" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round"><path d="M12 6v12"/><path d="M6 12h12"/></svg>
      </div>
      <div class="name">${esc(t('card.addName'))}</div>
      <div class="meta">${esc(t('card.addMeta'))}</div>
    </div>
  `;
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
  $('statusStats').textContent = n ? t('status.appCount', { n }) : t('status.noApps');
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
      text.textContent = t('status.notDeployed');
      tag.textContent = t('status.tagNeedDeploy');
      tag.className = 'brand-tag';
    } else if (s.deviceOnline) {
      dot.className = 'dot ok';
      text.textContent = s.freeform ? t('status.readyFreeform', { android: s.android || '' }) : t('status.ready', { android: s.android || '' });
      tag.textContent = `Android ${s.android || ''}`.trim();
      tag.className = 'brand-tag ok';
    } else if (s.phase === 'booting' || s.vmStarting) {
      dot.className = 'dot warn';
      text.textContent = t('status.booting');
      tag.textContent = t('status.tagBooting');
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'accel') {
      dot.className = 'dot warn';
      text.textContent = t('status.accelSoftware');
      tag.textContent = t('status.tagSoftware');
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'sysimg') {
      dot.className = 'dot err';
      text.textContent = t('status.missingSysimg');
      tag.textContent = t('status.tagDownloadImg');
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'emulator') {
      dot.className = 'dot err';
      text.textContent = t('status.missingEmulator');
      tag.textContent = t('status.tagNeedDeploy');
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'boot') {
      dot.className = 'dot warn';
      text.textContent = t('status.readyWaitingBoot');
      tag.textContent = t('status.tagWaitingBoot');
      tag.className = 'brand-tag';
    } else if (s.installing) {
      dot.className = 'dot warn';
      text.textContent = t('status.installing');
      tag.textContent = t('status.tagInstalling');
      tag.className = 'brand-tag';
    } else {
      dot.className = 'dot';
      text.textContent = s.installed
        ? t('status.standby')
        : t('status.notInstalledSys');
      tag.textContent = s.installed ? t('status.tagStandby') : t('status.tagWaitingInstall');
      tag.className = 'brand-tag';
    }
    $('statusDevice').textContent = s.deviceOnline ? (s.serial || '') : '';
    // 网络状态：这是用户最容易踩的坑（应用里一直「网络错误」，但看不出是虚拟机没网）。
    // 直接摆在状态栏，出问题时一眼能看到，不用去翻日志。
    const netEl = $('statusNet');
    const netSep = $('statusNetSep');
    if (netEl) {
      const show = !!s.deviceOnline && !!s.network;
      netEl.hidden = !show;
      if (netSep) netSep.hidden = !show;
      if (show) {
        netEl.textContent = s.network.ok ? t('status.netOk', { ip: s.network.ip || '' }).trim() : t('status.netWarn');
        netEl.className = 'status-item status-net ' + (s.network.ok ? 'ok' : 'warn');
        netEl.title = s.network.ok ? t('status.netTitleOk') : t('status.netTitleWarn');
      }
    }

    renderSetup(s);
  } catch (e) {
    $('statusText').textContent = t('status.checkFailed', { error: e.message });
  }
}

/* ---------------- 运行时部署（固定在设置里） ---------------- */

/**
 * 运行时/部署/自检面板现在都收在「设置」里，主界面只留已安装应用。
 * 保留 showSetup 给托盘菜单与 ui:navigate 复用，语义改为「打开设置并定位到运行时」。
 */
function showSetup(on) {
  if (!on) { $('setupGuide').hidden = true; return; }
  openSettings().then(() => {
    focusGroup($('runtimeGroup'));
  }).catch(() => {});
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
  const accel = env.accel || s.accel || {};

  // 启动即见已安装应用：不再用部署向导整屏接管主界面，
  // 状态只在设置里的运行时面板 + 底部状态条上体现。
  const accelOk = accel.ok || hv.whpx;
  const adbDone = !!(env.adb && env.adb.ok);
  const emuDone0 = !!(env.emulator && env.emulator.ok);
  const imgDone0 = !!(env.sysimg && env.sysimg.ok);
  const allDone0 = adbDone && emuDone0 && imgDone0;
  const stateText = $('setupStateText');
  if (stateText) {
    const missing = [];
    if (!adbDone) missing.push(t('setup.adb'));
    if (!emuDone0) missing.push(t('setup.engine'));
    if (!imgDone0) missing.push(t('setup.sysimg'));
    stateText.textContent = s.deviceOnline
      ? t('setup.readyAndroid', { ver: s.android || '' })
      : s.phase === 'booting' || s.vmStarting
        ? t('setup.bootingAndroid')
        : allDone0
          ? t('setup.allDoneStandby')
          : t('setup.missingComponents', { missing: missing.join(', '), accelNote: accelOk ? '' : t('setup.noAccelFallback') });
    stateText.title = s.autoProfile || accel.note || hv.note || '';
  }

  const emuDone = !!(env.emulator && env.emulator.ok);
  const imgDone = !!(env.sysimg && env.sysimg.ok);
  const busy = state.setupBusy;
  const booting = s.phase === 'booting';

  // 只保留一个步骤：下载、参数自适应、开机全部由「一键完成」串起来，
  // 且首次启动会在后台自动跑，用户不需要逐步点击。
  const allDone = !!(env.adb && env.adb.ok) && emuDone && imgDone;
  const left = [];
  if (!(env.adb && env.adb.ok)) left.push(t('setup.adbToolchain'));
  if (!emuDone) left.push(t('setup.androidRuntime'));
  if (!imgDone) left.push(t('setup.systemImage'));
  const step = {
    key: 'all',
    index: 1,
    title: allDone ? t('setup.allReady') : t('setup.oneClickDone'),
    tag: allDone ? t('setup.autoCompleted') : t('setup.autoTag'),
    done: allDone,
    busy: !!busy,
    desc: s.deviceOnline
      ? t('setup.readyOnlineDesc', { ver: s.android || '' })
      : booting
        ? t('setup.bootingAndroid')
        : allDone
          ? t('setup.allDoneDoubleclickDesc')
          : t('setup.remainingDesc', { left: left.join(', ') }),
    actions: s.deviceOnline
      ? `<button class="btn ghost sm" data-act="vmStop">${esc(t('setup.stopRuntime'))}</button>`
      : '',
  };

  $('setupSteps').innerHTML = stepRow(step);
  $('btnDeployAll').disabled = !!busy;
  $('btnDeployAll').textContent = busy ? t('setup.preparing') : (allDone ? t('setup.completedRecheck') : t('setup.oneClickDone'));
  // 「上次为什么没起来」优先显示落盘的失败记录：进程重启后内存里的 diagnosis 是空的，
  // 只显示 autoProfile 会让用户完全看不出原因（issue #20/#25 的报告就是这样）。
  const lf = s.lastFailure;
  const lastMsg = (lf && lf.diagnosis && lf.diagnosis.title)
    ? t('setup.lastBootFail', { title: lf.diagnosis.title })
    : (s.diagnosis ? t('setup.lastDiagnosis', { title: s.diagnosis.title }) : '');
  $('setupNote').textContent = lastMsg
    || s.autoProfile || t('setup.fullAutoDesc');
}

function store_getDiskSize() {
  return (state.settings && state.settings.runtime && state.settings.runtime.diskSizeGB) || 24;
}

function setStepBusy(key, on) {
  state.setupBusy = on ? key : null;
  // 五步已合并成一行，所有子步骤的进度都落在这唯一的进度条上
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (row) {
    row.classList.toggle('busy', !!on);
    if (on) {
      const bar = row.querySelector('[data-bar]');
      if (bar) bar.style.width = '3%';
    }
  }
}

function updateStepProgress(component, p) {
  if (!component) return;
  const row = $('setupSteps').querySelector('[data-step="all"]');
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
  if (state.setupBusy) return;
  setStepBusy('all', true);
  try {
    // 一次调用把 adb / 引擎 / 系统镜像全装完，进度统一显示在唯一那一行
    // 用户点「一键部署」属于明确的手动重试，绕过失败冷却
    const r = await api.autoDeploy({ force: true });
    if (!r || !r.ok) {
      toast({ title: t('toast.deployFail'), body: (r && r.error) || t('toast.checkNetwork'), type: 'error', sticky: true });
      return;
    }
    await refreshStatus();
    toast({ title: t('toast.componentsReadyBooting'), body: t('toast.firstBootTakesMinutes'), type: 'info' });
    const started = await api.runtimeStart();
    await refreshStatus();
    toast(started && started.ok
      ? { title: t('toast.runtimeReady'), body: t('toast.runtimeReadyDragApk'), type: 'ok' }
      : { title: t('toast.bootIncomplete'), body: (started && started.error) || t('toast.exportDiagPrompt'), type: 'error', sticky: true });
  } catch (e) {
    toast({ title: t('toast.deployFail'), body: e.message, type: 'error', sticky: true });
  } finally {
    setStepBusy('all', false);
    await refreshStatus();
    selfCheck();
  }
}

async function runStep(key) {
  if (state.setupBusy) return { ok: false, error: t('toast.setupTaskInProgress') };
  setStepBusy(key, true);
  let r;
  try {
    if (key === 'adb') r = await api.installAdb();
    else if (key === 'emulator') r = await api.installEmulator();
    else if (key === 'sysimg') r = await api.installSysimg();
    else if (key === 'accel') {
      const t = toast({
        title: t('toast.installingAccelDriver'),
        body: t('toast.clickYesOnUac'),
        sticky: true,
        spinner: true,
      });
      r = await api.enableAccel();
      if (r.ok) t.update({ title: t('toast.accelEnabled'), type: 'ok' });
      else t.update({ title: t('toast.accelNotEnabled'), body: r.error, type: 'error', sticky: true });
    } else if (key === 'qemu') r = await api.installQemu();
    else if (key === 'iso') r = await api.downloadIso();
    else if (key === 'disk') r = await api.createDisk(store_getDiskSize());
    else r = { ok: false, error: t('common.unknown') };
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
    toast({ title: t('toast.cannotStartInstallEnv'), body: r.error, type: 'error', sticky: true });
    return;
  }
  $('setupGuide').hidden = false;
  $('setupGuide').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast({ title: t('toast.vmWindowOpened'), body: t('toast.vmFollowSteps'), type: 'ok', sticky: true });
}

async function markInstalled() {
  await api.markInstalled();
  await api.runtimeStop();
  $('setupGuide').hidden = true;
  await refreshStatus();
  toast({ title: t('toast.installDoneRuntimeTookOver'), body: t('toast.nowDragApk'), type: 'ok' });
}



/* ---------------- 安装 ---------------- */

/** 把安装失败翻译成「下一步该做什么」，只对最常见的几种做提示，其它原样显示 */
function friendlyInstallErrorText(msg) {
  const s = String(msg || t('common.failed'));
  if (/INSUFFICIENT_STORAGE|not enough space|空间不足|ENOSPC/i.test(s)) {
    return `${s}\n${t('install.err.storage')}`;
  }
  if (/NO_MATCHING_ABIS/i.test(s)) {
    return /已切换到.*仍然安装失败|abiRetried/i.test(s)
      ? `${s}\n${t('install.err.armFailed')}`
      : `${s}\n${t('install.err.armSwitching')}`;
  }
  if (/INSTALL_FAILED_ALREADY_EXISTS|signatures do not match/i.test(s)) {
    return `${s}\n${t('install.err.sigMismatch')}`;
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(s)) return `${s}\n${t('install.err.downgrade')}`;
  if (/ERR_FS_FILE_TOO_LARGE|greater than possible Buffer|Cannot allocate|ENOMEM|out of memory/i.test(s)) {
    return `${s}\n${t('install.err.tooLarge')}`;
  }
  return s;
}

/* 当前那条「正在安装…」的 sticky 提示。install:error 事件要能把它收掉：
 * 主进程是先 send('install:error') 再让 invoke 失败的，两者都可能到得很晚，
 * 只靠 catch 收会出现「报错了右下角还在转圈」。 */
let installToast = null;

async function installFiles(paths) {
  if (!paths || !paths.length) return;
  if (state.installing) {
    toast({ title: t('toast.installTaskBusy'), body: t('toast.installTaskBusyDesc') });
    return;
  }
  state.installing = true;
  let ok = 0;
  let failed = 0;

  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    const tEl = toast({ title: t('toast.installingApp', { name }), body: t('toast.parsingApk'), progress: 8, sticky: true, spinner: true });
    installToast = tEl;
    let off = () => {};
    try {
      off = api.on('install:progress', (pr) => {
        const base = { parse: 12, 'parse-done': 24, runtime: 38, install: 62, shortcut: 88, done: 100 }[pr.stage] || 50;
        const pct = pr.percent != null ? Math.min(60, Math.round((pr.percent / 100) * 60)) : base;
        tEl.update({ title: pr.meta ? t('toast.installingApp', { name: pr.meta.label }) : t('toast.installingApp', { name }), body: pr.message, progress: pct });
      });
      const r = await api.installApk(p);
      tEl.update({ title: t('toast.installedOk', { name: r.app.label }), body: r.app.shortcutPath ? t('toast.installedShortcutOk') : t('toast.installedCardHint'), progress: 100, type: 'ok' });
      tEl.el.querySelector('.spinner')?.remove();
      setTimeout(tEl.dismiss, 3600);
      if (r.warnings && r.warnings.length) {
        toast({ title: t('toast.compatWarning', { name: r.app.label }), body: r.warnings.join(' '), type: 'error', sticky: false });
      }
      ok++;
    } catch (e) {
      failed++;
      try { off(); } catch (_) { /* ignore */ }
      tEl.dismiss();
      if (installToast === tEl) installToast = null;
    } finally {
      try { off(); } catch (_) { /* ignore */ }
    }
  }

  state.installing = false;
  await refreshApps();
  if (ok && !failed) $('search').value = '';
}

/* ---------------- 应用操作 ---------------- */

async function launchApp(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  state.launchPkg = pkg;
  const t = toast({
    title: t('toast.appLaunching', { name: app ? app.label : pkg }),
    body: t('toast.launchWarming'),
    sticky: true,
    spinner: true,
  });
  const r = await api.launch(pkg);
  if (r.ok) {
    // 应用有自己的窗口，主界面自动收起；这里只留一句提示，然后隐藏窗口
    t.update({ title: t('toast.appLaunched'), body: t('toast.appLaunchedDesc'), type: 'ok' });
    setTimeout(t.dismiss, 1600);
    setTimeout(() => api.winHide(), 900);
    setTimeout(refreshApps, 1200);
  } else {
    t.update({ title: t('toast.launchFailed'), body: r.error, type: 'error' });
    setTimeout(t.dismiss, 6000);
  }
}

async function createShortcut(pkg) {
  try {
    const r = await api.createShortcut(pkg);
    toast({ title: t('toast.shortcutCreated'), body: r.path, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: t('toast.shortcutFailed'), body: e.message, type: 'error' });
  }
}

async function uninstall(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  if (!app) return;
  const ok = window.confirm(t('confirm.uninstallApp', { name: app.label }));
  if (!ok) return;
  try {
    await api.uninstall(pkg);
    toast({ title: t('toast.uninstalled'), body: app.label, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: t('toast.uninstallFailed'), body: e.message, type: 'error' });
  }
}

/* ---------------- 右键菜单 ---------------- */

const MENU_ITEMS = [
  { key: 'open', labelKey: 'ctx.open', label: 'Open', kbd: 'Enter' },
  { key: 'stop', labelKey: 'ctx.stop', label: 'Close', onlyRunning: true },
  { key: 'shortcut', labelKey: 'ctx.shortcut', label: 'Create Shortcut' },
  { key: 'orientation', labelKey: 'ctx.orientation', label: 'Rotate' },
  { key: 'pin', labelKey: 'ctx.pin', label: 'Pin on Top' },
  { key: 'keymap', labelKey: 'ctx.keymap', label: 'Keymap…' },
  { divider: true },
  { key: 'reveal', labelKey: 'ctx.reveal', label: 'Show in Explorer' },
  { key: 'clear', labelKey: 'ctx.clearData', label: 'Clear Data' },
  { divider: true },
  { key: 'uninstall', labelKey: 'ctx.uninstall', label: 'Uninstall', danger: true },
];

function showMenu(x, y, pkg) {
  const menu = $('ctxmenu');
  state.menuPkg = pkg;
  const app = state.apps.find((a) => a.package === pkg);
  const items = MENU_ITEMS.filter((it) => !it.onlyRunning || (app && app.running));
  menu.innerHTML = items.map((it) => {
    if (it.divider) return '<div class="divider"></div>';
    let label = it.labelKey ? t(it.labelKey) : it.label;
    if (it.key === 'pin') {
      label = app && app.pinned ? t('ctx.unpin') : t('ctx.pin');
    } else if (it.key === 'orientation') {
      if (app && app.orientationOverride === 'landscape') {
        label = t('ctx.toPortraitCurLand');
      } else if (app && app.orientationOverride === 'portrait') {
        label = t('ctx.toLandscapeCurPort');
      } else {
        label = t('ctx.setToLandscape');
      }
    }
    return `<div class="item ${it.danger ? 'danger' : ''}" data-key="${it.key}" data-act="${it.key}">
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
    case 'stop': {
      try {
        const r = await api.stop(pkg);
        if (r && r.ok) {
          toast({ title: t('toast.closed'), body: app.label, type: 'ok' });
        } else {
          toast({ title: t('toast.closeFailed'), body: (r && r.error) || t('common.failed'), type: 'error' });
        }
      } catch (e) {
        toast({ title: t('toast.closeFailed'), body: e.message, type: 'error' });
      }
      return refreshApps();
    }
    case 'shortcut': return createShortcut(pkg);
    case 'orientation': {
      // 三态循环：跟随应用 → 横屏 → 竖屏 → 跟随应用
      // 这样红果这类被清单判成竖屏的应用，用户点一下就能强制横屏并记住。
      const cur = app.orientationOverride;
      const next = cur === 'landscape' ? 'portrait' : (cur === 'portrait' ? null : 'landscape');
      try {
        const r = await api.setAppOrientation(pkg, next);
        const txt = next === 'landscape' ? t('toast.orientLandscape') : (next === 'portrait' ? t('toast.orientPortrait') : t('toast.orientAuto'));
        toast({ title: t('toast.orientationSet', { mode: txt }), body: t('toast.orientationNote'), type: 'ok' });
        if (r && typeof r.landscape === 'boolean' && state.apps) {
          const rec = state.apps.find((a) => a.package === pkg);
          if (rec) rec.orientationOverride = next;
        }
      } catch (e) {
        toast({ title: t('toast.orientationSet', { mode: '' }), body: e.message, type: 'error' });
      }
      return refreshApps();
    }
    case 'pin': return api.pin(pkg, !app.pinned).then(refreshApps);
    case 'keymap': return showKeymapPicker(pkg, app.label);
    case 'reveal': return api.revealApk(pkg);
    case 'clear': {
      if (!window.confirm(t('confirm.clearAppData', { name: app.label }))) return;
      try {
        await api.clearData(pkg);
        toast({ title: t('toast.dataCleared'), body: app.label, type: 'ok' });
      } catch (e) {
        toast({ title: t('toast.clearFailed'), body: e.message, type: 'error' });
      }
      return;
    }
    case 'uninstall': return uninstall(pkg);
    default: return undefined;
  }
}

/**
 * 按键映射预设选择器。用 confirm + prompt 做最简交互（不引入新 UI 组件）。
 * 后续可以做成更精致的弹窗编辑器。
 */
async function showKeymapPicker(pkg, label) {
  try {
    const presets = await api.keymap.getPresets();
    const current = await api.keymap.getMap(pkg);
    const hasCurrent = current && current.length > 0;
    const lines = presets.map((p, i) => `${i + 1}. ${p.label} — ${p.desc}`);
    if (hasCurrent) lines.unshift(t('keymap.clearCurrent'));
    const msg = t('keymap.selectPrompt', { label, list: lines.join('\n') });
    const input = window.prompt(msg, hasCurrent ? '0' : '1');
    if (input === null) return; // 取消
    const idx = parseInt(input, 10);
    if (hasCurrent && idx === 0) {
      await api.keymap.setMap(pkg, []);
      toast({ title: t('keymap.clearedTitle'), body: label, type: 'ok' });
      return;
    }
    const presetIdx = hasCurrent ? idx - 1 : idx;
    if (presetIdx < 1 || presetIdx > presets.length) {
      toast({ title: t('keymap.invalidNumber'), type: 'error' });
      return;
    }
    const chosen = presets[presetIdx - 1];
    await api.keymap.applyPreset(pkg, chosen.id);
    toast({ title: t('keymap.appliedTitle', { name: chosen.label }), body: t('keymap.appliedBody', { label }), type: 'ok' });
  } catch (e) {
    toast({ title: t('keymap.failedTitle'), body: e.message, type: 'error' });
  }
}

/* ---------------- 设置 ---------------- */

// ---------------- 安卓系统设置 ----------------

let volumeTimer = null;

async function refreshAndroid() {
  const el = $('androidStatus');
  if (!el) return;
  el.textContent = t('android.reading');
  const r = await api.android.status().catch(() => null);
  if (!r || !r.ok) {
    el.textContent = r && r.error ? t('android.runtimeNotReadyError', { error: String(r.error).slice(0, 36) }) : t('android.runtimeNotStarted');
    return;
  }
  el.textContent = `Android ${r.sdk || '?'} · ${r.wifi ? t('android.wifiOn') : t('android.wifiOff')}` +
    `${r.airplane ? ' · ' + t('android.airplane') : ''} · ${t('android.volume')} ${r.volume}%`;
  $('setAndroidWifi').checked = !!r.wifi;
  $('setAndroidAirplane').checked = !!r.airplane;
  $('setAndroidAnim').checked = !r.animationsOff;
  $('setAndroidVolume').value = r.volume;
  $('androidVolumeText').textContent = `${r.volume}%`;
  if (r.fontScale) $('setAndroidFont').value = Number(r.fontScale).toFixed(2);
  if (r.density) {
    const opt = [...$('setAndroidDensity').options].find((o) => o.value === String(r.density));
    if (opt) $('setAndroidDensity').value = String(r.density);
  }
}

function bindAndroid() {
  const set = async (key, value, msg) => {
    const r = await api.android.set(key, value).catch(() => null);
    toast({
      type: r && r.ok ? 'ok' : 'error',
      title: r && r.ok ? (msg || t('common.done')) : `${t('common.failed')}：${(r && r.error) || t('android.runtimeNotStarted')}`,
    });
    if (r && r.ok) refreshAndroid();
  };
  $('setAndroidWifi').addEventListener('change', (e) => set('wifi', e.target.checked, e.target.checked ? t('android.wifiEnabled') : t('android.wifiDisabled')));
  $('setAndroidAirplane').addEventListener('change', (e) => set('airplane', e.target.checked, e.target.checked ? t('android.airplaneEnabled') : t('android.airplaneDisabled')));
  $('setAndroidAnim').addEventListener('change', (e) => set('animations', e.target.checked, e.target.checked ? t('android.animEnabled') : t('android.animDisabledFaster')));
  $('setAndroidFont').addEventListener('change', (e) => set('fontScale', Number(e.target.value), t('android.fontAdjusted')));
  $('setAndroidDensity').addEventListener('change', (e) => set('density', Number(e.target.value), t('android.densityAdjusted')));
  $('setAndroidVolume').addEventListener('input', (e) => {
    $('androidVolumeText').textContent = `${e.target.value}%`;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => set('volume', Number(e.target.value), t('android.volumeAdjusted')), 260);
  });
  $('btnAndroidRefresh').addEventListener('click', () => refreshAndroid());
  $('btnAndroidTune').addEventListener('click', async () => {
    const r = await api.android.tune(state.launchPkg || '').catch(() => null);
    toast({ type: r && r.ok ? 'ok' : 'error', title: r && r.ok ? t('android.optSuccess') : t('android.optFail') });
    if (r && r.ok) refreshAndroid();
  });
  const open = async (action) => {
    const r = await api.android.open(action).catch(() => null);
    if (!r || !r.ok) {
      toast({ type: 'error', title: t('android.needLaunchFirst') });
    }
  };
  $('btnAndroidSettings').addEventListener('click', () => open('settings'));
  $('btnAndroidDisplay').addEventListener('click', () => open('display'));
  $('btnAndroidSound').addEventListener('click', () => open('sound'));
  $('btnAndroidLocale').addEventListener('click', () => open('locale'));
  if ($('btnAndroidKeyboard')) $('btnAndroidKeyboard').addEventListener('click', () => open('keyboard'));
  $('btnAndroidApps').addEventListener('click', () => open('apps'));
}

/** 设置页字段同步：只剩自带运行时，所有资源项都露出来，不再按底座切换 */
function syncBackendFields() {
  const perf = $('perfGroup');
  if (perf) perf.hidden = false;
  refreshResources();
}

/** 本机资源上限 + 当前分配（设置页里那几行灰字） */
async function refreshResources() {
  const bNote = $('builtinResNote');
  if (!bNote) return;
  const gb = (mb) => (Number(mb) > 0 ? `${Math.round(Number(mb) / 1024)} GB` : t('common.unknown'));
  const r = await api.resources().catch(() => null);
  if (!r || r.ok === false) {
    bNote.textContent = (r && (r.note || r.error)) || t('android.noResourceInfo');
    return;
  }
  const host = r.host || {};
  const lim = r.limits || {};
  const free = Number(r.freeMB) || Number((r.current && r.current.freeMB) || 0);
  const diskNote = free ? t('android.hostDiskFreeNote', { free: (free / 1024).toFixed(1) }) : '';
  bNote.textContent = t('android.hostResourceSummary', {
    hostRam: gb(host.totalMB),
    hostCores: host.cores,
    maxRam: gb(lim.maxMB),
    maxCores: Math.max(1, (host.cores || 1) - 1),
    maxDisk: lim.maxGB || 0,
    diskNote,
  }) + (r.verdict && r.verdict.note ? ` ${r.verdict.note}` : '');
}

let lastPreflight = null;

/** 本机体检：渲染报告（每条带等级点和可执行动作） */
function renderPreflight(res) {
  lastPreflight = res;
  const list = $('preflightList');
  const sum = $('preflightSummary');
  const applyBtn = $('btnPreflightApply');
  if (!list) return;
  list.textContent = '';
  if (!res || !res.report) {
    if (sum) sum.textContent = (res && res.error) || t('preflight.noResult');
    return;
  }
  const { report, edition } = res;
  for (const it of report.items) {
    const item = document.createElement('div');
    item.className = 'pf-item';
    const head = document.createElement('div');
    head.className = 'pf-head';
    const dot = document.createElement('span');
    dot.className = `pf-dot ${it.level}`;
    const title = document.createElement('span');
    title.className = 'pf-title';
    title.textContent = it.title;
    head.append(dot, title);
    item.append(head);
    if (it.detail) {
      const d = document.createElement('div');
      d.className = 'pf-detail';
      d.textContent = it.detail;
      item.append(d);
    }
    if (it.action && it.action.kind === 'elevate') {
      const wrap = document.createElement('div');
      wrap.className = 'pf-action';
      const btn = document.createElement('button');
      btn.className = 'btn ghost sm';
      btn.textContent = it.action.label;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = t('preflight.processing');
        let r = null;
        if (it.action.id === 'accel') r = await api.enableAccel().catch(() => null);
        else r = await api.enableVirtualization().catch(() => null);
        btn.disabled = false;
        btn.textContent = old;
        if (!r) { toast({ type: 'error', title: t('toast.actionCancelled'), body: t('common.retry') }); return; }
        if (r.cancelled) toast({ type: 'warn', title: t('toast.actionCancelled'), body: t('toast.actionCancelledDesc') });
        else if (r.ok || r.already) {
          const reboot = r.restartNeeded === true;
          toast({
            type: 'ok',
            title: r.already ? t('setup.accelEnabled') : (reboot ? t('toast.restartingRuntime') : t('setup.accelEnabled')),
            body: r.already ? '' : (reboot ? t('issue.accel.store.hint') : ''),
          });
          if (r.already || !reboot) setTimeout(() => runPreflight().catch(() => {}), 1200);
        } else {
          toast({ type: 'error', title: t('setup.accelFailed'), body: (r.error || r.note || t('common.retry')) });
        }
      });
      wrap.append(btn);
      item.append(wrap);
    } else if (it.action && it.action.kind === 'manual') {
      const wrap = document.createElement('div');
      wrap.className = 'pf-action pf-detail';
      wrap.textContent = `⚠ ${it.action.label}`;
      item.append(wrap);
    }
    list.append(item);
  }
  const rec = report.recommended || {};
  if (sum) {
    sum.textContent = t('preflight.recommended', {
      summary: report.summary,
      memory: Math.round((rec.memoryMB || 0) / 1024),
      cores: rec.cores || 2,
      renderSize: rec.renderSize || 'auto',
      gpuMode: rec.gpuMode || 'auto',
      storeNote: edition === 'store' ? t('preflight.storeNote') : '',
    });
  }
  if (applyBtn) applyBtn.hidden = false;
}

async function runPreflight() {
  const btn = $('btnPreflight');
  const sum = $('preflightSummary');
  if (!btn) return null;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('android.checkingHealth');
  if (sum) sum.textContent = t('android.checkingHealthSum');
  let r = null;
  try {
    r = await api.preflightRun();
  } catch (e) {
    r = { error: e.message || t('android.healthFailed') };
  }
  btn.disabled = false;
  btn.textContent = old;
  renderPreflight(r);
  return r;
}

/** 驱动（兼容补丁）：渲染清单 + 命中状态 */
let lastDrivers = null;

function renderDrivers(r) {
  lastDrivers = r;
  const list = $('drvList');
  const sum = $('drvSummary');
  if (!list) return;
  const host = (r && r.host) || {};
  const drivers = (r && r.drivers) || [];
  const errors = (r && r.errors) || [];
  const onCount = drivers.filter((d) => d.enabled && d.matched).length;
  if (sum) {
    const accel = host.accel === 'none' ? t('drivers.noAccel') : (host.accel || t('drivers.unknown'));
    const fileErrors = errors.length ? t('drivers.fileErrors', { n: errors.length }) : '';
    sum.textContent = t('drivers.summary', {
      platform: host.platform || '',
      arch: host.arch || '',
      gpu: host.gpuVendor || t('drivers.unknown'),
      accel,
      emu: host.emulatorVersion || t('drivers.unknown'),
      total: drivers.length,
      active: onCount,
      errors: fileErrors,
    });
  }
  list.textContent = '';
  for (const d of drivers) {
    const item = document.createElement('div');
    item.className = d.enabled ? 'drv-item on' : 'drv-item';

    const head = document.createElement('div');
    head.className = 'drv-head';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!d.enabled;
    cb.addEventListener('change', async () => {
      const res = await api.driversSetEnabled(d.id, cb.checked).catch(() => null);
      if (res && res.ok && res.overview) renderDrivers(res.overview);
      else { cb.checked = !cb.checked; toast({ type: 'error', title: t('toast.saveFailed'), body: (res && res.error) || t('common.retry') }); }
    });
    const name = document.createElement('span');
    name.className = 'drv-name';
    name.textContent = d.name;
    head.append(cb, name);

    if (d.matched && d.enabled) {
      const b = document.createElement('span');
      b.className = 'drv-badge hit';
      b.textContent = t('drivers.active');
      head.append(b);
    }
    if (d.builtin) {
      const b = document.createElement('span');
      b.className = 'drv-badge';
      b.textContent = t('drivers.builtinSample');
      head.append(b);
    }
    item.append(head);

    const meta = document.createElement('div');
    meta.className = 'drv-meta';
    meta.textContent = `v${d.version || '?'}`
      + (d.author ? ` · ${d.author}` : '')
      + ` · priority ${d.priority}`
      + (d.hits && d.hits.length ? ` · ${t('drivers.hits', { hits: d.hits.join(' / ') })}` : ` · ${t('drivers.notMatched')}`);
    item.append(meta);

    if (d.description) {
      const desc = document.createElement('div');
      desc.className = 'drv-meta';
      desc.textContent = d.description;
      item.append(desc);
    }
    list.append(item);
  }
  for (const e of errors) {
    const err = document.createElement('div');
    err.className = 'drv-err';
    err.textContent = `${String(e.file || '').split(/[\\/]/).pop()}：${(e.errors || []).join('；')}`;
    list.append(err);
  }
  if (!drivers.length && !errors.length) {
    const empty = document.createElement('div');
    empty.className = 'drv-meta';
    empty.textContent = t('drivers.empty');
    list.append(empty);
  }
}

async function refreshDrivers() {
  if (!$('drvList')) return;
  const r = await api.driversList().catch(() => null);
  if (!r) {
    if ($('drvSummary')) $('drvSummary').textContent = t('android.cannotReadDrivers');
    return;
  }
  renderDrivers(r);
}

function fillSettings(s) {
  syncBackendFields();
  refreshDrivers().catch(() => {});
  if ($('setLanguage')) $('setLanguage').value = s.language || 'en';
  if ($('setAdbPath')) $('setAdbPath').value = s.adbPath || '';
  if ($('setSystemImage')) $('setSystemImage').value = (s.runtime && s.runtime.isoPath) || '';
  if ($('setMemory')) $('setMemory').value = (s.engine && s.engine.memoryMB) || '';
  if ($('setCores')) $('setCores').value = (s.engine && s.engine.cores) || '';
  if ($('setIdle')) $('setIdle').value = (s.engine && s.engine.idleShutdownMinutes) || '';
  if ($('setSourcePref')) $('setSourcePref').value = (s.runtime && s.runtime.sourcePreference) || 'auto';
  if ($('setAutoMirror')) $('setAutoMirror').checked = (s.runtime && s.runtime.autoMirror) !== false;
  if ($('setGiteeToken')) $('setGiteeToken').value = (s.runtime && s.runtime.giteeToken) || '';
  if ($('setMirrorPrefix')) $('setMirrorPrefix').value = (s.runtime && s.runtime.mirrorPrefix) || '';
  if ($('setConnections')) $('setConnections').value = Number((s.runtime && s.runtime.downloadConnections) || 8);
  $('setAudio').checked = s.engine.audio !== false;
  $('setLiteMode').checked = s.engine.liteMode !== false;
  $('setPrewarm').checked = s.engine.prewarm !== false;
  $('setPriorityMode').value = ['performance', 'game'].includes(s.engine.priorityMode)
    ? s.engine.priorityMode : 'balanced';
  $('setDeepTrim').checked = !!s.engine.deepTrim;
  $('setMouseRightBack').checked = s.engine.mouseRightBack !== false;
  $('setMouseWheelMode').value = ['smooth', 'native', 'off'].includes(s.engine.mouseWheelMode)
    ? s.engine.mouseWheelMode : 'smooth';
  $('setMouseSideButtons').checked = !!s.engine.mouseSideButtons;
  if ($('setKeymapEnabled')) $('setKeymapEnabled').checked = s.engine.keymapEnabled !== false;
  $('setCompat').checked = !!(s.runtime && s.runtime.compatImage);
  $('setAutoShortcut').checked = !!s.createShortcutOnInstall;
  $('setStartMenuShortcut').checked = s.createStartMenuShortcut !== false;
  $('setShortcutDir').value = s.shortcutDir || '';
  $('setSharedDir').value = s.sharedDir || '';
  $('setDeviceSharedDir').value = s.deviceSharedDir || '';
  const d = s.display || {};
  $('setAutoStart').checked = s.autoStart !== false;
  const eng = s.engine || {};
  if ($('setResourceMode')) $('setResourceMode').value = eng.resourceMode || 'balanced';
  if ($('setRenderSize')) $('setRenderSize').value = eng.renderSize || 'auto';
  if ($('setDataGB')) $('setDataGB').value = String(Number(eng.dataPartitionGB || 0));
  if ($('setFastDns')) $('setFastDns').checked = eng.fastDns !== false;
  if ($('setLocale')) $('setLocale').value = eng.locale || 'auto';
  if ($('setChineseIme')) $('setChineseIme').checked = eng.chineseIme !== false;
  if ($('setKeepSnapshot')) $('setKeepSnapshot').checked = eng.keepSnapshot !== false;
  $('setDisplayMode').value = d.mode === 'fullscreen' ? 'fullscreen' : 'window';
  if ($('setAutoFullscreen')) $('setAutoFullscreen').value = d.autoFullscreenOnLaunch === true ? 'on' : 'off';
  if ($('setLandscape')) $('setLandscape').value = d.landscape === true ? 'landscape' : 'portrait';
  if ($('setOrientationMode')) $('setOrientationMode').value = d.orientationMode || 'auto';
  if ($('setAutoRotate')) $('setAutoRotate').value = d.autoRotate === false ? 'off' : 'on';
  if ($('setTabletMode')) $('setTabletMode').value = d.tabletMode === false ? 'off' : 'on';
  $('setPortrait').value = d.portrait || '900x1600';
  // 0.6.0 起默认原生窗口：只有显式 true 才是嵌入模式（旧配置里 undefined 视为原生）
  if ($('setWindowEmbed')) $('setWindowEmbed').value = d.windowEmbed === true ? 'embed' : 'detached';
  $('portraitField').hidden = $('setDisplayMode').value === 'fullscreen';
}

/** 数据分区实际大小 + 磁盘余量，显示在设置页容量选择下方 */
async function refreshDataInfo() {
  const el = $('dataNote');
  if (!el) return;
  const info = await api.dataInfo().catch(() => null);
  if (!info) { el.textContent = t('android.readDataPartitionFailed'); return; }
  const auto = Number(($('setDataGB') || {}).value || 0) === 0;
  // 有 quickboot 差量盘时底座镜像的大小不等于 guest 看到的容量（实测 8GB 镜像、guest 5.7GB），
  // 与其显示一个会误导人的数字，不如明确说「以运行时为准」。
  const img = info.overlay
    ? t('android.quickbootDiffDisk')
    : (info.fsGB ? t('android.actualFsGB', { fsGB: info.fsGB }) : (info.imageGB ? `${info.imageGB} GB` : t('android.notCreatedYet')));
  const free = info.freeDiskMB ? `${(info.freeDiskMB / 1024).toFixed(1)} GB` : t('common.unknown');
  const pending = Number(info.pendingGB) > 0
    ? t('android.pendingResetNotice', { configuredGB: info.configuredGB })
    : '';
  const autoLabel = auto ? t('android.autoLabel') : '';
  el.textContent = t('android.dataPartitionSummary', { img, auto: autoLabel, free, pending });
}

/* ---------------- 设置页：分类导航 + 搜索 ---------------- */

/**
 * 设置项越来越多，一条长滚动找起来很费劲（用户 0.6.0 的原话：
 * 「设置内做好分类功能」）。这里把设置按用途分成 8 类，左侧一列导航。
 *
 * 分类表必须与 index.html 里每个分组的 data-cat 一致 ——
 * test/settings-categories-test.js 会校验这一致性。
 */
const SETTINGS_CATS = [
  { id: 'basic', nameKey: 'settings.cat.basic', name: 'General & Installation' },
  { id: 'display', nameKey: 'settings.cat.display', name: 'Display & Window' },
  { id: 'input', nameKey: 'settings.cat.input', name: 'Input & Controls' },
  { id: 'perf', nameKey: 'settings.cat.perf', name: 'Performance & Resources' },
  { id: 'net', nameKey: 'settings.cat.net', name: 'Network & Downloads' },
  { id: 'diag', nameKey: 'settings.cat.diag', name: 'Diagnostics & Repair' },
  { id: 'files', nameKey: 'settings.cat.files', name: 'Integration & Files' },
  { id: 'about', nameKey: 'settings.cat.about', name: 'Updates & About' },
];

const settingsCatState = { cat: 'basic', query: '' };

/** 设置里所有带分类标记的分组（.group 和 details.advanced-group 都算） */
function settingsGroups() {
  return Array.from(document.querySelectorAll('#settingsBody [data-cat]'));
}

/** 分组内是否命中搜索词：标题、字段名、说明文字都算 */
function groupMatches(group, q) {
  if (!q) return true;
  const text = (group.textContent || '').toLowerCase();
  if (text.includes(q)) return true;
  const title = group.querySelector('.group-title');
  return !!title && title.textContent.toLowerCase().includes(q);
}

/** 切到某个分类 */
function switchSettingsCat(cat, { keepQuery = false } = {}) {
  const target = SETTINGS_CATS.some((c) => c.id === cat) ? cat : 'basic';
  settingsCatState.cat = target;
  if (!keepQuery) settingsCatState.query = '';
  try { localStorage.setItem('apkstart.settings.cat', target); } catch (_) { /* ignore */ }
  const search = $('setSearch');
  if (search && !keepQuery) search.value = '';
  const clear = $('btnClearSearch');
  if (clear) clear.hidden = !settingsCatState.query;
  document.querySelectorAll('#setNav .set-nav-item').forEach((b) => {
    b.classList.toggle('on', b.dataset.cat === target);
  });
  applySettingsFilter();
}

/**
 * 应用可见性：搜索时跨分类展示命中的分组（否则搜到的东西藏在别的分类里，
 * 用户会以为「搜了没反应」）；没搜索时只显示当前分类。
 */
function applySettingsFilter() {
  const q = settingsCatState.query.trim().toLowerCase();
  const groups = settingsGroups();
  const hitPerCat = {};
  for (const g of groups) {
    const hit = groupMatches(g, q);
    const inCat = g.dataset.cat === settingsCatState.cat;
    g.hidden = q ? !hit : !inCat;
    if (hit) hitPerCat[g.dataset.cat] = (hitPerCat[g.dataset.cat] || 0) + 1;
  }
  // 分类按钮：搜索时标出哪些分类有命中项
  document.querySelectorAll('#setNav .set-nav-item').forEach((b) => {
    const n = hitPerCat[b.dataset.cat] || 0;
    b.classList.toggle('dim', !!q && n === 0);
    b.title = q ? t('android.hitsCount', { n }) : '';
  });
  // 最后一个可见分组不画分隔线（分组被隐藏后 :last-child 会选错对象）
  const visible = groups.filter((g) => !g.hidden);
  visible.forEach((g) => g.classList.remove('last-visible'));
  if (visible.length) visible[visible.length - 1].classList.add('last-visible');
  updateCatBadges();
}

/** 定位到某个分组：先切到它所属的分类，再滚动过去 */
function focusGroup(el) {
  if (!el) return;
  const cat = el.dataset && el.dataset.cat;
  if (cat) switchSettingsCat(cat);
  const body = $('settingsBody');
  if (body) body.scrollTop = 0;
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function bindSettingsCategory() {
  const nav = $('setNav');
  if (nav) {
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.set-nav-item');
      if (!btn) return;
      switchSettingsCat(btn.dataset.cat);
      const body = $('settingsBody');
      if (body) body.scrollTop = 0;
    });
  }

  const search = $('setSearch');
  const clear = $('btnClearSearch');
  if (search) {
    search.addEventListener('input', () => {
      settingsCatState.query = search.value || '';
      if (clear) clear.hidden = !settingsCatState.query;
      applySettingsFilter();
    });
    // 回车：跳到第一个命中的分组
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const hit = settingsGroups().find((g) => !g.hidden);
      if (hit) focusGroup(hit);
    });
  }
  if (clear) {
    clear.addEventListener('click', () => {
      settingsCatState.query = '';
      if (search) search.value = '';
      clear.hidden = true;
      applySettingsFilter();
    });
  }

  // 记住上次停留的分类
  try {
    const last = localStorage.getItem('apkstart.settings.cat');
    if (last && SETTINGS_CATS.some((c) => c.id === last)) settingsCatState.cat = last;
  } catch (_) { /* ignore */ }
  switchSettingsCat(settingsCatState.cat);
}

/* ---------------- 自动检测（自动 debug）---------------- */

/** 自动检测的问题分类名（与 src/core/autodebug.js 的 CATEGORIES 对应） */
const DEBUG_CATS = [
  { id: 'runtime', name: 'Runtime' },
  { id: 'device', name: 'Device Connection' },
  { id: 'storage', name: 'Storage' },
  { id: 'settings', name: 'Settings' },
  { id: 'network', name: 'Network' },
  { id: 'logs', name: 'Logs' },
];

let autodebugLast = null;

function renderAutodebug(res) {
  const list = $('autodebugList');
  const txt = $('autodebugStateText');
  if (!list) return;
  autodebugLast = res || null;
  const issues = (res && res.issues) || [];
  const at = res && res.at;

  if (txt) {
    if (res && res.running) txt.textContent = t('autodebug.checking');
    else if (!at) txt.textContent = t('autodebug.notChecked');
    else if (!issues.length) txt.textContent = t('autodebug.lastCheckOk', { time: relTime(at) });
    else txt.textContent = t('autodebug.lastCheckIssues', { time: relTime(at), n: issues.length });
  }

  if (!issues.length) {
    list.innerHTML = `<div class="dbg-ok">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
      <span>${esc(t('autodebug.allClean'))}</span>
    </div>`;
    updateCatBadges();
    return;
  }

  const byCat = new Map();
  for (const it of issues) {
    const key = it.category || 'runtime';
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(it);
  }
  const order = DEBUG_CATS.map((c) => c.id);
  const keys = Array.from(byCat.keys()).sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  list.innerHTML = keys.map((key) => {
    const name = t('autodebug.cat.' + key) || (DEBUG_CATS.find((c) => c.id === key) || {}).name || key;
    const items = byCat.get(key);
    return `<div class="dbg-group">
      <div class="dbg-group-title">${esc(name)}<span class="dbg-count">${items.length}</span></div>
      ${items.map((it) => {
        const itemTitle = t('issue.' + it.code + '.title') || it.title || '';
        const itemHint = t('issue.' + it.code + '.hint') || it.hint || '';
        return `
        <div class="dbg-item ${esc(it.severity || 'info')}">
          <span class="dbg-sev"></span>
          <div class="dbg-body">
            <div class="dbg-name">${esc(itemTitle)}</div>
            <div class="dbg-hint">${esc(itemHint)}</div>
            ${it.detail ? `<div class="dbg-detail">${esc(it.detail)}</div>` : ''}
          </div>
          ${it.fix ? `<button class="dbg-fix" data-code="${esc(it.code)}">${esc(t('autodebug.fix'))}</button>` : ''}
          <button class="dbg-help" data-code="${esc(it.code)}" title="${esc(t('autodebug.openTutorial'))}">${esc(t('autodebug.tutorial'))}</button>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');

  list.querySelectorAll('.dbg-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });
  list.querySelectorAll('.dbg-help').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) openManualForIssue(issue, 'clicked');
    });
  });

  updateCatBadges();
}

/** 分类按钮上的问题角标：只在有问题的分类上显示数字 */
function updateCatBadges() {
  const issues = (autodebugLast && autodebugLast.issues) || [];
  document.querySelectorAll('#setNav .set-nav-badge').forEach((el) => {
    const cat = el.dataset.badge;
    // 自动检测的问题不一定都归属某个设置分类，只有设置类问题才在「诊断与修复」上打标
    const n = cat === 'diag' ? issues.filter((i) => i.severity === 'error').length : 0;
    el.hidden = n === 0;
    el.textContent = n ? String(n) : '';
    el.classList.toggle('warn', false);
  });
}

function bindAutodebug() {
  const btn = $('btnAutodebugRun');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = t('autodebug.checking');
      try {
        const r = await api.autodebugRun().catch(() => null);
        if (r) renderAutodebug(r);
        else toast({ title: t('toast.debugFailed'), body: t('toast.debugFailedBody'), type: 'error' });
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    });
  }

  const report = $('btnAutodebugReport');
  if (report) {
    report.addEventListener('click', async () => {
      const r = await api.doctorReport().catch(() => null);
      if (r && r.ok !== false) toast({ title: t('toast.reportExported'), body: t('toast.reportExportedBody'), type: 'ok' });
      else toast({ title: t('toast.exportFailed'), body: (r && r.error) || t('common.retry'), type: 'error' });
    });
  }

  const auto = $('setAutodebugAuto');
  if (auto) {
    auto.addEventListener('change', async () => {
      const r = await api.autodebugConfig({ auto: auto.checked }).catch(() => null);
      if (r) fillAutodebugSettings(r);
      toast({
        title: auto.checked ? t('toast.autodebugEnabled') : t('toast.autodebugDisabled'),
        body: auto.checked ? t('toast.autodebugEnabledBody') : t('toast.autodebugDisabledBody'),
        type: 'info',
      });
    });
  }

  const interval = $('setAutodebugInterval');
  if (interval) {
    interval.addEventListener('change', async () => {
      const r = await api.autodebugConfig({ intervalMin: Number(interval.value) }).catch(() => null);
      if (r) fillAutodebugSettings(r);
      toast({ title: t('toast.intervalUpdated'), body: t('toast.intervalUpdatedBody', { n: r ? r.intervalMin : interval.value }), type: 'ok' });
    });
  }

  const notify = $('setAutodebugNotify');
  if (notify) {
    notify.addEventListener('change', async () => {
      const r = await api.autodebugConfig({ notify: notify.checked }).catch(() => null);
      if (r) fillAutodebugSettings(r);
    });
  }
}

function fillAutodebugSettings(cfg) {
  if (!cfg) return;
  const auto = $('setAutodebugAuto');
  if (auto) auto.checked = cfg.auto !== false;
  const interval = $('setAutodebugInterval');
  if (interval) interval.value = String(cfg.intervalMin || 10);
  const notify = $('setAutodebugNotify');
  if (notify) notify.checked = cfg.notify !== false;
}

async function openSettings() {
  state.settings = await api.getSettings();
  fillSettings(state.settings);
  fillAutodebugSettings((state.settings && state.settings.debug) || {});
  const info = await api.info();
  $('setRuntimeDir').value = info.runtimeDir || info.dataDir;
  if ($('setAvdDir')) {
    const di = await api.dataInfo().catch(() => null);
    $('setAvdDir').value = (di && di.avdDir) || '';
  }
  const verEl = document.getElementById('aboutVer');
  if (verEl && info.version) verEl.textContent = `v${info.version}`;
  const curVerEl = document.getElementById('updateCurrent');
  if (curVerEl && info.version) curVerEl.textContent = `v${info.version}`;
  const assoc = await api.assocStatus();
  const btn = $('btnAssoc');
  btn.textContent = assoc.registered ? t('settings.assocLinked') : t('settings.assocUnlinked');
  btn.dataset.on = assoc.registered ? '1' : '0';

  api.doctorProfile().then((r) => {
    if (r && r.text) $('autoProfileText').textContent = r.text;
  }).catch(() => { $('autoProfileText').textContent = t('common.auto'); });
  api.runtimeUsage().then((u) => {
    $('usageText').textContent = u
      ? `${t('common.total')} ${u.totalText}${u.reclaimable ? ` · ${t('settings.reclaimable')} ${u.reclaimableText} (${u.count})` : ` · ${t('toast.alreadyClean')}`}`
      : t('common.calculating');
  }).catch(() => { $('usageText').textContent = t('common.calculating'); });

  $('settingsMask').classList.add('on');
  refreshAndroid();
  refreshDataInfo();
  applySettingsFilter();
  // 先把上一次的检测结果铺上（别让面板空着等），再后台刷新一份
  api.autodebugState().then((r) => { if (r) renderAutodebug(r); }).catch(() => {});
}

function closeSettings() {
  $('settingsMask').classList.remove('on');
}

/* ---------------- 软件更新 ---------------- */

let lastUpdate = null;

/** 把一次检查结果画到设置面板（也用于启动时静默检查推送过来的状态） */
function renderUpdate(info) {
  lastUpdate = info || null;
  const cur = $('updateCurrent');
  const st = $('updateState');
  const btn = $('btnDoUpdate');
  const bar = $('updateBar');
  if (!cur || !st || !btn) return;
  if (!info) return;
  if (info.current) cur.textContent = `v${info.current}`;

  if (info.ok === false) {
    st.textContent = t('update.failed', { error: info.error || 'Network error' });
    showUpdateBtn(true);
    btn.textContent = t('update.openDownload');
    btn.dataset.mode = 'manual';
    lastUpdate = { htmlUrl: info.htmlUrl || '' };
    if (bar) bar.hidden = true;
    return;
  }
  if (info.hasUpdate) {
    const src = (info.sources || []).map((x) => `${x.name} ${x.tag || ''}`.trim()).join(' / ');
    st.textContent = `${t('update.newVersionFound', { tag: info.tag })} ${src ? `(${src})` : ''}`;
    showUpdateBtn(true);
    btn.textContent = info.asset ? t('update.updateNow') : t('update.openDownload');
    btn.dataset.mode = info.asset ? 'auto' : 'manual';
    const note = $('updateNote');
    if (note && info.notes) {
      const brief = String(info.notes).split('\n').slice(0, 8).join('\n').trim();
      if (brief) note.textContent = brief;
    }
    if (bar) bar.hidden = true;
  } else {
    const src = (info.sources || []).map((x) => x.name).join(' / ');
    st.textContent = `${t('update.isLatest')} (v${info.current}) ${src ? `· ${src}` : ''}`;
    showUpdateBtn(false);
    if (bar) bar.hidden = true;
  }
}

/** .btn 自带 display:inline-flex，会盖掉 hidden 属性，所以这里直接改 display */
function showUpdateBtn(on) {
  const btn = $('btnDoUpdate');
  if (!btn) return;
  btn.hidden = !on;
  btn.style.display = on ? '' : 'none';
}

function renderUpdateProgress(p) {
  if (!p) return;
  const st = $('updateState');
  const bar = $('updateBar');
  const fill = $('updateBarFill');
  if (p.stage === 'error') {
    if (st) st.textContent = `${t('common.failed')}：${p.message || ''}`;
    if (bar) bar.hidden = true;
    toast({ title: t('common.failed'), body: p.message || '', type: 'error' });
    return;
  }
  if (st) st.textContent = p.message || t('common.loading');
  if (bar && fill) {
    bar.hidden = false;
    fill.style.width = `${Math.max(0, Math.min(100, p.percent || 0))}%`;
  }
}

function bindUpdate() {
  const check = $('btnCheckUpdate');
  const go = $('btnDoUpdate');
  if (!check || !go) return;

  const runCheck = async (silent) => {
    if (!silent) {
      check.disabled = true;
      const old = check.textContent;
      check.textContent = t('update.checking');
      $('updateState').textContent = t('update.connecting');
      try {
        const info = await api.updateCheck();
        renderUpdate(info);
        if (info && info.hasUpdate) toast({ title: t('update.newVersionFound', { tag: info.tag }), body: t('update.clickToUpdate'), type: 'info' });
        else if (info && info.ok !== false) toast({ title: t('update.isLatest'), body: `v${info.current}`, type: 'ok' });
      } catch (e) {
        $('updateState').textContent = t('update.failed', { error: e.message });
      } finally {
        check.disabled = false;
        check.textContent = old;
      }
      return;
    }
    const info = await api.updateCheck().catch(() => null);
    if (info) renderUpdate(info);
  };

  check.addEventListener('click', () => runCheck(false));

  go.addEventListener('click', async () => {
    if (go.dataset.mode === 'manual') {
      api.updateOpenRelease(lastUpdate && lastUpdate.htmlUrl);
      return;
    }
    go.disabled = true;
    go.textContent = t('update.updating');
    const r = await api.updateApply().catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) {
      go.disabled = false;
      go.textContent = t('update.updateNow');
      if (r && r.error && !r.manual) {
        $('updateState').textContent = t('update.failed', { error: r.error });
        toast({ title: t('common.failed'), body: r.error, type: 'error' });
      }
    } else {
      $('updateState').textContent = t('update.readyRestart', { ver: 'v' + r.version });
    }
  });

  // 打开设置时如果还没结果，就顺手查一次（放后台，不打扰）
  runCheck(true).catch(() => {});
}

function bindSettings() {
  const save = async (patch) => {
    state.settings = await api.setSettings(patch);
  };

  if ($('setLanguage')) {
    $('setLanguage').addEventListener('change', async (e) => {
      const lang = e.target.value;
      await save({ language: lang });
      applyLanguage(lang);
      const engLocale = state.settings?.engine?.locale || 'auto';
      if (engLocale === 'auto') {
        toast({ title: t('toast.systemLangUpdated'), body: t('toast.systemLangUpdatedBody'), type: 'ok' });
      }
    });
  }

  if ($('btnPreflight')) $('btnPreflight').addEventListener('click', () => runPreflight());
  if ($('btnPreflightApply')) {
    $('btnPreflightApply').addEventListener('click', async () => {
      const btn = $('btnPreflightApply');
      btn.disabled = true;
      const r = await api.preflightApply().catch(() => null);
      btn.disabled = false;
      if (!r || !r.ok) {
        toast({ type: 'error', title: t('toast.saveFailed'), body: (r && r.error) || t('common.retry') });
        return;
      }
      state.settings = r.settings;
      toast({
        type: 'ok',
        title: t('toast.appliedPreset'),
        body: t('toast.appliedPresetBody', {
          ram: Math.round((r.recommended.memoryMB || 0) / 1024),
          cores: r.recommended.cores,
          render: r.recommended.renderSize,
          driver: r.driverFile ? t('toast.driverGenNote') : '',
        }),
      });
      if (r.driverError) toast({ type: 'warn', title: t('toast.driverWriteWarn'), body: r.driverError });
      fillSettings(r.settings);
      refreshStatus();
    });
  }
  if ($('btnDrvReload')) $('btnDrvReload').addEventListener('click', () => refreshDrivers());
  if ($('btnDrvFolder')) {
    $('btnDrvFolder').addEventListener('click', async () => {
      const r = await api.driversOpenFolder().catch(() => null);
      if (!r || !r.ok) toast({ type: 'error', title: t('toast.cannotOpenDriverDir') });
    });
  }
  if ($('btnDrvImport')) {
    $('btnDrvImport').addEventListener('click', async () => {
      const r = await api.driversImport().catch(() => null);
      if (!r || r.canceled) return;
      if (!r.ok) {
        toast({ type: 'error', title: t('toast.driverImportFailed'), body: (r.errors || []).slice(0, 3).join('; ') });
        return;
      }
      toast({ type: 'ok', title: t('toast.driverImported'), body: `${r.driver.name} v${r.driver.version}` });
      if (r.overview) renderDrivers(r.overview);
    });
  }
  if ($('btnDrvExport')) {
    $('btnDrvExport').addEventListener('click', async () => {
      const r = await api.driversExportTemplate().catch(() => null);
      if (!r || r.canceled) return;
      if (!r.ok) { toast({ type: 'error', title: t('toast.diagExportFailed') }); return; }
      toast({ type: 'ok', title: t('toast.templateExported'), body: t('toast.templateExportedBody') });
      refreshDrivers();
    });
  }

  $('setAdbPath').addEventListener('change', (e) => save({ adbPath: e.target.value.trim() }));
  $('setSystemImage').addEventListener('change', (e) => save({ runtime: { isoPath: e.target.value.trim() } }));
  // 内存 / 核心：填了具体值就关掉「自动」，填 0 又回到自动。
  // 旧代码只写 memoryMB，而 overridesFromSettings 只在 autoMemory=false 时才认它，
  // 于是「手动填了内存」一直被忽略 —— 这是设置页最容易被当成“没用”的一项。
  $('setMemory').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { memoryMB: v, autoMemory: false } } : { engine: { memoryMB: 0, autoMemory: true } });
  });
  $('setCores').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { cores: v, autoMemory: false } } : { engine: { cores: 0, autoMemory: true } });
  });
  if ($('setResourceMode')) {
    $('setResourceMode').addEventListener('change', async (e) => {
      // 资源策略会连带改 liteMode / priorityMode / renderSize（主进程里翻译）
      state.settings = await api.setSettings({ engine: { resourceMode: e.target.value } });
      fillSettings(state.settings);
      toast({ title: t('toast.resourcePolicySwitched'), body: t('toast.takesEffectNextApp'), type: 'ok' });
    });
  }
  if ($('setRenderSize')) {
    $('setRenderSize').addEventListener('change', (e) => save({ engine: { renderSize: e.target.value } }));
  }
  if ($('setFastDns')) {
    $('setFastDns').addEventListener('change', (e) => save({ engine: { fastDns: e.target.checked } }));
  }
  if ($('setLocale')) {
    $('setLocale').addEventListener('change', async (e) => {
      state.settings = await api.setSettings({ engine: { locale: e.target.value, _localeExplicit: true } });
      toast({ title: t('toast.systemLangUpdated'), body: t('toast.systemLangUpdatedBody'), type: 'ok' });
    });
  }
  if ($('setChineseIme')) {
    $('setChineseIme').addEventListener('change', async (e) => {
      state.settings = await api.setSettings({ engine: { chineseIme: e.target.checked, _chineseImeExplicit: true } });
      toast({
        title: e.target.checked ? t('toast.chineseImeEnabled') : t('toast.chineseImeDisabled'),
        body: t('toast.systemLangUpdatedBody'),
        type: 'ok',
      });
    });
  }
  if ($('setKeepSnapshot')) {
    $('setKeepSnapshot').addEventListener('change', (e) => save({ engine: { keepSnapshot: e.target.checked } }));
  }
  if ($('setDataGB')) {
    $('setDataGB').addEventListener('change', (e) => {
      save({ engine: { dataPartitionGB: Number(e.target.value) || 0 } });
      refreshDataInfo();
    });
  }
  if ($('btnGrowData')) {
    $('btnGrowData').addEventListener('click', async () => {
      const gb = Number($('setDataGB').value) || 0;
      if (!gb) { toast({ title: t('settings.dataPartition'), body: t('setup.fullAutoDesc'), type: 'info' }); return; }
      const { response } = await api.confirm({
        title: t('confirm.growDataTitle'),
        message: t('confirm.growDataMsg', { gb }),
        detail: t('confirm.growDataDetail'),
        okLabel: t('confirm.growDataOk'),
      });
      if (response !== 1) return;
      $('btnGrowData').disabled = true;
      const old = $('btnGrowData').textContent;
      $('btnGrowData').textContent = t('setup.preparing');
      const r = await api.setDataSize(gb).catch((e) => ({ ok: false, error: e.message }));
      $('btnGrowData').disabled = false;
      $('btnGrowData').textContent = old;
      if (r && !r.ok && r.needsReset) {
        // 快速启动的差量盘挡着：就地扩容做不到，只能按新容量重建 /data。
        // 这是明确的数据丢失操作，必须单独再确认一次。
        const again = await api.confirm({
          title: t('confirm.growDataResetTitle'),
          message: t('confirm.growDataResetMsg', { gb }),
          detail: t('confirm.growDataResetDetail'),
          okLabel: t('confirm.growDataResetOk'),
        });
        if (again.response !== 1) { refreshDataInfo(); return; }
        $('btnGrowData').disabled = true;
        $('btnGrowData').textContent = t('setup.preparing');
        const rr = await api.resetAndResize(gb).catch((e) => ({ ok: false, error: e.message }));
        $('btnGrowData').disabled = false;
        $('btnGrowData').textContent = old;
        toast({
          type: rr && rr.ok ? 'ok' : 'error',
          title: rr && rr.ok ? t('toast.snapshotInvalidated') : t('common.failed'),
          body: (rr && rr.error) || '',
        });
        refreshDataInfo();
        return;
      }
      toast({
        type: r && r.ok ? 'ok' : 'error',
        title: r && r.ok ? t('settings.btnGrowData') : t('common.failed'),
        body: r && r.ok ? `${r.fsGB || r.imageGB || gb} GB` : ((r && r.error) || ''),
      });
      refreshDataInfo();
    });
  }
  $('setIdle').addEventListener('change', (e) => save({ engine: { idleShutdownMinutes: Number(e.target.value) || 0 } }));
  if ($('setSourcePref')) {
    $('setSourcePref').addEventListener('change', (e) => save({ runtime: { sourcePreference: e.target.value } }));
  }
  if ($('setAutoMirror')) {
    $('setAutoMirror').addEventListener('change', (e) => save({ runtime: { autoMirror: e.target.checked } }));
  }
  if ($('setGiteeToken')) {
    $('setGiteeToken').addEventListener('change', (e) => save({ runtime: { giteeToken: e.target.value.trim() } }));
  }
  if ($('setMirrorPrefix')) {
    $('setMirrorPrefix').addEventListener('change', (e) => save({ runtime: { mirrorPrefix: e.target.value.trim() } }));
  }
  if ($('setConnections')) {
    $('setConnections').addEventListener('change', (e) => {
      const n = Math.max(1, Math.min(16, Number(e.target.value) || 8));
      e.target.value = n;
      save({ runtime: { downloadConnections: n } });
    });
  }
  $('setAudio').addEventListener('change', (e) => save({ engine: { audio: e.target.checked } }));
  $('setLiteMode').addEventListener('change', (e) => save({ engine: { liteMode: e.target.checked } }));
  $('setPrewarm').addEventListener('change', (e) => save({ engine: { prewarm: e.target.checked } }));
  $('setPriorityMode').addEventListener('change', (e) => save({ engine: { priorityMode: e.target.value } }));
  const savePointer = async (patch) => {
    await save({ engine: patch });
    // 立刻按当前窗口焦点重装/卸载钩子，不用等下次切窗口
    api.refreshPointerMapping().catch(() => {});
  };
  $('setMouseRightBack').addEventListener('change', (e) => savePointer({ mouseRightBack: e.target.checked }));
  $('setMouseWheelMode').addEventListener('change', (e) => savePointer({ mouseWheelMode: e.target.value }));
  $('setMouseSideButtons').addEventListener('change', (e) => savePointer({ mouseSideButtons: e.target.checked }));
  if ($('setKeymapEnabled')) {
    $('setKeymapEnabled').addEventListener('change', async (e) => {
      await api.keymap.setEnabled(e.target.checked);
      toast({ title: e.target.checked ? t('toast.keymapEnabled') : t('toast.keymapDisabled'), type: 'ok' });
    });
  }
  $('setDeepTrim').addEventListener('change', async (e) => {
    await save({ engine: { deepTrim: e.target.checked } });
    // 关掉深度裁剪必须把之前 pm disable-user 的包恢复回来，否则影响是持久的
    if (!e.target.checked) {
      api.restoreSystemApps().catch(() => {});
      toast({ title: t('toast.systemComponentsRestored'), body: t('toast.systemComponentsRestoredBody'), type: 'info' });
    }
  });
  $('setCompat').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await save({ runtime: { compatImage: on } });
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (on && !ok) toast({ title: t('toast.armCompatEnabled'), body: t('toast.armCompatNeedDownload'), type: 'info' });
    else if (on) toast({ title: t('toast.armCompatEnabled'), body: t('toast.armImgReadyBody'), type: 'info' });
  });
  $('setAutoShortcut').addEventListener('change', (e) => save({ createShortcutOnInstall: e.target.checked }));
  $('setStartMenuShortcut').addEventListener('change', (e) => save({ createStartMenuShortcut: e.target.checked }));
  $('setShortcutDir').addEventListener('change', (e) => save({ shortcutDir: e.target.value.trim() }));
  $('setDeviceSharedDir').addEventListener('change', (e) => save({ deviceSharedDir: e.target.value.trim() }));
  $('setAutoStart').addEventListener('change', (e) => save({ autoStart: e.target.checked }));
  $('setDisplayMode').addEventListener('change', async (e) => {
    const mode = e.target.value;
    $('portraitField').hidden = mode === 'fullscreen';
    state.settings = await api.setSettings({ display: { mode } });
    toast({ title: mode === 'fullscreen' ? t('toast.switchedFullscreen') : t('toast.switchedPortraitWindow'), type: 'ok' });
  });
  if ($('setAutoFullscreen')) {
    $('setAutoFullscreen').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { autoFullscreenOnLaunch: on } });
      toast({ title: on ? t('toast.autoFullscreenEnabled') : t('toast.autoFullscreenDisabled'), body: t('toast.takesEffectNextApp'), type: 'ok' });
    });
  }
  if ($('setOrientationMode')) {
    $('setOrientationMode').addEventListener('change', async (e) => {
      const mode = e.target.value;
      state.settings = await api.setSettings({ display: { orientationMode: mode } });
      toast({
        title: mode === 'auto' ? t('toast.orientationSetAuto') : (mode === 'landscape' ? t('toast.orientationSetLandscape') : t('toast.orientationSetPortrait')),
        body: mode === 'auto' ? t('toast.orientationAutoDesc') : t('toast.orientationForcedDesc'),
        type: 'ok',
      });
    });
  }
  if ($('setAutoRotate')) {
    $('setAutoRotate').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { autoRotate: on } });
      toast({
        title: on ? t('toast.autoRotateEnabled') : t('toast.autoRotateDisabled'),
        body: t('toast.autoRotateBody'),
        type: 'ok',
      });
    });
  }
  if ($('setTabletMode')) {
    $('setTabletMode').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { tabletMode: on } });
      toast({
        title: on ? t('toast.tabletLayoutEnabled') : t('toast.tabletLayoutDisabled'),
        body: t('toast.tabletLayoutBody'),
        type: 'ok',
      });
    });
  }
  if ($('setLandscape')) {
    $('setLandscape').addEventListener('change', async (e) => {
      const landscape = e.target.value === 'landscape';
      state.settings = await api.setSettings({ display: { landscape } });
      toast({
        title: landscape ? t('toast.panelLandscape') : t('toast.panelPortrait'),
        body: t('toast.panelChangeBody'),
        type: 'ok',
      });
    });
  }
  $('setPortrait').addEventListener('change', async (e) => {
    state.settings = await api.setSettings({ display: { portrait: e.target.value } });
    toast({ title: t('toast.renderSizeUpdated'), body: t('toast.renderSizeBody'), type: 'ok' });
  });
  $('setWindowEmbed').addEventListener('change', async (e) => {
    const embed = e.target.value === 'embed';
    // windowEmbedChosen 标记「用户自己选过」：之后升级不会再被默认值迁移覆盖。
    state.settings = await api.setSettings({
      display: { windowEmbed: embed, windowEmbedChosen: true },
    });
    toast({
      title: embed ? t('toast.switchedToEmbed') : t('toast.switchedToNative'),
      body: embed
        ? t('toast.embedDesc')
        : t('toast.nativeDesc'),
      type: 'ok',
    });
  });
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const r = await api.rebuildShortcuts();
    toast({
      title: r && r.fixed && r.fixed.length ? t('toast.shortcutsRestored') : t('toast.shortcutsIntact'),
      body: r && r.fixed && r.fixed.length ? r.fixed.join(', ') : t('toast.shortcutsIntactBody'),
      type: 'ok',
    });
  });

  $('btnDiagnostics').addEventListener('click', async () => {
    try {
      const r = await api.doctorReport();
      toast({ title: t('toast.diagReportExported'), body: `${(r.diagnosis && r.diagnosis.title) || ''} · ${r.file}`, type: 'ok', sticky: true });
    } catch (e) {
      toast({ title: t('toast.diagExportFailed'), body: e.message, type: 'error' });
    }
  });

  $('btnCleanup').addEventListener('click', async () => {
    const btn = $('btnCleanup');
    const includeSnapshots = $('chkCleanSnapshots') && $('chkCleanSnapshots').checked;
    btn.disabled = true;
    try {
      const preview = await api.runtimeCleanup({ apply: false, includeSnapshots });
      if (!preview.candidates.length) {
        toast({ title: t('toast.alreadyClean'), body: t('toast.alreadyCleanBody'), type: 'ok' });
        return;
      }
      const r = await api.runtimeCleanup({ apply: true, includeSnapshots });
      if (r.cancelled) return;
      toast({
        title: t('toast.cleanupDone'),
        body: t('toast.cleanupDoneBody', { mb: (r.saved / 1048576).toFixed(0), count: r.removed.length }),
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `${t('common.total')} ${u.totalText} · ${t('settings.reclaimable')} ${u.reclaimableText} (${u.count})`;
    } catch (e) {
      toast({ title: t('toast.cleanupFail'), body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // 重置安卓数据：二级确认（先确认意图，再确认不可撤销），清完刷新占用统计
  $('btnResetData').addEventListener('click', async () => {
    const btn = $('btnResetData');
    btn.disabled = true;
    try {
      const first = await api.confirm({
        type: 'warning',
        title: t('confirm.resetDataTitle'),
        message: t('confirm.resetDataTitle'),
        detail: t('confirm.resetDataMsg'),
        buttons: [t('common.cancel'), t('common.confirm')],
        defaultId: 0,
        cancelId: 0,
      });
      if (!first || first.response !== 1) return;
      const second = await api.confirm({
        type: 'warning',
        title: t('confirm.resetDataAgainTitle'),
        message: t('confirm.resetDataAgainMsg'),
        detail: t('confirm.resetDataAgainDetail'),
        buttons: [t('common.cancel'), t('common.confirm')],
        defaultId: 0,
        cancelId: 0,
      });
      if (!second || second.response !== 1) return;
      const r = await api.runtimeResetData();
      if (!r || !r.ok) {
        toast({ title: t('common.failed'), body: (r && r.error) || t('common.retry'), type: 'error' });
        return;
      }
      toast({
        title: t('toast.androidDataResetDone'),
        body: t('toast.androidDataResetBody', { mb: r.reclaimedMB }),
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `${t('common.total')} ${u.totalText} · ${t('settings.reclaimable')} ${u.reclaimableText} (${u.count})`;
    } catch (e) {
      toast({ title: t('common.failed'), body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // 修复网络：安卓里联网页面一直黑屏（红果点「同意并继续」后整屏黑）时用。
  // 根因是虚拟机 /data 里的 Wi-Fi 配置坏了，wlan0 没起来、没有默认路由。
  // Play Store 镜像不允许 root，只能整体重置 /data；应用清单保留，点开时会自动重装。
  $('btnRepairNetwork').addEventListener('click', async () => {
    const btn = $('btnRepairNetwork');
    btn.disabled = true;
    try {
      const ok = await api.confirm({
        type: 'warning',
        title: t('confirm.repairNetworkTitle'),
        message: t('confirm.repairNetworkMsg'),
        detail: t('confirm.repairNetworkDetail'),
        buttons: [t('common.cancel'), t('common.confirm')],
        defaultId: 0,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const r = await api.runtimeRepairNetwork();
      if (!r || !r.ok) {
        toast({
          title: t('toast.networkStillDown'),
          body: (r && r.error) || t('toast.networkStillDownBody'),
          type: 'error',
        });
        return;
      }
      toast({
        title: t('toast.networkRestored'),
        body: r.wiped ? t('toast.networkRestoredWipedBody', { ip: (r.network && r.network.ip) || '' }) : t('toast.networkRestoredSafeBody', { ip: (r.network && r.network.ip) || '' }),
        type: 'ok',
      });
    } catch (e) {
      toast({ title: t('toast.repairFailed'), body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // 清理旧版本残留：扫描旧程序目录 / 失效卸载项 / 更新临时文件，确认后一次性清掉。
  $('btnLeftovers').addEventListener('click', async () => {
    const btn = $('btnLeftovers');
    btn.disabled = true;
    try {
      const r = await api.leftoversScan();
      if (!r || !r.ok) {
        toast({ title: t('common.failed'), body: (r && r.error) || t('common.retry'), type: 'error' });
        return;
      }
      const items = r.items || [];
      if (!items.length) {
        toast({ title: t('toast.leftoversNone'), body: t('toast.alreadyCleanBody'), type: 'ok' });
        return;
      }
      const mb = Math.round((r.totalBytes || 0) / 1048576);
      const lines = items.slice(0, 8).map((x) => `• ${x.note}：${x.path}`);
      if (items.length > 8) lines.push(`... +${items.length - 8}`);
      const ok = await api.confirm({
        type: 'warning',
        title: t('confirm.cleanupLeftovers', { n: items.length, details: lines.join('\n') }),
        buttons: [t('common.cancel'), t('common.confirm')],
        defaultId: 1,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const c = await api.leftoversClean(items);
      if (!c || !c.ok) {
        toast({ title: t('toast.cleanupFail'), body: (c && c.error) || t('common.retry'), type: 'error' });
        return;
      }
      const failNote = '';
      toast({
        title: t('toast.cleanupDone'),
        body: t('toast.cleanupDoneBody', { mb: c.freedMB || 0, count: c.removed.length }),
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `${t('common.total')} ${u.totalText} · ${t('settings.reclaimable')} ${u.reclaimableText} (${u.count})`;
    } catch (e) {
      toast({ title: t('toast.cleanupFail'), body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  $('btnOpenShared').addEventListener('click', () => api.openSharedDir());

  // 重建快捷方式：桌面图标被误删 / 被安全软件拦掉时的兜底入口
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const btn = $('btnRebuildShortcuts');
    btn.disabled = true;
    try {
      const r = await api.rebuildShortcuts().catch(() => ({ ok: false }));
      const fixed = (r && r.fixed) || [];
      toast(fixed.length
        ? { title: t('toast.shortcutsRestored'), body: fixed.join(', '), type: 'ok' }
        : { title: t('toast.shortcutsIntact'), body: t('toast.shortcutsIntactBody'), type: 'info' });
    } finally {
      btn.disabled = false;
    }
  });

  // 共享目录：先浏览选目录，再「保存并迁移」把旧文件一次性搬到新目录
  $('btnBrowseShared').addEventListener('click', async () => {
    const picked = await api.openDir();
    if (!picked) return;
    $('setSharedDir').value = picked;
    toast({ title: t('toast.dirSelected'), body: t('toast.dirSelectedBody'), type: 'info' });
  });
  $('btnSaveShared').addEventListener('click', async () => {
    const dir = $('setSharedDir').value.trim();
    if (!dir) { toast({ title: t('toast.fillDirFirst'), type: 'error' }); return; }
    const btn = $('btnSaveShared');
    btn.disabled = true;
    const r = await api.setSharedDir(dir).catch(() => ({ ok: false }));
    btn.disabled = false;
    if (r.ok) {
      const moved = r.oldDir && r.oldDir !== r.newDir;
      toast({ title: t('toast.sharedDirUpdated'), body: moved ? t('toast.sharedDirMoved') : t('common.done'), type: 'ok' });
    } else {
      toast({ title: t('toast.saveFailed'), body: r.error, type: 'error' });
    }
  });

  // 一键卸载 ApkStart 本体（取消 .apk 关联 + 启动卸载程序；便携版手动删除）
  $('btnUninstall').addEventListener('click', async () => {
    const ok = window.confirm(t('confirm.uninstallApp'));
    if (!ok) return;
    const btn = $('btnUninstall');
    btn.disabled = true;
    const r = await api.removeSelf().catch(() => ({ ok: false }));
    if (r.ok && r.portable) {
      btn.disabled = false;
      toast({
        title: t('toast.portableCannotAutoUninstall'),
        body: t('toast.portableManualDelete', { exeDir: r.exeDir, dataDir: r.dataDir }),
        type: 'info', sticky: true,
      });
      return;
    }
    if (!r.ok) {
      btn.disabled = false;
      toast({ title: t('toast.uninstallFailed'), body: r.error, type: 'error' });
      return;
    }
    toast({ title: t('toast.uninstalling'), body: t('toast.uninstallingBody'), type: 'ok', sticky: true });
  });

  // ARM 兼容镜像下载（带进度 toast）
  $('btnInstallPlay').addEventListener('click', async () => {
    const btn = $('btnInstallPlay');
    btn.disabled = true;
    const t = toast({ title: t('toast.downloadArmImgStart'), body: t('common.loading'), sticky: true, spinner: true, progress: 3 });
    const un = api.on('provision:progress', (p) => {
      if (p.component !== 'playimg') return;
      t.update({ title: t('toast.downloadArmImgTitle'), body: p.message || '', progress: p.percent });
    });
    try {
      const r = await api.installPlayImage();
      if (r && r.ok) {
        t.update({ title: t('toast.armImgReady'), body: t('toast.armImgReadyBody'), progress: 100 });
        setTimeout(() => t.dismiss(), 3000);
        $('compatInstallField').hidden = true;
        refreshStatus();
      } else {
        t.update({ title: t('toast.armImgFailed'), body: (r && r.error) || t('common.unknown'), progress: null });
        t.dismiss();
        toast({ title: t('toast.armImgFailed'), body: (r && r.error) || t('common.unknown'), type: 'error' });
      }
    } catch (e) {
      t.dismiss();
      toast({ title: t('toast.armImgFailed'), body: e.message, type: 'error' });
    } finally {
      un();
      btn.disabled = false;
    }
  });

  // 兼容镜像状态显示
  (async () => {
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const s = state.settings;
    const on = !!(s && s.runtime && s.runtime.compatImage);
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (env.playImage) {
      $('compatImgStatus').textContent = ok
        ? t('android.armReady', { size: (env.playImage.size / 1073741824).toFixed(2) }) : t('android.armNotDownloaded');
    }
  })();
  $('btnOpenData').addEventListener('click', async () => {
    const info = await api.info();
    const dir = info.runtimeDir || info.dataDir;
    window.open(`file:///${dir.replace(/\\/g, '/')}`);
  });
  $('btnBrowseRuntimeDir').addEventListener('click', async () => {
    const info = await api.info();
    const picked = await api.openDir();
    if (!picked) return;
    await api.setSettings({ runtime: { dir: picked } });
    $('setRuntimeDir').value = picked;
    toast({ title: t('toast.dataDirUpdated'), body: t('toast.restartApkStartEffective'), type: 'ok', sticky: true });
  });

  // 安卓数据目录（AVD + 快照）：真正吃盘的那块，单独指到别的盘
  if ($('btnBrowseAvdDir')) {
    $('btnBrowseAvdDir').addEventListener('click', async () => {
      const picked = await api.openDir();
      if (!picked) return;
      await api.setSettings({ runtime: { avdDir: picked } });
      $('setAvdDir').value = picked;
      toast({
        title: t('toast.dataDirUpdated'),
        body: t('toast.androidDataDirUpdatedBody'),
        type: 'ok',
        sticky: true,
      });
    });
  }
  if ($('btnOpenAvdDir')) {
    $('btnOpenAvdDir').addEventListener('click', async () => {
      const info = await api.dataInfo().catch(() => null);
      const dir = (info && info.avdDir) || (await api.info()).dataDir;
      window.open(`file:///${String(dir).replace(/\\/g, '/')}`);
    });
  }

  $('btnRuntimeStart').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = t('android.starting');
    const r = await api.runtimeStart();
    el.textContent = r.ok ? t('android.readyEngine', { engine: r.engine }) : t('android.startFailed', { error: r.error });
    refreshStatus();
  });

  $('btnRuntimeStop').addEventListener('click', async () => {
    await api.runtimeStop();
    $('probeResult').textContent = t('android.stoppedBuiltinVm');
    refreshStatus();
  });

  $('btnAssoc').addEventListener('click', async () => {
    const btn = $('btnAssoc');
    if (btn.dataset.on === '1') {
      await api.assocUnregister();
      btn.textContent = t('settings.assocUnlinked');
      btn.dataset.on = '0';
      toast({ title: t('toast.assocCancelled') });
    } else {
      const r = await api.assocRegister();
      btn.textContent = t('settings.assocLinked');
      btn.dataset.on = '1';
      toast({ title: t('toast.assocEnabled'), body: r.ok ? t('toast.assocEnabledBody') : '', type: r.ok ? 'ok' : 'error' });
    }
  });
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  // 链接统一走系统浏览器
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="http"]');
    if (!a) return;
    e.preventDefault();
    api.openExternal(a.getAttribute('href'));
  });

  $('btnSettings').addEventListener('click', openSettings);
  // 0.6.2：内置手册从标题栏和「关于」页都能直接打开
  $('btnManual')?.addEventListener('click', () => openManual({ topic: 'overview', reason: 'toolbar' }));
  $('btnOpenManual')?.addEventListener('click', () => openManual({ topic: 'overview', reason: 'about' }));
  // 状态标签也当入口：点「需要部署 / 引导中 / Android 14」直接进设置的运行时面板
  $('engineTag').addEventListener('click', () => showSetup(true));
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnDoneSettings').addEventListener('click', closeSettings);
  $('settingsMask').addEventListener('click', (e) => {
    if (e.target === $('settingsMask')) closeSettings();
  });

  // 运行时部署：入口已收进设置，这里只处理面板内的按钮
  $('btnDeployAll').addEventListener('click', deployAll);
  $('btnMarkInstalled').addEventListener('click', markInstalled);
  $('btnGuideClose').addEventListener('click', () => { $('setupGuide').hidden = true; });
  $('btnSetupAdvanced').addEventListener('click', () => {
    const adv = document.querySelector('.advanced-group');
    if (adv) {
      adv.open = true;
      adv.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });

  // 状态条上的自检计数：点开就是设置里的运行时面板
  $('envChip').addEventListener('click', () => {
    openSettings().then(() => {
      const box = $('envCheck');
      if (box && !box.hidden) focusGroup(box);
      else focusGroup($('runtimeGroup'));
    }).catch(() => {});
  });

  $('setupSteps').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'emulator' || act === 'sysimg' || act === 'accel'
      || act === 'adb' || act === 'qemu' || act === 'iso' || act === 'disk') {
      const r = await runStep(act);
      if (!r.ok) toast({ title: t('toast.opFailed'), body: r.error, type: 'error', sticky: true });
      return;
    }
    if (act === 'isoImport') {
      const r = await api.importIso();
      if (r.ok) { toast({ title: t('toast.sysimgImported'), body: r.path, type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: t('toast.importFailed'), body: r.error, type: 'error' });
      return;
    }
    if (act === 'diskImport') {
      const r = await api.importDisk();
      if (r.ok) { toast({ title: t('toast.vdiskImported'), body: t('toast.canStartRuntime'), type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: t('toast.importFailed'), body: r.error, type: 'error' });
      return;
    }
    if (act === 'install') { await startInstall(); return; }
    if (act === 'vmStart') {
      const t = toast({ title: t('toast.startingRuntime'), body: t('toast.firstBootGuide'), sticky: true, spinner: true });
      const r = await api.runtimeStart();
      if (r.ok) { t.update({ title: t('toast.runtimeReady'), type: 'ok' }); setTimeout(t.dismiss, 2200); }
      else t.update({ title: t('android.startFailed', { error: r.error }), body: r.error, type: 'error' });
      refreshStatus();
      return;
    }
    if (act === 'vmStop') {
      await api.runtimeStop();
      toast({ title: t('toast.runtimeSessionEnded') });
      refreshStatus();
    }
  });

  const pick = async () => {
    const files = await api.pickApk();
    if (files.length) installFiles(files);
  };
  $('btnInstall').addEventListener('click', pick);
  $('btnInstall2').addEventListener('click', pick);
  // 共享目录入口移到设置里：同步 + 打开都在「文件互通」组内
  const btnSync = $('btnSyncShared');
  if (btnSync) btnSync.addEventListener('click', async () => {
    btnSync.disabled = true;
    try {
      await api.syncShared();
      toast({ title: t('toast.syncedSharedDir'), type: 'ok' });
    } catch (_) {
      toast({ title: t('toast.syncFailed'), body: t('toast.syncSkipNotReady'), type: 'error' });
    } finally {
      btnSync.disabled = false;
    }
  });

  $('search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderGrid();
  });

  $('grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    // 「添加应用」卡片没有 data-pkg，走安装流程而不是启动。
    // 直接转调工具栏那个「安装 APK」按钮，复用它的文件选择逻辑。
    if (card.classList.contains('card-add')) { $('btnInstall').click(); return; }
    if (card.dataset.pkg) launchApp(card.dataset.pkg);
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
    else toast({ title: t('toast.onlyApkAllowed'), type: 'error' });
  });

  // 主进程事件
  api.on('install:error', (p) => {
    // 报错了就别再让「正在安装…」那条一直转圈（可能来自双击 APK 的另一条链路）
    if (installToast) { try { installToast.dismiss(); } catch (_) { /* ignore */ } installToast = null; }
    const name = p && p.file ? String(p.file).split(/[\\/]/).pop() : '';
    const raw = (p && p.message) || t('common.unknown');
    toast({
      title: name ? t('toast.installFailedApp', { name }) : t('toast.installFailed'),
      body: friendlyInstallErrorText(raw),
      type: 'error',
    });
    // 0.6.2：安装失败自动把对应章节推到用户面前（ARM / 签名 / 空间…）
    openManualForError(raw, 'install-failed');
  });
  api.on('toast', (p) => toast({ title: p.message, type: p.type === 'error' ? 'error' : 'info' }));
  api.on('app:launched', () => setTimeout(refreshApps, 800));
  // 应用被关掉（托盘「关闭当前应用」、右键菜单、或窗口被关）后要刷新「运行中」标记
  api.on('apps:changed', () => setTimeout(refreshApps, 300));
  api.on('runtime:log', (m) => console.log('[runtime]', m));
  api.on('ui:navigate', (v) => {
    if (v === 'settings') openSettings();
    if (v === 'setup') { showSetup(true); refreshStatus(); }
  });
  api.on('provision:progress', (p) => updateStepProgress(p.component, p));
  api.on('update:state', (info) => {
    if (!info) return;
    renderUpdate(info);
    // 启动 8 秒后才拿到更新信息：欢迎卡若还开着，把「发现新版本」这条补进去
    const wm = $('welcomeMask');
    if (wm && !wm.hidden) renderWelcomeTips();
  });
  api.on('update:progress', (p) => renderUpdateProgress(p));
  // 自动检测：主进程定时跑完后把结果推过来，设置页开着就直接刷新面板
  api.on('autodebug:state', (r) => {
    if (r && r.running) {
      const txt = $('autodebugStateText');
      if (txt) txt.textContent = t('autodebug.running');
      return;
    }
    renderAutodebug(r);
  });
}

/* ---------------- 语言切换 ---------------- */

function applyLanguage(lang) {
  state.locale = lang || 'en';
  if (api && api.i18n) {
    api.i18n.setLocale(state.locale);
  } else if (window.apkstartI18n) {
    window.apkstartI18n.setLocale(state.locale);
  }
  const i18n = window.apkstartI18n || (api && api.i18n);
  if (i18n) {
    i18n.translateDOM(document, state.locale);
  }
  document.documentElement.lang = state.locale;
  document.documentElement.dir = (state.locale === 'ar' ? 'rtl' : 'ltr');

  if ($('setLanguage')) $('setLanguage').value = state.locale;
  try { renderGrid(); } catch (_) {}
  try { updateStats(); } catch (_) {}
  try { refreshStatus(); } catch (_) {}
  try { if (state.status) renderSetup(state.status); } catch (_) {}
  try { if (lastEnvCheck) renderEnvCheck(lastEnvCheck); } catch (_) {}
  try { if (lastDrivers) renderDrivers(lastDrivers); } catch (_) {}
  try { if (lastPreflight) renderPreflight(lastPreflight); } catch (_) {}
  try { if (state.autodebug) renderAutodebug(state.autodebug); } catch (_) {}
  try { if (lastUpdate) renderUpdate(lastUpdate); } catch (_) {}
}

/* ---------------- 启动 ---------------- */

async function init() {
  bindEvents();
  bindSettings();
  bindSettingsCategory();
  bindAutodebug();
  bindUpdate();
  bindAndroid();
  bindWelcome();
  state.settings = await api.getSettings().catch(() => ({}));
  applyLanguage(state.settings?.language || 'en');
  if (api && api.on) {
    api.on('i18n:change', (lang) => {
      if (lang && lang !== state.locale) applyLanguage(lang);
    });
  }
  await refreshStatus();
  await refreshApps();
  refreshAndroid();
  selfCheck();
  maybeShowWelcome();
  setInterval(refreshStatus, 6000);
  setInterval(refreshApps, 15000);
  setInterval(selfCheck, 60000);
}

/* ---------------- 启动欢迎卡 ---------------- */

let startupInfo = null;

function greetingOf(h) {
  if (h < 5) return t('greeting.lateNight');
  if (h < 11) return t('greeting.morning');
  if (h < 13) return t('greeting.noon');
  if (h < 18) return t('greeting.afternoon');
  return t('greeting.evening');
}

function bindWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  const close = () => { mask.hidden = true; };
  const never = $('welcomeNever');
  $('welcomeOk').addEventListener('click', () => {
    if (never && never.checked) api.setSettings({ welcome: { disabled: true } }).catch(() => {});
    close();
  });
  $('welcomeSettings').addEventListener('click', () => { close(); openSettings(); });
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mask.hidden) close(); });
}

/** 决定要不要弹：开机自启必弹；手动打开则每天最多一次，且用户可永久关闭 */
async function maybeShowWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  // 冒烟截图时不要弹欢迎卡：否则每次自动截图都被它挡住主界面
  try { if ((await api.startupInfo()).smoke) return; } catch (_) { /* ignore */ }
  try { startupInfo = await api.startupInfo(); } catch (_) { startupInfo = null; }
  const cfg = (state.settings && state.settings.welcome) || {};
  if (cfg.disabled) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!(startupInfo && startupInfo.autostart) && cfg.lastDate === today) return;

  const h = new Date().getHours();
  $('welcomeHi').textContent = t('welcome.title', { greeting: greetingOf(h) });
  const ver = (startupInfo && startupInfo.version) || (state.status && state.status.version) || '';
  const ready = state.status && state.status.ready;
  $('welcomeSub').textContent = `ApkStart${ver ? ` v${ver}` : ''} · ${ready ? t('welcome.ready') : t('welcome.autoPrepare')}`;

  const apps = (state.apps || []).length;
  const dev = $('statusDevice') ? $('statusDevice').textContent.trim() : '';
  const chips = [
    { k: String(apps), v: t('welcome.installedApps') },
    { k: ready ? t('welcome.ready') : t('welcome.standby'), v: t('welcome.runtime') },
    { k: dev ? dev.replace(/^.*?(\d+)/, '$1') : '—', v: t('welcome.devicePort') },
  ];
  $('welcomeStats').innerHTML = chips
    .map((c) => `<div class="welcome-stat"><b>${esc(c.k)}</b><span>${esc(c.v)}</span></div>`)
    .join('');

  const tips = [];
  $('welcomeTips').innerHTML = '';
  mask.hidden = false;
  renderWelcomeTips();
  api.setSettings({ welcome: { lastDate: today } }).catch(() => {});
}

/** 提示区单独渲染：启动 8 秒后才拿到更新信息，那时卡片可能还开着，需要补一次 */
function renderWelcomeTips() {
  const box = $('welcomeTips');
  if (!box) return;
  const apps = (state.apps || []).length;
  const tips = [];
  if (lastUpdate && lastUpdate.hasUpdate) {
    tips.push(t('welcome.tipNewVersion', { tag: esc(lastUpdate.tag || '') }));
  }
  if (!apps) {
    tips.push(t('welcome.tipDragApk'));
  } else {
    tips.push(t('welcome.tipDoubleClick'));
  }
  tips.push(t('welcome.tipCloseWindow'));
  box.innerHTML = tips
    .map((t, i) => `<div class="welcome-tip"><i>${i + 1}</i><span>${t}</span></div>`)
    .join('');
}

/* ---------------- 环境自检 ---------------- */

let envBusy = false;

/** 拉取 doctor:selfCheck：把问题渲染到设置里的自检面板，并在状态条上留一个计数 */
async function selfCheck() {
  if (envBusy) return;
  envBusy = true;
  try {
    const r = await api.selfCheck().catch(() => null);
    if (r) renderEnvCheck(r);
  } catch (_) { /* 自检失败不阻断主流程 */ }
  finally { envBusy = false; }
}

let lastEnvCheck = null;

function renderEnvCheck(r) {
  lastEnvCheck = r;
  const box = $('envCheck');
  if (!box) return;
  // 「组件缺失」在同一个面板的一键完成里已经覆盖，不再重复列出
  const needDeploy = !!(state.status && state.status.needsSetup);
  const issues = (r.issues || []).filter((i) => !(needDeploy && i.fix === 'deploy'));

  // 主界面不再放横幅：只在底部状态条上留一个可点的计数，点开就是设置里的自检面板
  const chip = $('envChip');
  if (chip) {
    const errs = issues.filter((i) => i.severity === 'error').length;
    chip.hidden = issues.length === 0;
    chip.textContent = errs ? t('envcheck.itemsPending', { n: errs }) : t('envcheck.itemsNotice', { n: issues.length });
    chip.className = `status-chip${errs ? ' err' : ''}`;
    chip.title = issues.map((i) => t('issue.' + i.code + '.title') || i.title).join('；');
  }

  if (!issues.length) {
    box.hidden = false;
    box.innerHTML = `
      <div class="env-check-ok">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
        <span>${esc(t('envcheck.passMsg'))}</span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" id="btnEnvRecheck">${esc(t('envcheck.recheck'))}</button>
      </div>`;
    const re = $('btnEnvRecheck');
    if (re) re.addEventListener('click', selfCheck);
    return;
  }
  const errs = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.length - errs;
  box.hidden = false;
  box.innerHTML = `
    <div class="env-check-head">
      <span class="ec-title">${esc(t('envcheck.title'))}</span>
      ${errs ? `<span class="ec-count">${esc(t('envcheck.errorCount', { n: errs }))}</span>` : ''}
      ${warns ? `<span class="ec-count warn">${esc(t('envcheck.warnCount', { n: warns }))}</span>` : ''}
      <span class="ec-spacer"></span>
      <button class="btn ghost sm" id="btnEnvRecheck">${esc(t('envcheck.recheck'))}</button>
      <button class="btn primary sm" id="btnEnvFixAll">${esc(t('envcheck.fixAll'))}</button>
    </div>
    <div class="env-check-list">
      ${issues.map((i) => {
        const itemTitle = t('issue.' + i.code + '.title') || i.title;
        const itemHint = t('issue.' + i.code + '.hint') || i.hint || '';
        return `
        <div class="env-check-item ${i.severity}">
          <span class="ec-sev"></span>
          <div class="ec-body">
            <div class="ec-name">${esc(itemTitle)}</div>
            <div class="ec-hint">${esc(itemHint)}</div>
          </div>
          ${i.fix ? `<button class="ec-fix" data-code="${esc(i.code)}">${esc(t('envcheck.fix'))}</button>` : ''}
          <button class="ec-help" data-code="${esc(i.code)}" title="${esc(t('autodebug.openTutorial'))}">${esc(t('autodebug.tutorial'))}</button>
        </div>`;
      }).join('')}
    </div>`;
  const re = $('btnEnvRecheck');
  if (re) re.addEventListener('click', selfCheck);
  const fixAll = $('btnEnvFixAll');
  if (fixAll) fixAll.addEventListener('click', () => fixAllIssues(issues));
  box.querySelectorAll('.ec-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });
  box.querySelectorAll('.ec-help').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) openManualForIssue(issue, 'clicked');
    });
  });
}

/** 修复没成功：如实报错，并把对应教程自动打开（同一章节主进程 60 秒内只弹一次） */
function failFix(issue, ctl, body) {
  const msg = body || t('envcheck.followTutorial');
  if (ctl && typeof ctl.update === 'function') ctl.update({ body: msg, type: 'error', sticky: true });
  else toast({ title: t('envcheck.fixNotComplete'), body: msg, type: 'error' });
  openManualForIssue(issue, 'fix-failed');
}

async function fixIssue(issue) {
  switch (issue.fix) {
    case 'vcRedist': {
      const r = await api.installVcRedist().catch(() => ({ ok: false }));
      if (!r.ok && r.reason === 'no-installer') {
        api.openExternal('https://learn.microsoft.com/zh-CN/cpp/windows/latest-supported-vc-redist?view=msvc-170#visual-studio-2015-2017-2019-and-2022');
        toast({ title: t('toast.actionCancelled'), body: 'https://learn.microsoft.com', type: 'info' });
        break;
      }
      toast(r.ok
        ? { title: t('setup.accelEnabled'), type: 'ok' }
        : { title: t('setup.accelFailed'), body: r.error || t('common.retry'), type: 'error' });
      break;
    }
    case 'virtualization': {
      const tEl = toast({ title: t('setup.accelInstalling'), body: t('setup.accelInstallHint'), sticky: true, spinner: true });
      const r = await api.enableVirtualization().catch(() => ({ ok: false }));
      if (r.ok) {
        tEl.update({ title: t('setup.accelEnabled'), body: r.restartNeeded ? t('issue.accel.store.hint') : (r.note || ''), type: 'ok' });
        setTimeout(tEl.dismiss, 3200);
      } else if (r.manual) {
        tEl.dismiss();
        await api.openWindowsFeatures?.().catch(() => null);
        toast({
          title: t('issue.accel.store.title'),
          body: r.note || t('issue.accel.store.hint'),
          type: 'info',
          sticky: true,
        });
        openManualForIssue(issue, 'fix-failed');
      } else if (r.cancelled) {
        tEl.update({ title: t('toast.actionCancelled'), body: r.error || t('toast.actionCancelledDesc'), type: 'info', spinner: false });
        setTimeout(tEl.dismiss, 4200);
      } else {
        failFix(issue, tEl, r.error || r.note || t('setup.accelFailed'));
      }
      break;
    }
    case 'disk': {
      const r = await api.runtimeCleanup({ apply: true }).catch(() => null);
      if (!r) { toast({ title: t('toast.cleanupFailed'), body: t('common.retry'), type: 'error' }); break; }
      if (r.cancelled) break;
      toast({ title: t('toast.cleanupSuccess'), body: t('toast.cleanupFreed', { mb: ((r.saved || 0) / 1048576).toFixed(0) }), type: 'ok' });
      break;
    }
    case 'path': {
      toast({ title: t('toast.suggestAsciiPath'), body: t('toast.suggestAsciiPathBody'), type: 'info', sticky: true });
      openSettings();
      break;
    }
    case 'deploy': {
      toast({ title: t('setup.preparing'), type: 'info', sticky: true, spinner: true });
      await deployAll();
      break;
    }
    case 'lock': {
      const r = await api.clearLocks().catch(() => ({ ok: false }));
      toast(r.ok ? { title: t('toast.lockingCleaned'), type: 'ok' } : { title: t('toast.cleanupFailed'), body: r.error, type: 'error' });
      break;
    }
    case 'restartRuntime': {
      const tEl = toast({ title: t('toast.restartingRuntime'), body: t('toast.restartingRuntimeBody'), type: 'info', sticky: true, spinner: true });
      const r = await api.restartRuntime().catch(() => ({ ok: false }));
      if (r && r.ok) {
        tEl.update({ title: t('toast.runtimeRestarted'), body: t('toast.allowUsbDebugging'), type: 'ok' });
        setTimeout(tEl.dismiss, 3000);
      } else {
        failFix(issue, tEl, (r && r.error) || t('common.retry'));
      }
      break;
    }
    case 'orphans': {
      const r = await api.clearOrphans().catch(() => ({ ok: false }));
      toast(r && r.ok
        ? { title: t('toast.orphansCleaned'), type: 'ok' }
        : { title: t('toast.cleanupFailed'), body: (r && r.error) || t('common.retry'), type: 'error' });
      break;
    }
    case 'snapshots': {
      const r = await api.clearSnapshot().catch(() => ({ ok: false }));
      toast(r && r.ok
        ? { title: t('toast.snapshotInvalidated'), body: t('toast.snapshotInvalidatedBody'), type: 'ok' }
        : { title: t('toast.cleanupFailed'), body: (r && r.error) || t('common.retry'), type: 'error' });
      break;
    }
    case 'dataReset': {
      toast({
        title: t('confirm.growDataResetTitle'),
        body: t('confirm.growDataResetDetail'),
        type: 'info',
        sticky: true,
      });
      openSettings().then(() => focusGroup($('perfGroup'))).catch(() => {});
      break;
    }
    case 'orientation': {
      const s = (state.settings && state.settings.display) || {};
      const mode = s.orientationMode || 'auto';
      if (mode === 'auto') {
        toast({ title: t('toast.orientationSet', { mode: t('toast.orientAuto') }), body: t('toast.orientationNote'), type: 'info' });
        break;
      }
      const wantLandscape = mode === 'landscape';
      state.settings = await api.setSettings({ display: { landscape: wantLandscape } });
      fillSettings(state.settings);
      toast({
        title: wantLandscape ? t('toast.orientationSet', { mode: t('toast.orientLandscape') }) : t('toast.orientationSet', { mode: t('toast.orientPortrait') }),
        body: t('toast.orientationNote'),
        type: 'ok',
      });
      break;
    }
    case 'shared': {
      toast({ title: t('settings.localSharedDir'), body: t('settings.sharedSub'), type: 'info', sticky: true });
      openSettings().then(() => focusGroup(document.querySelector('#settingsBody [data-cat="files"]'))).catch(() => {});
      break;
    }
    case 'audio': {
      const tEl = toast({ title: t('settings.audio'), body: t('toast.restartingRuntime'), type: 'info', sticky: true, spinner: true });
      const s = await api.setSettings({ engine: { audio: true } }).catch(() => null);
      if (!s) { failFix(issue, tEl, t('toast.saveFailed')); break; }
      state.settings = s;
      fillSettings(s);
      const r = await api.restartRuntime().catch(() => ({ ok: false }));
      if (r && r.ok !== false) {
        tEl.update({ title: t('toast.audioTurnedOn'), body: t('toast.audioTurnedOnBody'), type: 'ok' });
        setTimeout(tEl.dismiss, 3600);
      } else {
        failFix(issue, tEl, t('toast.saveFailed'));
      }
      break;
    }
    case 'audioService': {
      toast({ title: t('issue.audio.windowsServiceStopped.title'), body: t('envcheck.followTutorial'), type: 'info', sticky: true });
      openManualForIssue(issue, 'clicked');
      break;
    }
    case 'repairNetwork': {
      const t = toast({ title: t('toast.resettingNetwork'), body: t('toast.appManifestKept'), type: 'info', sticky: true, spinner: true });
      const r = await api.runtimeRepairNetwork().catch(() => ({ ok: false }));
      if (r && r.ok !== false) {
        t.update({ title: t('toast.networkReset'), body: t('toast.reconnectOnLaunch'), type: 'ok' });
        setTimeout(t.dismiss, 3000);
      } else {
        t.update({ title: t('toast.resetFailed'), body: (r && r.error) || t('common.retry'), type: 'error' });
      }
      break;
    }
    case 'report': {
      const r = await api.doctorReport().catch(() => null);
      toast(r && r.ok !== false
        ? { title: t('toast.diagReportExported'), body: t('toast.diagReportBody'), type: 'ok' }
        : { title: t('toast.diagExportFailed'), body: (r && r.error) || t('common.retry'), type: 'error' });
      break;
    }
    case 'settings': {
      openSettings();
      break;
    }
    default:
      toast({ title: t('toast.autoFixNotSupported'), body: issue.hint || '', type: 'info' });
  }
  // 修复后重新自检，刷新横幅与状态
  setTimeout(selfCheck, 600);
  setTimeout(refreshStatus, 600);
}

async function fixAllIssues(issues) {
  const fixable = issues.filter((i) => i.fix);
  for (const i of fixable) {
    // eslint-disable-next-line no-await-in-loop
    await fixIssue(i);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 500));
  }
}

init().catch((e) => {
  console.error(e);
  toast({ title: t('toast.initFailed'), body: e.message, type: 'error', sticky: true });
});
