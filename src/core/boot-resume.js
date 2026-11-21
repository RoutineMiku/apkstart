'use strict';
/**
 * 启动续做编排（从 main.js 抽出，纯 Node 可测，无 Electron 依赖）。
 *
 * [R4] findResumableJob 变为异步且可能访问网络（用官方 release 元数据校验
 * 留存载荷的身份），所以这里必须先 await 拿到结果再决定：
 *   - 命中 → 重放 apply + 延迟退出，绝不并行发起新一轮 check（避免抢进度条
 *     或双下载，维持 issue #98 修复的原有序）；
 *   - 未命中 / 校验不过 / 离线 / 任何异常 → 只安排静默查新，启动照常继续，
 *     绝不让续做失败拖垮启动流程。
 *
 * [R4-fix] 编排权属：可选传入 update-orchestrator 的 gate。持锁发生在函数体
 * 第一个 await 之前（同步），所以「UI 已暴露、续做还在验证」的窗口里，手动
 * 更新要么等续做完、要么立刻拿到如实的 busy 回应 —— 续做 prepare/apply 与
 * 手动 runUpdate 不再可能重叠（root 审查 R4-C01 的编排面修复；载荷本身的
 * 截断面由 updater 唯一 staging + 原子换名独立挡住）。
 *   - 持有者固定为 'boot-resume'；app:updateCancel 放不倒这把锁；
 *   - 干净未命中 / 查询失败 / apply 同步失败 → 释放门闩并安排静默查新；
 *   - apply 成功 → 门闩一直持有到退出交接（apply/quit handoff），不提前释放。
 */
async function bootResume(updater, opts = {}) {
  const {
    log = () => {},
    send = () => {},
    quit = () => {},
    applyDelayMs = 900,
    scheduleCheck = null,
    gate = null,
  } = opts;
  // 同步持锁：必须发生在任何 await 之前，UI 暴露后立刻到位。
  const owns = !gate || gate.begin('boot-resume');
  let job = null;
  if (owns) {
    try {
      job = await updater.findResumableJob();
    } catch (e) {
      log(`resume check failed: ${e && e.message}`);
    }
  }
  let resuming = false;
  if (job) {
    resuming = true;
    log(`resuming pending update ${job.version} from verified cached archive`);
    send('update:progress', { stage: 'apply', percent: 100, message: '正在完成上次未完成的更新…' });
    let applied = false;
    try {
      updater.apply(job);
      applied = true;
    } catch (e) {
      // [R4-fix] 助手调度同步失败：不声称续做成功、不计划退出。如实广播错误、
      // 释放门闩、转入正常静默查新（E：honest apply failure）。
      log(`resume apply failed: ${e && e.message}`);
      send('update:progress', { stage: 'error', percent: 0, message: '完成上次更新失败，已转入常规检查' });
    }
    if (applied) {
      setTimeout(() => quit(), applyDelayMs);
    } else {
      resuming = false;
    }
  }
  if (gate && owns && !resuming) gate.end('boot-resume');
  // 命中且 apply 成功就不再并行发起新一轮查新；其余路径安排一次（与旧 main.js 语义一致）。
  if (!resuming && typeof scheduleCheck === 'function') scheduleCheck();
  return resuming;
}

module.exports = { bootResume };
