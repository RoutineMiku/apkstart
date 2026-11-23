'use strict';
/**
 * i18n 测试
 *
 * 守三件事：
 *  1) 翻译引擎的匹配规则（精确、带 ${占位符} 的模板、未命中回退原文）；
 *  2) locales/*.json 的自洽性（占位符不多不少、值非空、不留中文、不原样复制）；
 *  3) 接线没断（页面真的加载了 overlay，各语言的手册锚点都能对上）。
 *
 * 纯 Node，不联网，不需要 electron。
 */
const fs = require('fs');
const path = require('path');
const { createTranslator } = require('../src/i18n/engine');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

const ROOT = path.join(__dirname, '..');
const LOCALES = path.join(ROOT, 'src', 'i18n', 'locales');
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
// Un marcador puede ser una variable simple (${v}) o una expresión entera
// (${a ? 'x' : ''}); lo que debe conservarse es el nombre de variable.
const PH = /\$\{\s*([A-Za-z_$][\w$]*)/g;
const ALLOW_CJK = ['夜神', '蓝叠', '红果', '抖音', 'B站', '爱奇艺', '微信', '日本語', '繁體中文', '日常MIKU'];

console.log('\n[i18n · 引擎]');
test('精确匹配', () => {
  const { t } = createTranslator({ 设置: 'Ajustes' });
  assert(t('设置') === 'Ajustes', '精确匹配失败');
});

test('未命中时回退原文', () => {
  const { t } = createTranslator({ 设置: 'Ajustes' });
  assert(t('未收录的文案') === '未收录的文案', '应原样返回');
  assert(t('') === '', '空串应原样返回');
  assert(t(null) === null, 'null 应原样返回');
});

test('模板占位符按名字替换', () => {
  const { t } = createTranslator({ '${n} 个应用': '${n} aplicaciones' });
  assert(t('12 个应用') === '12 aplicaciones', '模板替换失败: ' + t('12 个应用'));
});

test('模板占位符可以换位置', () => {
  const { t } = createTranslator({ '已就绪 · Android ${v}': 'Android ${v} · Listo' });
  assert(t('已就绪 · Android 14') === 'Android 14 · Listo', '换位失败: ' + t('已就绪 · Android 14'));
});

test('has() 反映命中情况', () => {
  const { has } = createTranslator({ 'a ${x}': 'b ${x}', 固定: 'fijo' });
  assert(has('固定') && has('a 1') && !has('nada'), 'has() 结果不对');
});

console.log('\n[i18n · 语言包]');
const locales = fs.existsSync(LOCALES)
  ? fs.readdirSync(LOCALES).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
  : [];

test('至少有一个语言包', () => {
  assert(locales.length > 0, 'src/i18n/locales 里没有语言包');
});

for (const locale of locales) {
  const dict = JSON.parse(fs.readFileSync(path.join(LOCALES, locale + '.json'), 'utf8'));
  const keys = Object.keys(dict);

  test(`${locale}: 条目非空且不等于原文`, () => {
    for (const [src, dst] of Object.entries(dict)) {
      assert(typeof dst === 'string' && dst.trim(), `${locale} 里 "${src.slice(0, 30)}" 的译文为空`);
      assert(dst !== src || !CJK.test(src), `${locale} 里 "${src.slice(0, 30)}" 原样未译`);
    }
    assert(keys.length > 500, `${locale} 条目太少（${keys.length}），像是没同步`);
  });

  test(`${locale}: 占位符与原串一致`, () => {
    for (const [src, dst] of Object.entries(dict)) {
      const a = new Set((src.match(PH) || []).map((x) => x.slice(2, -1).trim()));
      const b = new Set((dst.match(PH) || []).map((x) => x.slice(2, -1).trim()));
      for (const name of a) assert(b.has(name), `${locale}: "${src.slice(0, 40)}" 丢了占位符 \${${name}}`);
      for (const name of b) assert(a.has(name), `${locale}: "${dst.slice(0, 40)}" 出现多余的占位符 \${${name}}`);
    }
  });

  test(`${locale}: 译文里没有残留中文`, () => {
    const bad = [];
    for (const [src, dst] of Object.entries(dict)) {
      if (!CJK.test(dst)) continue;
      if (ALLOW_CJK.some((w) => dst.includes(w))) continue;
      bad.push(`${src.slice(0, 30)} -> ${dst.slice(0, 40)}`);
    }
    assert(!bad.length, `残留 ${bad.length} 条：` + bad.slice(0, 3).join(' | '));
  });

  test(`${locale}: 语言包能被引擎完整加载`, () => {
    // Las claves con ${...} son plantillas: se comprueban con un caso de uso real,
    // no reinyectando la propia clave (el marcador literal no es un valor válido).
    const tr = createTranslator(dict);
    for (const src of keys) {
      if (src.includes('${')) continue;
      assert(tr.t(src) === dict[src], `回放失败: ${src.slice(0, 30)}`);
    }
  });

  const manual = path.join(ROOT, 'src', 'ui', 'manual.' + locale.split('-')[0] + '.html');
  if (fs.existsSync(manual)) {
    test(`${locale}: 手册沿用同一批锚点`, () => {
      const html = fs.readFileSync(manual, 'utf8');
      const { TOPICS } = require(path.join(ROOT, 'src/core/manual'));
      for (const topic of Object.values(TOPICS)) {
        assert(html.includes(`id="${topic.anchor}"`), `${locale} 手册缺少锚点 ${topic.anchor}`);
      }
      const ids = new Set([...html.matchAll(/<h[1-4] id="([^"]+)"/g)].map((m) => m[1]));
      const broken = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((h) => !ids.has(h));
      assert(!broken.length, `${locale} 手册有 ${broken.length} 个断链: ` + broken.slice(0, 3).join(', '));
    });
  }
}

console.log('\n[i18n · 接线]');
test('三个页面都加载了 overlay', () => {
  for (const page of ['index.html', 'shell.html', 'splash.html']) {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'ui', page), 'utf8');
    assert(/i18n\/engine\.js/.test(html), `${page} 没有加载 ../i18n/engine.js`);
    assert(/src="i18n\.js"/.test(html), `${page} 没有加载 ui/i18n.js`);
  }
});

test('preload 暴露了词典', () => {
  for (const pre of ['preload.js', 'splash-preload.js']) {
    const js = fs.readFileSync(path.join(ROOT, 'src', pre), 'utf8');
    assert(/apkstartI18n/.test(js), `${pre} 没有暴露 apkstartI18n`);
  }
});

test('主进程安装了对话框/菜单翻译', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(/i18n\.installMain\(\)/.test(js), 'main.js 没有调用 installMain()');
  assert(/i18n\.manualFile\(\)/.test(js), 'main.js 没有按语言选手册');
});

console.log(`\ni18n 测试：${passed} 通过，${failed} 失败\n`);
process.exitCode = failed ? 1 : 0;
