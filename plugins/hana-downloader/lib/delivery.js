// lib/delivery.js — hana-downloader 投递层唯一权威（v0.11.0）
//
// 设计：
//   - 未收束会话：终态进入 pending 队列，由 extensions/dl-nextturn.js 的
//     before_provider_request 在“下一条 LLM API 请求”里拼入 hana-background-result。
//   - 已收束会话：直接 deferred:resolve 异步唤醒。
//   - agent 取消：静默（download-cancel 同步返回值就是结果）。
//   - user 取消：异步通知（带 canceledBy=user + hint）。
//   - 每任务只允许一条回执：内存 _delivered + 持久化 delivered 双重去重。
//
// 本模块由 index.js 在插件 onload 时创建一次，并订阅 mgr.onFinal/onStall。
// extensions/dl-nextturn.js 只负责把 pending 队列注入当前会话的 provider request。

import fs from "node:fs";
import { getBus, registerDeferred } from "./deferred.js";
import { completeTask, failTask, cancelTask } from "./registry.js";

const TERMINAL = new Set(["done", "failed", "canceled", "interrupted"]);
const SYNC_WAIT_MS = 30000; // 等待下一条 provider request 的时间，超时降级异步。
// 之前 2500 偏短：agent settle 后要思考 2-3 秒才发下一条 LLM 调用，timer 提前清空 pending → injectForSession 永远拿不到数据。
// 改 30 秒覆盖典型 agent reasoning + tool loop 周期。

function statusOf(task) {
  return task ? (task.state || task.status || "") : "";
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function tailSettled(sessionPath) {
  try {
    if (!sessionPath || !fs.existsSync(sessionPath)) return false;
    const size = fs.statSync(sessionPath).size;
    if (size === 0) return false;
    const fd = fs.openSync(sessionPath, "r");
    const buf = Buffer.alloc(Math.min(size, 32768));
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim().length);
    for (let i = lines.length - 1; i >= 0; i--) {
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o.type !== "message" || !o.message) continue;
      const m = o.message;
      if (m.role === "assistant") {
        // 只看最近的 assistant message：stopReason="stop" 才算当前回合已收束。
        // 之前 bug：倒序找到第一个 assistant+stop 就返回 true，忽略更新的 assistant（toolUse 状态），
        // 导致 agent 保持回合（最近的 assistant 是 toolUse）时误判为已收束 → handleFinal 走 deliverAsync 异步 → 不入 pending → injectForSession 拿不到数据。
        return m.stopReason === "stop";
      }
      // toolResult/user message 跳过，继续往上找最近的 assistant
    }
    return false;
  } catch {
    return false;
  }
}

