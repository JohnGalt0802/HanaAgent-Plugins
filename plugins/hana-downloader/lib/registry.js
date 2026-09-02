// lib/registry.js — 宿主 TaskRegistry 双注册封装（v0.8）
//
// 宿主任务注册协议（bundle v0.737.2 实测）：
//   task:register-handler  注册中止处理器（type="download"）→ 宿主 stop_task 可取消下载（必须在任何 task:register 之前完成，onload 一次性注册）
//   task:register          注册任务实例（taskId + type + 会话关联 + meta）→ 宿主可查询/等待
//   task:complete          任务完成终结（带 result）
//   task:fail              任务失败终结（带 reason）
//   task:cancel            任务取消终结（canceled 状态）——stop_task 触发的取消由宿主自动调 handler.abort，
//                          本插件不自发 task:abort；agent 主动取消（canceled）经此终结。
//
// 设计原则：
//   - 双注册 = deferred 占位（唤醒 Agent）+ TaskRegistry 实例（宿主可取消/等待）。
//   - 任一注册失败不阻断下载：try/catch 包裹 + console 日志，静默降级为仅占位或仅实例。
//   - abort 回调经 TaskManager.cancel 走统一取消路径（cancelRequested = true + controller.abort()，
//     与工具取消同一条链路，不做二次实现），source 固定 "user"（宿主 stop_task 即用户操作）。
//   - handler.abort 签名 `abort: async (taskId) => {}`（只收 taskId，reason 不会传入；需要时自取
//     manager.getTask(taskId)）。必须幂等（stop_task 可能多次触发——manager.cancel 对不存在/已结束
//     任务返回 { ok:false } 不抛错）且不抛错（宿主 try/catch 吞异常只记日志，外层再包 try/catch 双保险）。
//   - capabilities：manifest.json 已声明 ["task.write", "task.read"]，否则宿主权限闸拒绝注册。
//   - 不自带对 deferred.js 的 import（deferred.js 会引用本模块，避免循环依赖）；
//     bus 兜底与 deferred.js 同口径：参数 bus → toolCtx.bus → globalThis.__dlBus。

const PLUGIN_ID = "hana-downloader"; // manifest.json id

// 终态集合：已终态任务重复注册会触发宿主 TaskRegistry.register 强制把 status 从 completed
// 重置回 running（删除 completedAt/error/result），因此终态任务直接跳过 task:register。
const FINAL = { done: 1, failed: 1, canceled: 1, interrupted: 1 };

function resolveBus(bus, toolCtx) {
  if (bus) return bus;
  if (toolCtx && toolCtx.bus) return toolCtx.bus;
  return (typeof globalThis !== "undefined" ? globalThis.__dlBus : null) || null;
}

function safeLog(tag, e) {
  console.warn(`[hana-downloader] ${tag} 失败（不影响下载）:`, e?.message || String(e));
}

/** 注册 type="download" 的 abort handler：宿主 stop_task 调 abort(taskId) 取消下载。
 *  getTaskManager：函数，返回 TaskManager 实例（dlcore.js 单例，index.js onload 传入）。
 */
export async function registerHandler(bus, getTaskManager) {
  bus = resolveBus(bus);
  if (!bus || typeof getTaskManager !== "function") return;
  try {
    await bus.request("task:register-handler", {
      type: "download",
      abort: async (taskId) => {
        try {
          const manager = getTaskManager();
          if (!manager || !taskId) return;
          manager.cancel(taskId, "user");
        } catch (e) {
          safeLog("abort handler 取消任务", e);
        }
      },
    });
  } catch (e) {
    safeLog("注册 task:register-handler", e);
  }
}

/** 注册任务实例（双注册第二路）。toolCtx 备用：工具上下文携带 bus 时可回退取用。 */
export async function registerTask(bus, task, toolCtx) {
  bus = resolveBus(bus, toolCtx);
  if (!bus || !task || !task.taskId) return;
  if (FINAL[task.state]) return;
  try {
    await bus.request("task:register", {
      taskId: task.taskId,
      type: "download",
      parentSessionPath: task.sessionPath || null,
      parentSessionId: task.sessionId || null,
      pluginId: PLUGIN_ID,
      meta: {
        url: task.url || "",
        fileName: task.fileName || "",
      },
    });
  } catch (e) {
    safeLog("注册 task:register", e);
  }
}

/** 任务完成终结（done）。result 透传宿主。 */
export async function completeTask(bus, taskId, result) {
  bus = resolveBus(bus);
  if (!bus || !taskId) return;
  try {
    await bus.request("task:complete", { taskId, type: "download", result });
  } catch (e) {
    safeLog("task:complete", e);
  }
}

/** 任务取消终结（canceled，agent 主动取消路径）。reason 透传宿主。 */
export async function cancelTask(bus, taskId, reason) {
  bus = resolveBus(bus);
  if (!bus || !taskId) return;
  try {
    await bus.request("task:cancel", { taskId, type: "download", reason });
  } catch (e) {
    safeLog("task:cancel", e);
  }
}

/** 任务失败/取消/中断终结（failed/canceled/interrupted）。reason 透传宿主。 */
export async function failTask(bus, taskId, reason) {
  bus = resolveBus(bus);
  if (!bus || !taskId) return;
  try {
    await bus.request("task:fail", { taskId, type: "download", reason });
  } catch (e) {
    safeLog("task:fail", e);
  }
}
