'use strict';
const { t } = require('../../i18n');
/**
 * 后端适配层（backend driver）—— 把「安卓从哪来」这件事从 Runtime 里抽出来。
 *
 * 背景：ApkStart 原本只有一个底座（自带 Google Android Emulator / QEMU），
 * 引擎的生命周期（开机、快照、空闲回收、镜像下载）全部写死在 core/engine.js 里。
 * 但「双击 APK 装好、双击图标打开、每个应用一个干净窗口」这部分体验，
 * 对底座其实只有三个要求：
 *
 *   1. 有一个能连上的 adb 设备（装包 / 启动 / 输入 / 截图都靠它）；
 *   2. 有一块能拿到 HWND 的安卓画面窗口（用 SetParent 嵌进我们自己的窗口）；
 *   3. 能把这台设备启动 / 停掉。
 *
 * 0.5.6 起只保留一个实现：builtin（自带 emulator + 系统镜像）。
 * 这层接口留着，是为了让 engine.js 里「安卓从哪来」这件事仍然只有一处入口，
 * 也方便以后真要替换运行时的时候不用再动引擎主流程；
 * 但**不再支持任何第三方模拟器 / 系统级运行时**（MuMu / 雷电 / 蓝叠 / WSA 都不接）。
 *
 * 约定（所有实现都必须遵守）：
 *  - 所有方法都可能被并发调用，实现要幂等；重复 ensure() 不能起两台。
 *  - 任何一步失败都返回 { ok:false, error }，不要抛异常给上层（上层只做提示）。
 *  - 不要假设自己独占 adb server：能用自带 adb 就用，用别人的要自己 connect。
 */

/** 底座能力位：上层据此决定哪些菜单/回调要显示或要跳过 */
const CAPS = {
  /** 能自己下载/部署运行时（镜像、emulator、adb） */
  provision: 'provision',
  /** 能保存快速启动快照（二次开机秒进） */
  snapshot: 'snapshot',
  /** 能调整数据分区大小 */
  resizeData: 'resizeData',
  /** 能彻底重置安卓数据（/data） */
  resetData: 'resetData',
  /** 能改物理面板方向（真横屏，靠重启实现） */
  rotatePanel: 'rotatePanel',
  /** 能调进程优先级（把虚拟机让给前台应用） */
  priority: 'priority',
  /** 能彻底关掉自己（卸载/退出时调用） */
  shutdown: 'shutdown',
  /** 画面窗口由第三方软件创建，不能过多「借」它的窗口（避免抢走用户自己的模拟器） */
  sharedHost: 'sharedHost',
};

class Backend {
  /**
   * @param {object} appRoot 程序根目录（打包后是 resources/app）
   * @param {object} deps    共享依赖：{ store, log }
   */
  constructor(appRoot, deps = {}) {
    this.appRoot = appRoot || '';
    this.deps = deps || {};
    /** adb serial（例如 emulator-5554 / 127.0.0.1:16384） */
    this.serial = '';
    /** adb.exe 的绝对路径 */
    this.adbPath = '';
    /** 最近一次错误，供诊断用 */
    this.lastError = '';
  }

  /** 底座的稳定 id（写入设置，不能随意改） */
  static get id() { return 'base'; }

  /** 界面上显示的名字 */
  static get label() { return t('未命名后端'); }

  /** 一句话说明，设置页用它解释这个底座是什么 */
  static get summary() { return ''; }

  /** 这个底座是否满足「嵌入式窗口」要求（不满足的只能当 attach 用） */
  static get embedCapable() { return false; }

  get id() { return this.constructor.id; }

  get label() { return this.constructor.label; }

  /** 能力位集合，见 CAPS */
  get caps() {
    return new Set();
  }

  has(cap) { return this.caps.has(cap); }

  /** 当前底座是否已经在跑（不要求已连上 adb） */
  running() { return false; }

  /**
   * 探测：机器上有没有这个底座。
   * 用于「自动挑一个能用的底座」，必须快（<1.5s）且不产生副作用。
   * @returns {Promise<{ok:boolean, found:boolean, path?:string, detail?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async probe() { return { ok: true, found: false }; }

  /**
   * 就绪检查：用户能不能现在就用它装应用。
   * @returns {Promise<{ok:boolean, reason?:string, needs?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async check() { return { ok: false, reason: t('未实现') }; }

  /** 解析可用的 adb 路径（优先自带，其次底座自带的，最后系统 PATH） */
  async resolveAdb() { return ''; }

  /**
   * 确保运行时可用：没开机就开机、没连上就 connect。
   * @param {object} o { onLog }
   * @returns {Promise<{ok:boolean, serial?:string, adbPath?:string, reused?:boolean, error?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async ensure(o = {}) { return { ok: false, error: t('未实现') }; }

  /**
   * 安卓画面窗口的候选 HWND（十六进制或十进制的字符串数组，按优先级排序）。
   * 上层（WinAgent）拿到后逐个试 SetParent，第一个成立的就算嵌入成功。
   * @returns {Promise<string[]>}
   */
  // eslint-disable-next-line class-methods-use-this
  async windowTargets() { return []; }

  /**
   * 画面窗口是否已经就绪（可以停止隐藏/开始嵌入）。
   * 默认：拿得到候选窗口就算就绪。自带 emulator 的窗口是我们自己拉起来的，
   * 默认实现就够用；保留这个钩子是为了将来换运行时时有地方等画面。
   *
   * @param {object} o { isEmbedded?: () => boolean }
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async windowReady(o = {}) { // eslint-disable-line no-unused-vars
    const targets = await this.windowTargets().catch(() => []);
    return targets.length ? { ok: true } : { ok: false, reason: 'no-window' };
  }

  /**
   * 把画面窗口藏起来（开机 / 预热阶段，用户不该看到模拟器）。
   * 拿不到窗口时静默返回 null。
   * @returns {Promise<string|null>} 藏起来的 HWND
   */
  async hideWindow() { return null; }

  /** 停止运行时 */
  // eslint-disable-next-line class-methods-use-this
  async stop(o = {}) { return { ok: false, error: t('未实现') }; }

  /** 下载/部署缺失组件（只有带 CAPS.provision 的底座需要实现） */
  // eslint-disable-next-line class-methods-use-this
  async install(component, onProgress) { return { ok: false, error: t('该后端不支持自动部署') }; }

  /** 占用统计（设置页「运行时占用」） */
  // eslint-disable-next-line class-methods-use-this
  usage() { return { total: 0, items: [] }; }

  /** 数据分区信息 */
  // eslint-disable-next-line class-methods-use-this
  dataInfo() { return { ok: false }; }

  /** 调整数据分区 */
  // eslint-disable-next-line class-methods-use-this
  async resizeData(mb) { return { ok: false, error: t('该后端不支持调整数据分区') }; }

  /** 彻底重置安卓数据 */
  // eslint-disable-next-line class-methods-use-this
  async resetData() { return { ok: false, error: t('该后端不支持重置数据') }; }

  /** 释放资源（ApkStart 退出时调用；默认什么都不做） */
  // eslint-disable-next-line class-methods-use-this
  dispose() {}

  /** 诊断信息（写进问题报告） */
  // eslint-disable-next-line class-methods-use-this
  diagnose() { return {}; }
}

module.exports = { Backend, CAPS };
