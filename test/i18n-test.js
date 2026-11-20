'use strict';
/**
 * 界面多语言（src/i18n）测试：纯 Node，不依赖 Electron / DOM。
 * 运行：node test/i18n-test.js
 */
const i18n = require('../src/i18n/i18n');
const es = require('../src/i18n/es');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '不相等'}\n      实际: ${JSON.stringify(a)}\n      期望: ${JSON.stringify(b)}`);
}
const T = (s) => i18n.translate('es', s);

console.log('\n[i18n]');

test('语言解析：auto 跟随系统，西班牙语系统才切 es', () => {
  eq(i18n.resolveLang('auto', ['es-MX', 'en-US']), 'es');
  eq(i18n.resolveLang('auto', ['zh-CN']), 'zh-CN');
  eq(i18n.resolveLang('auto', ['en-US']), 'zh-CN');
  eq(i18n.resolveLang(undefined, 'es-419'), 'es');
  eq(i18n.resolveLang('zh-CN', ['es-ES']), 'zh-CN');
  eq(i18n.resolveLang('es', ['zh-CN']), 'es');
  eq(i18n.resolveLang('xx', ['es-ES']), 'zh-CN', '未知值回落中文');
});

test('中文模式原样返回，不做任何处理', () => {
  eq(i18n.translate('zh-CN', '安装 APK'), '安装 APK');
  const opts = { title: '确认', buttons: ['取消', '确定'] };
  eq(i18n.translateDialog('zh-CN', opts), opts);
});

test('词典：占位符与原文一一对应，译文里没有漏翻的汉字', () => {
  const ph = (s) => (s.match(/\{\d+\}/g) || []).sort().join();
  for (const [k, v] of Object.entries(es)) {
    eq(ph(v), ph(k), `占位符不一致：${k}`);
    if (/[\u3400-\u9fff]/.test(v.replace(/日常MIKU/g, ''))) throw new Error(`译文含汉字：${k} → ${v}`);
  }
});

test('整句与带动态部分的句子', () => {
  eq(T('安装 APK'), 'Instalar APK');
  eq(T('  设置  '), '  Ajustes  ', '保留首尾空白');
  eq(T('3 分钟前'), 'hace 3 min');
  eq(T('下载中 12 MB · 3.2 MB/s（第 2/8 片）'), 'Descargando 12 MB · 3.2 MB/s (bloque 2/8)');
});

test('应用名等用户数据不被改写', () => {
  eq(T('正在打开 抖音'), 'Abriendo 抖音');
  eq(T('C:\\用户\\桌面\\a.apk'), 'C:\\用户\\桌面\\a.apk', '路径不做片段替换');
});

test('多行确认框逐行翻译', () => {
  eq(T('确定卸载「抖音」？\n\n应用数据会一并被清除，桌面快捷方式也会被删除。'),
    '¿Seguro que quieres desinstalar «抖音»?\n\nLos datos de la app también se borrarán, igual que el acceso directo del escritorio.');
});

test('运行时拼接出来的句子：片段替换 + 全角标点转半角', () => {
  eq(T('缺少 adb、运行时引擎、系统镜像（无硬件加速，将回退软件模拟）'),
    'Falta adb, motor del runtime, imagen del sistema (sin aceleración por hardware; se usará emulación por software)');
  eq(T('运行时已就绪 · Android 14（ARM 兼容镜像）'), 'Runtime listo · Android 14 (imagen de compatibilidad ARM)');
});

test('托盘菜单与对话框：翻译文案，跳过应用名', () => {
  const m = i18n.translateMenu('es', [
    { label: '打开 ApkStart' }, { label: '设置' }, { type: 'separator' },
    { label: '退出', submenu: [{ label: '取消' }] },
  ], (it) => it.label === '设置');
  eq(m[0].label, 'Abrir ApkStart');
  eq(m[1].label, '设置', 'skip 的项保持原样');
  eq(m[3].label, 'Salir');
  eq(m[3].submenu[0].label, 'Cancelar');
  const d = i18n.translateDialog('es', { title: '确认', buttons: ['取消', '确定'], filters: [{ name: 'Android 应用', extensions: ['apk'] }], defaultId: 1 });
  eq(d.title, 'Confirmar');
  eq(d.buttons.join('|'), 'Cancelar|Aceptar');
  eq(d.filters[0].name, 'App de Android');
  eq(d.defaultId, 1);
});

test('0.6 新增文案：设置分类、托盘、体检与开机动画', () => {
  eq(T('诊断与修复'), 'Diagnóstico y reparación');
  eq(T('关闭当前应用（抖音）'), 'Cerrar la app actual (抖音)', '应用名保持原样');
  eq(T('每 5 分钟检测一次'), 'Comprobar cada 5 minutos');
  eq(T('Windows 上的安卓应用运行器'), 'Ejecutor de apps Android para Windows');
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
