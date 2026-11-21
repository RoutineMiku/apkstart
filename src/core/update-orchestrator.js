'use strict';
/**
 * [R4-fix] 更新编排门闩（issue98/编排权属审查修复的核心协调器）。
 *
 * 之前 main.js 用一个裸布尔 updateBusy 表达「更新进行中」：
 *   - 启动续做（boot-resume）完全不在它的管辖里 —— 续做 prepare/apply 期间
 *     用户可以再点「立即更新」，两路流程会在同一载荷目录上并发 rm/写/换名；
 *   - `app:updateCancel` 可以无条件把 updateBusy 清成 false —— 谁的旗子都能
 *     被别人放倒，busy 状态不再可信。
 *
 * 这个协调器把「谁持有更新流程」显式化：owner 标签 + 获取/释放 + 协作式取消。
 * 纯 Node、无 Electron 依赖，可独立执行测试；main.js 的 runUpdate /
 * app:updateCancel / bootResume 接线全部走它（见各处 [R4-fix] 注释）。
 */
class UpdateGate {
  constructor() {
    this._owner = null;
    this._cancelled = false;
  }

  /**
   * 尝试以 owner 身份持有门闩。已被任何 owner 持有时返回 false（调用方必须
   * 如实返回 busy，而不是排队隐式等待 —— 用户动作要么立刻开始、要么立刻
   * 得到诚实的「正在忙」回应）。未决状态同步返回，调用方可以在第一个 await
   * 之前完成持锁（启动续做先于 UI 暴露）。
   * @returns {boolean}
   */
  begin(owner) {
    if (this._owner) return false;
    this._owner = owner;
    this._cancelled = false;
    return true;
  }

  /** 当前持有者；空闲时为 null。用于给用户一条如实的 busy 原因。 */
  heldBy() { return this._owner; }

  isBusy() { return !!this._owner; }

  /**
   * 仅持有者本人（或其编排函数）可以释放；别人的 end() 是 no-op，
   * 「取消」永远放不倒续做流程的门闩。
   * @returns {boolean} 是否真的释放了
   */
  end(owner) {
    if (this._owner !== owner) return false;
    this._owner = null;
    this._cancelled = false;
    return true;
  }

  /**
   * 协作式取消：只标记持有中的 owner（不释放、不中断正在进行的 I/O）。
   * 长流程在阶段边界（prepare 完成后、apply 前）查询 isCancelled 自行中止。
   * 对非持有 owner 或空闲状态一律 no-op。
   * @returns {boolean} 是否标记成功
   */
  cancel(owner) {
    if (this._owner !== owner) return false;
    this._cancelled = true;
    return true;
  }

  isCancelled(owner) { return this._owner === owner && this._cancelled === true; }

  /**
   * 持锁运行 fn 的标准形状：begin 成功才执行，无论成败 finally 释放。
   * onBusy(heldBy) 给调用方机会把「谁在忙」翻成用户可读的回应。
   * @returns {Promise<*>} fn 的返回值；busy 时为 onBusy 的返回值
   */
  async runExclusive(owner, fn, onBusy) {
    if (!this.begin(owner)) {
      return typeof onBusy === 'function' ? onBusy(this.heldBy()) : { ok: false, busy: true, heldBy: this.heldBy() };
    }
    try {
      return await fn(this);
    } finally {
      this.end(owner);
    }
  }
}

module.exports = { UpdateGate };
