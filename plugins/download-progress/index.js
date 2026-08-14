// index.js — 下载进度条插件生命周期
// onload：恢复上次会话遗留的任务状态（running → interrupted），
// 并注册终态回调：下载完成/失败时通过 deferred:resolve / deferred:fail
// 唤醒 Agent 会话（宿主投递 hana-background-result 消息，Agent 拿到结果继续处理）。

import { getTaskManager } from "./lib/dlcore.js";

export default class DownloadProgressPlugin {
  async onload() {
    const { dataDir, bus, log } = this.ctx;
    try {
      const manager = getTaskManager(dataDir);
      manager.restore();
      this.ctx._dl = manager;
      log.info(`download-progress loaded (downloads → ${manager.downloadDir})`);

      // 终态 → deferred 送达（注册占位在 download-file 工具里完成）
      manager.onFinal((task) => {
        if (!bus || !task) return;
        try {
          if (task.state === "done") {
            bus.request("deferred:resolve", {
              taskId: task.taskId,
              result: {
                taskId: task.taskId,
                fileName: task.fileName,
                filePath: task.filePath,
                total: task.total,
                received: task.received,
                state: "done",
              },
            }).catch(() => {});
          } else {
            const reason = task.error || task.state;
            bus.request("deferred:fail", {
              taskId: task.taskId,
              error: { message: reason },
            }).catch(() => {});
          }
        } catch (e) { /* 通知失败不影响下载 */ }
      });

      // 停滞 → 唤醒 Agent 决策：注册占位 + resolve，宿主投递 hana-background-result
      // （不自动取消任务，由 Agent 决定继续等待 / 换源 / 取消）
      manager.onStall(async (task) => {
        if (!bus || !task) return;
        if (!task.sessionPath) return; // 无会话上下文，跳过通知（安全兜底）
        try {
          await bus.request("deferred:register", {
            taskId: task.taskId + ":stall",
            sessionPath: task.sessionPath,
            meta: {
              type: "download-stall",
              label: task.fileName,
              deliveryIntent: "trigger_parent_turn",
            },
          });
        } catch (e) { /* 占位注册失败不阻塞后续 resolve 尝试 */ }
        try {
          await bus.request("deferred:resolve", {
            taskId: task.taskId + ":stall",
            result: {
              type: "download-stall",
              taskId: task.taskId,
              fileName: task.fileName,
              url: task.url,
              state: task.state,
              received: task.received,
              total: task.total,
              elapsed: task.elapsed,
              stalledAt: task.stalledAt,
              hint: `下载连接已停滞（${task.stallTimeoutMs}ms 无新数据）。请决策：继续等待 / 换源重下 / 取消任务。`,
            },
          });
        } catch (e) { /* 通知失败不影响下载 */ }
      });
    } catch (e) {
      log.warn?.("download-progress restore failed: " + (e?.message || e));
    }
  }
}
