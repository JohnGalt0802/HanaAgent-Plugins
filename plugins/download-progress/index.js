// index.js — 下载进度条插件生命周期
// onload：恢复上次会话遗留的任务状态（running → interrupted）。
// 通知策略（v1.6.7）：
//   - 常规下载（wait 一次到 done）：完全静默——无任何会话注入，结果由 wait 实时返回。
//   - 大文件下载（Agent 结束回合前调 wait(notifyWhenDone=true)）：即时回查 + 注册 deferred 占位，
//     下载完成/失败/停滞时宿主投递 hana-background-result 唤醒 Agent（下次回合/空闲时送达）。
//   - deferred 投递是异步的（回合边界送达），仅用于 Agent 已结束回合、无法再 wait 回查的场景。

import { getTaskManager } from "./lib/dlcore.js";

export default class DownloadProgressPlugin {
  async onload() {
    const { dataDir, bus, log } = this.ctx;
    try {
      const manager = getTaskManager(dataDir);
      manager.restore();
      this.ctx._dl = manager;
      log.info(`download-progress v1.6.7 loaded (downloads → ${manager.downloadDir})`);

      // 终态 → deferred:resolve（投递 hana-background-result 唤醒 Agent）。
      // 幂等：占位不存在（常规 wait 未注册）时 resolve 报错被忽略，不影响下载。
      manager.onFinal((task) => {
        if (!bus || !task) return;
        if (task.state === "done") {
          bus.request("deferred:resolve", {
            taskId: task.taskId,
            result: {
              type: "download",
              taskId: task.taskId,
              fileName: task.fileName,
              filePath: task.filePath,
              total: task.total,
              received: task.received,
              state: "done",
            },
          }).catch(() => { /* 无占位忽略 */ });
        } else if (task.state === "failed" || task.state === "canceled" || task.state === "interrupted") {
          // 用户手动取消：明确告知 Agent 无需自动重试/换源，避免与失败混淆
          const userCanceled = task.state === "canceled" && task.canceledBy === "user";
          bus.request("deferred:resolve", {
            taskId: task.taskId,
            result: {
              type: "download",
              taskId: task.taskId,
              fileName: task.fileName,
              state: task.state,
              canceledBy: task.canceledBy || null,
              userCanceled: userCanceled,
              hint: userCanceled ? "用户手动取消（非故障，无需自动重试或换源）" : null,
              error: task.error || task.state,
              total: task.total,
              received: task.received,
            },
          }).catch(() => { /* 无占位忽略 */ });
        }
      });

      // 停滞 → 独立占位（taskId:stall，wait notifyWhenDone 时注册）投递提醒 Agent 决策
      manager.onStall((task) => {
        if (!bus || !task) return;
        bus.request("deferred:resolve", {
          taskId: task.taskId + ":stall",
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
      });
    } catch (e) {
      log.warn?.("download-progress restore failed: " + (e?.message || e));
    }
  }
}
