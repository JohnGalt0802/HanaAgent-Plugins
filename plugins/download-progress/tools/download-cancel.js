// tools/download-cancel.js — 下载取消工具
// Agent 侧主动终止下载任务（收到停滞通知后决策"取消"、或发现速度/源不可接受时）。
// 取消会中断连接并删除半成品文件。

import { getTaskManager } from "../lib/dlcore.js";

export const name = "download-cancel";
export const description =
  "取消一个正在下载或准备中的任务（与 download-file 配合使用）。取消后任务状态变为 canceled，半成品文件被删除。" +
  "典型场景：收到停滞通知（download-stall）后决策取消、下载速度长期不达标、或源站不可用需要换源重下。";

export const parameters = {
  type: "object",
  properties: {
    taskId: {
      type: "string",
      description: "download-file 返回的任务 ID",
    },
  },
  required: ["taskId"],
};

export async function execute(input, toolCtx) {
  const taskId = String(input?.taskId || "").trim();
  if (!taskId) throw new Error("缺少 taskId（来自 download-file 的返回值）");

  const manager = getTaskManager(toolCtx.dataDir);
  const r = manager.cancel(taskId);
  if (!r.ok) {
    return {
      content: [{ type: "text", text: `取消失败：${r.error || "任务不存在"}` }],
      details: { download: { taskId, canceled: false, error: r.error || "任务不存在" } },
    };
  }

  const snap = manager.snapshot(taskId);
  return {
    content: [{ type: "text", text: `已取消下载任务 ${taskId}${snap?.fileName ? "（" + snap.fileName + "）" : ""}，半成品文件已删除。` }],
    details: {
      download: {
        taskId,
        canceled: true,
        state: "canceled",
        fileName: snap?.fileName || null,
      },
    },
  };
}
