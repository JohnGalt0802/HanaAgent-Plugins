// index.js — 下载进度条插件生命周期
// onload：恢复上次会话遗留的任务状态（running → interrupted），并对遗留终态任务做 deferred 幂等兜底。
//
// 通知策略（v0.5.0）：
//   - 占位注册：任务创建时自动完成（download-file/download-command 内 await registerDeferred），
//     不依赖 Agent 任何操作——Agent 即使不调 wait 直接收束回合，下载完成也会投递唤醒。
//   - 终态投递：任务 done/failed/canceled/interrupted → deferred:resolve 投递 hana-background-result，
//     唤醒发起会话的 Agent（回合边界送达）。Agent 已通过 wait 拿到结果时 result 带 consumedByWait 标记。
//   - 兜底：onload 对遗留终态任务幂等 resolve；未注册但带会话上下文的任务先补注册（覆盖热重载缝隙）。
//     宿主整体重启会清空宿主侧占位，无法补回（宿主无持久占位），如实降级为「热重载缝隙」覆盖。

import { getTaskManager } from "./lib/dlcore.js";
import { resolveDeferred, registerDeferred } from "./lib/deferred.js";

export default class DownloadProgressPlugin {
  async onload() {
    const { dataDir, bus, log } = this.ctx;
    try {
      const manager = getTaskManager(dataDir);
      manager.restore();
      this.ctx._dl = manager;
      globalThis.__dlBus = bus; // 工具执行上下文若不带 bus，deferred helper 从全局回退取用
      log.info(`download-progress v0.5.0 loaded (downloads → ${manager.downloadDir})`);

      // 终态 → deferred:resolve（投递 hana-background-result 唤醒 Agent）。
      // 幂等：占位不存在/已终态时 resolve 无操作被忽略，不影响下载。
      manager.onFinal((task) => {
        if (!bus || !task) return;
        resolveDeferred(bus, task);
      });

      // 停滞 → 动态注册 taskId:stall 占位并立即解析（投递提醒 Agent 决策）。
      // key 带时间戳唯一化：同一任务反复停滞不复用已终态 key，注册+解析始终成对，无幽灵。
      manager.onStall((task) => {
        if (!bus || !task) return;
        (async () => {
          const stallKey = task.taskId + ":stall:" + Date.now();
          await registerDeferred(bus, task, { type: "download-stall" }, stallKey);
          await bus.request("deferred:resolve", {
            taskId: stallKey,
            result: {
              type: "download-stall",
              taskId: task.taskId,
              fileName: task.fileName,
              url: task.url,
              state: task.state,
              received: task.received,
              total: task.total,
              stalledAt: task.stalledAt,
              hint: `下载连接已停滞（${task.stallTimeoutMs}ms 无新数据）。请决策：继续等待 / 换源重下 / 取消任务（download-cancel）。`,
            },
          }).catch(() => { /* 无占位忽略 */ });
        })().catch(() => { /* 停滞通知失败不影响下载 */ });
      });

      // ── 遗留终态兜底（幂等）──
      // restore 后扫描内存中所有终态任务：
      //   - 已注册占位 → resolve（占位不存在/已终态则宿主无操作）
      //   - 未注册但有会话上下文（热重载缝隙遗留的 v0.5.0 前任务）→ 先补注册再 resolve
      // 说明：宿主整体重启后占位随宿主清空，restore 丢失的唤醒无法补回（宿主无持久占位）；
      //       本兜底覆盖的是「插件层热重载/投递前崩溃」缝隙，见 README。
      const terminalStates = new Set(["done", "failed", "canceled", "interrupted"]);
      for (const t of manager.list()) {
        if (!terminalStates.has(t.state)) continue;
        if (t.deferredRegistered) {
          resolveDeferred(bus, t);
        } else if (t.sessionId || t.sessionPath) {
          await registerDeferred(bus, t); // 内部对终态任务注册后立即 resolve
        }
      }
    } catch (e) {
      log.warn?.("download-progress restore failed: " + (e?.message || e));
    }
  }
}
