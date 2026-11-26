'use strict';
/**
 * 主进程里「不经过 DOM」的文字出口：对话框、菜单（托盘/右键）、托盘提示。
 * 在这里统一包一层翻译，main.js 和 core/ 里的调用点保持原样写中文。
 *
 * Wraps Electron's dialog / Menu / Tray APIs so their text goes through t().
 */
const i18n = require('./index');

let installed = false;

function install(electron) {
  if (installed) return;
  installed = true;
  const { dialog, Menu, Tray } = electron;
  const { tDeep, t } = i18n;

  const wrap = (obj, name) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = function (...args) {
      const a = args.map((x) => (x && typeof x === 'object' && !isWindow(x) ? tDeep(x) : x));
      return orig.apply(this, a);
    };
  };
  const isWindow = (x) => x && typeof x.webContents === 'object';

  for (const n of ['showMessageBox', 'showMessageBoxSync', 'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync']) {
    wrap(dialog, n);
  }
  const showErrorBox = dialog.showErrorBox;
  dialog.showErrorBox = (title, content) => showErrorBox.call(dialog, t(title), t(content));

  const build = Menu.buildFromTemplate;
  Menu.buildFromTemplate = (template) => build.call(Menu, tDeep(template));

  if (Tray && Tray.prototype && Tray.prototype.setToolTip) {
    const tip = Tray.prototype.setToolTip;
    Tray.prototype.setToolTip = function (s) { return tip.call(this, t(s)); };
  }
}

module.exports = { install };
