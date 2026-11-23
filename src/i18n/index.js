'use strict';
/*
 * Integración del overlay i18n en el proceso principal de ApkStart.
 *
 * Qué traduce aquí: diálogos nativos (dialog.*), menús (Menu.buildFromTemplate)
 * y las cadenas que decida envolver el código con i18n.t().
 * Qué NO toca: notificaciones del sistema ni títulos de ventana creados a mano;
 * para esas, envolver el texto con i18n.t() en el punto de uso (ver docs/I18N.md).
 */

const fs = require('fs');
const path = require('path');
const { createTranslator } = require('./engine');

const LOCALES_DIR = path.join(__dirname, 'locales');
const SOURCE_LOCALE = 'zh-CN';

/** Idiomas disponibles según los JSON de locales/. */
function availableLocales() {
  try {
    return fs.readdirSync(LOCALES_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch (_) {
    return [];
  }
}

/** Elige idioma: APKSTART_LOCALE > locale del sistema > chino (idioma fuente). */
function resolveLocale() {
  const available = availableLocales();
  const forced = process.env.APKSTART_LOCALE;
  if (forced && (available.includes(forced) || forced === SOURCE_LOCALE)) return forced;
  let sys = '';
  try {
    const { app } = require('electron');
    sys = app.getLocale() || '';
  } catch (_) { /* fuera de Electron (tests) */ }
  if (sys && (available.includes(sys) || sys === SOURCE_LOCALE)) return sys;
  const lang = sys.split('-')[0];
  const match = available.find((l) => l.split('-')[0] === lang);
  return match || SOURCE_LOCALE;
}

const LOCALE = resolveLocale();

function loadDict(locale) {
  if (!locale || locale === SOURCE_LOCALE) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale + '.json'), 'utf8'));
  } catch (err) {
    console.warn('[i18n] no se pudo cargar', locale, err.message);
    return {};
  }
}

const DICT = loadDict(LOCALE);
const translator = createTranslator(DICT);

const t = translator.t;
const has = translator.has;

/** Traduce recursivamente etiquetas de un template de menú. */
function translateMenuTemplate(items) {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const out = { ...item };
    for (const key of ['label', 'sublabel', 'toolTip']) {
      if (typeof out[key] === 'string') out[key] = t(out[key]);
    }
    if (Array.isArray(out.submenu)) out.submenu = translateMenuTemplate(out.submenu);
    return out;
  });
}

/** Traduce las opciones de un diálogo nativo (messageBox / openDialog). */
function translateDialogOptions(opts) {
  if (!opts || typeof opts !== 'object') return opts;
  const out = { ...opts };
  for (const key of ['title', 'message', 'detail', 'buttonLabel', 'checkboxLabel', 'nameFieldLabel', 'message-mac']) {
    if (typeof out[key] === 'string') out[key] = t(out[key]);
  }
  if (Array.isArray(out.buttons)) out.buttons = out.buttons.map((b) => t(b));
  if (Array.isArray(out.filters)) out.filters = out.filters.map((f) => ({ ...f, name: t(f.name) }));
  return out;
}

let installed = false;

/** Envuelve dialog y Menu. Llamar una vez, antes de crear ventanas o menús. */
function installMain() {
  if (installed) return;
  installed = true;
  if (LOCALE === SOURCE_LOCALE) return;

  const { dialog, Menu } = require('electron');

  const origShowMessageBox = dialog.showMessageBox.bind(dialog);
  dialog.showMessageBox = function patchedShowMessageBox(winOrOpts, maybeOpts) {
    if (typeof winOrOpts === 'object' && winOrOpts && 'message' in winOrOpts) {
      return origShowMessageBox(translateDialogOptions(winOrOpts));
    }
    if (maybeOpts && typeof maybeOpts === 'object') {
      return origShowMessageBox(winOrOpts, translateDialogOptions(maybeOpts));
    }
    return origShowMessageBox(winOrOpts, maybeOpts);
  };

  const origShowErrorBox = dialog.showErrorBox.bind(dialog);
  dialog.showErrorBox = (title, content) => origShowErrorBox(t(title), t(content));

  const origShowOpenDialog = dialog.showOpenDialog.bind(dialog);
  dialog.showOpenDialog = function patchedShowOpenDialog(winOrOpts, maybeOpts) {
    if (typeof winOrOpts === 'object' && winOrOpts && !maybeOpts) {
      return origShowOpenDialog(translateDialogOptions(winOrOpts));
    }
    return origShowOpenDialog(winOrOpts, translateDialogOptions(maybeOpts));
  };

  const origShowSaveDialog = dialog.showSaveDialog.bind(dialog);
  dialog.showSaveDialog = function patchedShowSaveDialog(winOrOpts, maybeOpts) {
    if (typeof winOrOpts === 'object' && winOrOpts && !maybeOpts) {
      return origShowSaveDialog(translateDialogOptions(winOrOpts));
    }
    return origShowSaveDialog(winOrOpts, translateDialogOptions(maybeOpts));
  };

  const origBuildFromTemplate = Menu.buildFromTemplate.bind(Menu);
  Menu.buildFromTemplate = (template) => origBuildFromTemplate(translateMenuTemplate(template));
}

/** Ruta del manual en el idioma activo; si no existe, el original en chino. */
function manualFile() {
  const uiDir = path.join(__dirname, '..', 'ui');
  const lang = LOCALE.split('-')[0];
  if (lang && lang !== 'zh') {
    const localized = path.join(uiDir, 'manual.' + lang + '.html');
    if (fs.existsSync(localized)) return localized;
  }
  return path.join(uiDir, 'manual.html');
}

/** Datos que preload entrega al renderer para traducir el DOM. */
function rendererBoot() {
  return { locale: LOCALE, dict: DICT };
}

module.exports = {
  SOURCE_LOCALE,
  locale: () => LOCALE,
  dict: () => DICT,
  t,
  has,
  availableLocales,
  installMain,
  manualFile,
  rendererBoot,
  translateMenuTemplate,
  translateDialogOptions,
  stats: () => ({ locale: LOCALE, exact: translator.exact, patterns: translator.patterns }),
};
