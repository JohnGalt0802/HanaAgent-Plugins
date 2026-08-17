// index.js — 下载进度条插件生命周期
// onload：恢复上次会话遗留的任务状态（running → interrupted），
// 并注册终态/停滞回调：实时通知 Agent。
// 通知策略（无排队通知）：
//   - 失败/取消/中断：session:send 立即注入（Agent 空闲/回合间即达）；
//     若宿主拒绝（session_busy，回合活跃中）则放弃，不排队——Agent 用 download-wait 主动轮询是主路径。
//   - 停滞：同样 session:send 立即提醒，不排队。
//   - 成功：不通知（Agent 通过 wait 拿到 done，避免打扰）。
//   - 不再使用 deferred 通知（其回合边界排队投递已被淘汰）。

import { getTaskManager } from "./lib/dlcore.js";

export default class DownloadProgressPlugin {
  async onload() {
    const { dataDir, bus, log } = this.ctx;
    try {
      const manager = getTaskManager(dataDir);
      manager.restore();
      this.ctx._dl = manager;
      log.info(`download-progress loaded (downloads → ${manager.downloadDir})`);

      // 终态 → 实时通知（仅失败/取消/中断；成功不打扰）
      manager.onFinal((task) => {
        if (!bus || !task) return;
        if (task.state === "done") return; // 成功：wait 主动查即可
        try {
          if (!task.sessionPath) return; // 无会话上下文，跳过
          const reason = task.error || task.state;
          const statusTag = task.state === "canceled" ? "canceled" : "failed";
          const msg =
            `<hana-background-result task-id="${task.taskId}" status="${statusTag}" type="download">\n` +
            (task.fileName ? "文件：" + task.fileName + "\n" : "") +
            `原因：${reason}\n` +
            (task.received ? `已下载：${task.received}${task.total ? "/" + task.total : ""}\n` : "") +
            "</hana-background-result>";
          bus.request("session:send", {
            text: msg,
            sessionPath: task.sessionPath,
          }).catch(() => { /* session_busy：回合活跃中，放弃（不排队） */ });
        } catch (e) { /* 通知失败不影响下载 */ }
      });

      // 停滞 → 实时提醒 Agent 决策（不自动取消任务，不排队）
      manager.onStall((task) => {
        if (!bus || !task) return;
        if (!task.sessionPath) return;
        try {
          const msg =
            `<hana-background-result task-id="${task.taskId}:stall" status="success" type="download-stall">\n` +
            (task.fileName ? "文件：" + task.fileName + "\n" : "") +
            `状态：${task.state} · 已下载 ${task.received}${task.total ? "/" + task.total : ""} · 停滞时间 ${task.stalledAt}\n` +
            `提示：下载连接已停滞（${task.stallTimeoutMs}ms 无新数据）。请决策：继续等待 / 换源重下 / 取消任务（download-cancel）。\n` +
            "</hana-background-result>";
          bus.request("session:send", {
            text: msg,
            sessionPath: task.sessionPath,
          }).catch(() => { /* session_busy：放弃，不排队 */ });
        } catch (e) { /* 通知失败不影响下载 */ }
      });
    } catch (e) {
      log.warn?.("download-progress restore failed: " + (e?.message || e));
    }
  }
}