export function createDelivery({ bus, manager, dataDir, log }) {
  const logger = log || { info() {}, warn() {}, error() {} };
  const pending = new Map(); // taskId -> { task, result, entry, timer, sessionPath }

  function logInfo(s) {
    try { logger.info?.(s); } catch {}
  }

  function alreadyHandled(t) {
    return t && (t._delivered === true || t.delivered === true);
  }

  function markDelivered(t) {
    if (!t) return;
    if (manager.markDelivered) { try { manager.markDelivered(t.taskId); } catch {} }
    t._delivered = true;
    t.delivered = true;
  }

  function finalizeRegistry(t) {
    if (!t || t._registryFinalized) return;
    t._registryFinalized = true;
    const b = getBus(undefined);
    if (!b) return;
    const state = statusOf(t);
    if (state === "done") {
      completeTask(b, t.taskId, {
        url: t.url || "", fileName: t.fileName || "", filePath: t.filePath || null,
        total: t.total ?? null, received: t.received ?? 0,
      }).catch(() => {});
    } else if (state === "canceled") {
      cancelTask(b, t.taskId, { state, error: t.error || state, canceledBy: t.canceledBy || null }).catch(() => {});
    } else {
      failTask(b, t.taskId, { state, error: t.error || state, canceledBy: t.canceledBy || null }).catch(() => {});
    }
  }

  function buildResult(task) {
    const state = statusOf(task);
    const status = state === "done" ? "done" : state === "canceled" ? "cancelled" : "error";
    if (state === "done") {
      return { taskId: task.taskId, fileName: task.fileName || "", status, filePath: task.filePath, total: task.total ?? null, received: task.received ?? 0 };
    }
    const userCanceled = state === "canceled" && task.canceledBy === "user";
    return {
      taskId: task.taskId,
      fileName: task.fileName || "",
      status,
      error: task.error || state,
      ...(task.filePath ? { filePath: task.filePath } : {}),
      ...(userCanceled ? { hint: "用户手动取消" } : {}),
    };
  }

  function buildEntry(taskId, result) {
    // 双 status 字段：
    //   status（legacyStatus）= success/failed/aborted，宿主 interlude / 前端 detail 兼容
    //   event-status（新语义）= done/cancelled/error，agent 应该看这个
    // 用 result.status 新语义算 eventStatus；fallback 到 result.state
    const eventStatus = result.status || (result.state === "done" ? "done" : result.state === "canceled" ? "cancelled" : "error");
    const legacyStatus = eventStatus === "done" ? "success" : eventStatus === "cancelled" ? "aborted" : "failed";
    const action = eventStatus === "done" || eventStatus === "cancelled" ? "none" : "decide";
    const body = JSON.stringify(result, null, 2);
    return {
      customType: "hana-background-result",
      content: `<hana-background-result task-id="${esc(taskId)}" status="${esc(legacyStatus)}" event-status="${esc(eventStatus)}" source="system" plugin="hana-downloader" type="download" action="${esc(action)}">\n${esc(body)}\n</hana-background-result>`,
      display: false,
      details: { schemaVersion: 2, taskId, deliveryId: `sync:${taskId}:${Date.now()}`, eventStatus, action },
    };
  }

  async function deliverAsync(t, result) {
    const b = getBus(undefined);
    if (!b) {
      logInfo(`[delivery] NO BUS for ${t.taskId} deferred`);
      markDelivered(t);
      finalizeRegistry(t);
      return;
    }
    try {
      if (t.deferredRegistered !== true) {
        await registerDeferred(b, t, {}, null, null).catch(() => {});
      }
      await b.request("deferred:resolve", { taskId: t.taskId, result });
      markDelivered(t);
      finalizeRegistry(t);
      logInfo(`[delivery] ASYNC ${t.taskId} (${statusOf(t)}) → deferred:resolve`);
    } catch (e) {
      logInfo(`[delivery] ASYNC ERR ${t.taskId}: ${e?.message || e}`);
    }
  }

  function enqueueSync(t, entry, keyOverride = null, kind = "final") {
    const key = keyOverride || t.taskId;
    const item = {
      task: t,
      result: entry._result,
      entry,
      sessionPath: t.sessionPath || t.sessionRef?.path || null,
      timer: null,
      kind,
    };
    // 入队即置位（而非等到注入/超时才置）：
    // 同一 manager 单例上若残留多个 onStall/onFinal 订阅（dev 槽重载未退订），
    // 并发回调对同一任务会各入队一个 pending → 双 stallKey/双投。
    // 入队瞬间抢占旗标，后续订阅直接跳过。
    if (kind === "stall") {
      if (t) t._stallDelivered = true;
    } else if (t) {
      t._delivered = true;
    }
    pending.set(key, item);
    item.timer = setTimeout(() => {
      if (pending.get(key) !== item) return;
      pending.delete(key);
      logInfo(`[delivery] SYNC TIMEOUT ${key} (${kind}) → fallback`);
      if (kind === "stall") {
        t._stallDelivered = true;
      } else {
        deliverAsync(t, item.result).catch(() => {});
      }
    }, SYNC_WAIT_MS);
    if (item.timer.unref) item.timer.unref();
  }

  async function handleFinal(task) {
    if (!task) return;
    const taskId = task.taskId;
    const state = statusOf(task);
    if (!TERMINAL.has(state)) return;
    const t = manager.getTask ? (manager.getTask(taskId) || task) : task;
    if (!t) return;

    if (alreadyHandled(t)) {
      logInfo(`[delivery] skip ${taskId}: already delivered`);
      return;
    }

    if (t.consumedByWait === true || (t.waitActive || 0) > 0) {
      markDelivered(t);
      finalizeRegistry(t);
      logInfo(`[delivery] skip ${taskId}: consumedByWait`);
      return;
    }

    if (state === "canceled" && t.canceledBy === "agent") {
      markDelivered(t);
      finalizeRegistry(t);
      logInfo(`[delivery] skip ${taskId}: canceled-by-agent → silent`);
      return;
    }

    const result = buildResult(t);
    const entry = buildEntry(taskId, result);
    entry._result = result;

    // 已收束 → 直接异步
    if (tailSettled(t.sessionPath || t.sessionRef?.path)) {
      logInfo(`[delivery] settled ${taskId} → async deferred`);
      deliverAsync(t, result).catch(() => {});
      return;
    }

    // 未收束 → 入队等待 before_provider_request 注入。
    // 关键：入队前立即置位 _stallDelivered/_delivered，防止并发/重复订阅
    // （dev 槽重载残留）对同一 stall 事件二次入队 → 双 stallKey 双投。
    logInfo(`[delivery] unsettled ${taskId} → enqueue sync injection`);
    enqueueSync(t, entry);
  }

  async function handleStall(task) {
    if (!task || !task.taskId) return;
    const taskId = task.taskId;
    const t = manager.getTask ? (manager.getTask(taskId) || task) : task;
    if (!t) return;
    if (t._stallDelivered) return;
    if (t.consumedByWait === true || (t.waitActive || 0) > 0) return;

    const stallKey = taskId + ":stall:" + Date.now();
    const result = {
      taskId,
      fileName: t.fileName || "",
      url: t.url || "",
      status: "stall",
      hint: "下载连接已停滞，以最新 download-wait / done 通知为准",
    };
    const entry = buildEntry(stallKey, result);
    entry._result = result;

    if (tailSettled(t.sessionPath || t.sessionRef?.path)) {
      const b = getBus(undefined);
      if (!b) return;
      b.request("deferred:register", {
        taskId: stallKey,
        ...(t.sessionId ? { sessionId: t.sessionId } : {}),
        ...(t.sessionPath ? { sessionPath: t.sessionPath } : {}),
        meta: { type: "download-stall", fileName: t.fileName || "", url: t.url || "" },
      }).catch(() => {});
      b.request("deferred:resolve", { taskId: stallKey, result }).catch(() => {});
      t._stallDelivered = true;
      return;
    }

    enqueueSync(t, entry, stallKey, "stall");
  }

  // 供 extension 调用：把当前会话 pending 的消息注入 provider payload
  function injectForSession(sessionPath, payload) {
    if (!payload || !Array.isArray(payload.messages) || pending.size === 0) return payload;
    const injected = [];
    for (const [key, item] of Array.from(pending)) {
      try { fs.appendFileSync('D:/HanakoWorks/_temp/inject-content.log', `[${new Date().toISOString()}] key=${key} entry.content_head=${(item.entry.content||'').slice(0,220)}\n`); } catch {}
      const itemSession = item.sessionPath || item.task?.sessionPath || item.task?.sessionRef?.path;
      if (sessionPath && itemSession && !sameSession(sessionPath, itemSession)) continue;
      clearTimeout(item.timer);
      pending.delete(key);
      payload.messages.push({
        role: "user",
        content: item.entry.content,
        ...(item.entry.details ? { details: item.entry.details } : {}),
      });
      const realTask = item.task;
      if (item.kind === "stall") {
        if (realTask) realTask._stallDelivered = true;
      } else {
        if (realTask && realTask.taskId) markDelivered(realTask);
        finalizeRegistry(realTask);
      }
      injected.push(key);
    }
    if (injected.length) logInfo(`[delivery] INJECT ${injected.join(",")} into next provider request`);
    return payload;
  }

  function sameSession(a, b) {
    const na = String(a).split(/[\\/]/).pop();
    const nb = String(b).split(/[\\/]/).pop();
    return !na || !nb || na === nb;
  }

  // 订阅 dlcore 终态/停滞（唯一权威，index.js 创建一次）
  // onFinal 是覆盖式单订阅（dlcore 内 _finalCb 直接替换），重复 onload 天然只留一份；
  // onStall 是多订阅数组，必须保存退订函数供 dispose 使用——
  // dev 槽重载/插件卸载时若不退订，旧回调残留在同一 manager 单例上，
  // 一个 stall 事件会被多个 delivery 实例各投一次（双投 bug 实测 2026-09-01）。
  const unsubStall = typeof manager.onStall === "function"
    ? manager.onStall((task) => { handleStall(task || null).catch(() => {}); })
    : null;
  if (typeof manager.onFinal === "function") {
    manager.onFinal((task) => { handleFinal(task || null).catch(() => {}); });
  }

  // 释放本实例对 manager 的订阅（index.js 重载/dev 槽切换前调用）
  function dispose() {
    if (typeof unsubStall === "function") {
      try { unsubStall(); } catch {}
    }
  }

  return { injectForSession, handleFinal, handleStall, dispose };
}
