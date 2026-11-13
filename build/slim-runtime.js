'use strict';
/**
 * 运行时瘦身：删掉模拟器里「我们的启动方式永远不会加载」的文件。
 *
 * 判断依据是 emulator.js 的固定启动参数：
 *   - 只带 x86_64 镜像（API30 AOSP）      → qemu-system-aarch64.exe 用不上
 *   - -gpu software（swiftshader 软渲染） → vulkan / gles_angle 后端用不上
 *   - 界面只保留 38px 标题栏               → 模拟器自带界面的多语言、WebEngine 面板用不上
 *
 * 网络相关的 netsimd / netsim / nimble_bridge 一定保留：
 * 它们负责 wifi / 蓝牙的数据通路，删了应用就上不了网，属于「能跑」的底线。
 *
 * 用法：
 *   node build/slim-runtime.js build/runtime          # 安全档（默认）
 *   node build/slim-runtime.js build/runtime --aggressive   # 再删 QtWebEngine（-169MB）
 *   node build/slim-runtime.js build/runtime --dry-run
 */
const fs = require('fs');
const path = require('path');

/**
 * 安全档：删掉确实不会被加载的东西（约 -190MB）。
 * 实测单点回滚确认的边界（重要，别乱加）：
 *   - Qt6WebEngineCoreAndroidEmu.dll 是 emulator.exe 的硬依赖（静态导入），删了直接起不来 → 保留
 *   - lib64/gles_angle 提供 vk_swiftshader，swiftshader 软渲染依赖它 → 保留
 *   - lib64/vulkan 删掉只是退回软渲染（已实测能正常引导 + 渲染），但留着也不大 → 删掉省 103MB
 */
const SAFE = [
  ['emulator/qemu/windows-x86_64/qemu-system-aarch64.exe', 'arm64 的 QEMU 二进制（只发 x86_64 镜像）'],
  // 注意：不能整目录删 emulator/lib64/vulkan —— vulkan-1.dll 是 -gpu host 的加载器，
  // 删了 host 会直接失败、只剩软件渲染（实测 AMD 780M 上必须保留）。只删大件：
  ['emulator/lib64/vulkan/layers', 'Vulkan 校验层（host 渲染用不到，-20MB）'],
  ['emulator/lib64/vulkan/glslangValidator.exe', '着色器校验工具（运行时用不到，-7MB）'],
  ['emulator/lib64/vulkan/libvulkan_lvp.dll', 'lavapipe 软件 Vulkan 后备（有系统显卡驱动时用不到，-53MB）'],
  ['emulator/lib64/vulkan/lvp_icd.json', 'lavapipe 的 ICD 描述（-1KB）'],
  ['emulator/lib64/vulkan/vk_swiftshader.dll', 'SwiftShader Vulkan（gles_angle 目录里有同款副本，-23MB）'],
  ['emulator/lib64/qt/translations', '模拟器界面的多语言包（只剩 38px 标题栏）'],
  // 注意：不能删 emulator-check.exe —— emulator -accel-check 靠它检测 AEHD/WHPX，
  // 缺了会判定"无硬件加速"退回 TCG 软件模拟（实测开机从 42s 变成 10 分钟+）。
  ['emulator/qsn.exe', 'QEMU 快照通知助手（emulator.exe 无任何引用，已 strings 实证，-34MB）'],
  ['emulator/resources/Toren1BD_Main.png', 'VR 全景环境贴图（红果用不到，-3.7MB）'],
  ['emulator/resources/Toren1BD_Decor.png', 'VR 全景装饰贴图（-3.5MB）'],
  ['emulator/resources/Toren1BD.obj', 'VR 全景 3D 模型（-3.5MB）'],
  ['emulator/resources/macroPreviews', '宏操作预览图（-2.7MB）'],
  ['emulator/resources/default360.mp4', '360° 全景默认视频（-2.4MB）'],
];

/** 激进档目前为空：WebEngine 是硬依赖、gles_angle 是软渲染依赖，都不敢删 */
const AGGRESSIVE = [];

function sizeOf(p) {
  let s = 0;
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) s += sizeOf(path.join(p, e.name));
  } catch (_) { /* 忽略 */ }
  return s;
}

function slim(root, { aggressive = false, dryRun = false, log = console.log } = {}) {
  if (!fs.existsSync(path.join(root, 'emulator', 'emulator.exe'))) {
    throw new Error(`${root} 不是一个运行时目录（缺 emulator/emulator.exe）`);
  }
  const list = aggressive ? SAFE.concat(AGGRESSIVE) : SAFE;
  let freed = 0;
  for (const [rel, why] of list) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const n = sizeOf(p);
    if (!dryRun) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {
        log(`  跳过 ${rel}：${e.message}`);
        continue;
      }
    }
    freed += n;
    log(`  删除 ${rel}（${(n / 1048576).toFixed(0)} MB）— ${why}`);
  }
  log(`${dryRun ? '可释放' : '已释放'} ${(freed / 1048576).toFixed(0)} MB`);
  return freed;
}

module.exports = { slim };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, 'runtime'));
  const aggressive = process.argv.includes('--aggressive');
  const dryRun = process.argv.includes('--dry-run');
  console.log(`瘦身目标：${root}（${aggressive ? '激进' : '安全'}档）`);
  slim(root, { aggressive, dryRun });
}
