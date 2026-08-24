// lib/deferred.js — deferred 占位 helper（v0.5.0）
//
// 宿主 deferred 协议（v0.681.5 实测）：
//   deferred:register  注册占位（taskId + sessionId/sessionPath + meta）→ 下载完成时按占位投递唤醒
//   deferred:resolve   解析占位（pending → resolved + 投递 hana-background-result）；占位不存在/已终态则无操作（幂等）
//   deferred:fail      同上，投递失败结果
//   deferred:abort     占位 pending → aborted + 投递失败消息（本插件不用：会误报"任务中止"）
//
// 设计原则（v0.5.0 定稿）：
//   - 占位注册在「任务创建时」由插件自动完成，不依赖 Agent 任何操作（Agent 不调 wait 也能在完成后被唤醒）。
//   - 注册结果回写 task.deferredRegistered：Agent 是否收到"占位已注册"的承诺取决于真实注册状态（信息诚实性）。
//   - 注册完成后若任务已终态（小文件秒下竞态）→ 立即补 resolve，避免幽灵占位。
//   - 占位解析在「任务终态时」由 onFinal 完成；插件 onload 对遗留终态任务做幂等兜底（覆盖热重载缝隙）。
//   - 宿主协议无「按任务取消占位」的 API：wait 已消费（Agent 在会话内拿到了结果）时投递仍在回合结束
//     后送达一次，Agent 自然消化；result 里的 consumedByWait 标记帮助 Agent 识别冗余，避免重复动作。

// bus 兜底：插件 onload 时写入 globalThis.__dlBus；工具执行的 toolCtx 若不带 bus，自动回退到全局。
export function getBus(bus) {
  return bus || (typeof globalThis !== "undefined" ? globalThis.__dlBus : null) || null;
}

/**
 * 注册占位。无会话上下文（sessionId/sessionPath 均缺）时静默跳过——没有会话就无法唤醒，不影响下载本身。
 * 返回 { ok, reason }：ok=false 且 reason 标明跳过原因（no_session / register_failed）。
 * 成功后将 task.deferredRegistered 置真；若注册完成时任务已终态（秒下竞态），立即补 resolve 防幽灵占位。
 * keyOverride：默认用 task.taskId；特殊占位（如停滞 taskId:stall）可覆盖。
 */
export async function registerDeferred(bus, task, extraMeta = {}, keyOverride = null) {
  bus = getBus(bus);
  if (!bus || !task) return { ok: false, reason: "no_bus" };
  const { sessionId, sessionPath } = task;
  if (!sessionId && !sessionPath) return { ok: false, reason: "no_session" };
  const key = keyOverride || task.taskId;
  try {
    await bus.request("deferred:register", {
      taskId: key,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionPath ? { sessionPath } : {}),
      meta: {
        type: "download",
        fileName: task.fileName || "",
        ...(task.url ? { url: task.url } : {}),
        ...extraMeta,
      },
    });
    if (!keyOverride) task.deferredRegistered = true; // 主占位记录注册状态（stall 占位不覆盖任务标记）
    // 竞态防护：注册完成时任务可能已终态（小文件秒下）→ 补 resolve，占位不留幽灵
    if (task.state && (task.state === "done" || task.state === "failed" || task.state === "canceled" || task.state === "interrupted")) {
      await resolveDeferred(bus, task);
    }
    return { ok: true, reason: null };
  } catch (e) {
    return { ok: false, reason: "register_failed", error: e?.message || String(e) };
  }
}

/** 解析占位（终态结果）。幂等：占位不存在或已终态时宿主侧无操作。 */
export function resolveDeferred(bus, task) {
  bus = getBus(bus);
  if (!bus || !task) return Promise.resolve();
  const state = task.state;
  if (state !== "done" && state !== "failed" && state !== "canceled" && state !== "interrupted") {
    return Promise.resolve(); // 非终态不解析
  }
  const userCanceled = state === "canceled" && task.canceledBy === "user";
  // consumedByWait：Agent 已通过 wait 拿到结果，或 wait 正在守望（即将拿到）→ 投递供识别冗余
  const consumed = task.consumedByWait === true || (task.waitActive || 0) > 0;
  const result = {
    type: "download",
    taskId: task.taskId,
    fileName: task.fileName,
    state,
    consumedByWait: consumed,
    ...(state === "done"
      ? { filePath: task.filePath, total: task.total, received: task.received }
      : {
          error: task.error || state,
          canceledBy: task.canceledBy || null,
          userCanceled,
          hint: userCanceled ? "用户手动取消（非故障，无需自动重试或换源）" : null,
          ...(task.filePath ? { filePath: task.filePath } : {}),
        }),
  };
  return bus.request("deferred:resolve", { taskId: task.taskId, result }).catch(() => { /* 无占位忽略 */ });
}
