'use strict';
/**
 * i18n 一致性检查（CI 用）
 *
 * 校验三件事：
 *   1. 词典本身合法：每条都有译文、key 含中文、占位符一一对应；
 *   2. 源码里的界面文案都有译文（extract.js 的扫描结果 ⊆ en.json）；
 *   3. 没有残留的中文占位符 / 非法 key。
 *
 * 用法：node tools/check-i18n.js
 */
const path = require('path');
const { collect, readDict, validate } = require('./i18n/extract');

function run() {
  const dict = readDict();
  const items = collect();
  const missing = items.filter((it) => !dict[it.key] || !String(dict[it.key]).trim());
  const { errors, warnings } = validate(dict);
  return { dict, items, missing, errors, warnings };
}

function main() {
  const { dict, items, missing, errors, warnings } = run();
  const total = Object.keys(dict).length;

  console.log(`[i18n] 词典 ${total} 条；源码界面文案 ${items.length} 条；待翻译 ${missing.length} 条`);
  for (const it of missing) console.log(`  ✗ 缺少译文：${it.key}  (${it.files.join(', ')})`);
  for (const w of warnings) console.log(`  ! ${w}`);
  for (const e of errors) console.log(`  ✗ ${e}`);

  if (missing.length || errors.length) {
    console.error(`[i18n] 检查失败：${missing.length} 条缺失，${errors.length} 条错误`);
    process.exit(1);
  }
  console.log('[i18n] 通过');
}

if (require.main === module) main();

module.exports = { run };
