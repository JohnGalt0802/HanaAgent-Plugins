// tools/download-wait.js — 下载等待/查询工具（v0.5.4：守望开关，默认快照）
//
// 双通道完成通知（v0.5.4 定稿）：
//   - wait（本工具）= 同步通道：插件设置 waitWatchMode 开启时，agent 可守望下载（最多 90 秒），
//     完成时同一回合拿到结果；守望期间 agent 可并行执行其他工具（并行语义）。
//   - deferred = 异步通道：默认路径。waitWatchMode 关闭（默认）时 wait 立即返回快照，
//     agent 收束后由宿主自动投递唤醒（占位在创建时自动注册）。
//   - 两条通道分工不替代：默认走异步（快照 + deferred）；需要回合内同步拿结果时开启守望。
//
// 守望模式（开关开启）出口：
//   · 终态 → 正常返回（同步完成通知）
//   · 停滞 / 双窗降速 / 小文件慢速 / 显著慢于历史（均首窗 5s 后生效）→ 立即返回
//   · 守望预算 90 秒到点 → 返回未完成快照 + 收束指引，并标记禁二次守望（防回查循环）

import { getTaskManager } from "../lib/dlcore.js";

export const name = "download-wait";
export const description =
  "查询或守望下载进度（与 download-file 配合使用）。默认立即返回当前进度快照（不阻塞、不等候）：\n" +
  "已下载完成/失败/取消时返回终态详情；进行中时返回进度/速度/ETA，并提示异常（停滞、小文件慢速、显著慢于历史）。\n" +
  "占位在下载创建时已自动注册：Agent 无需等待，直接收束回合即可，下载完成会自动投递唤醒本会话。\n" +
  "如需在回合内同步拿到结果（守望模式，最多 90 秒），可在插件设置中开启 waitWatchMode。";

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

const WATCH_BUDGET_MS = 90 * 1000;   // 守望预算：90 秒内未完成则收束（deferred 接管），防 agent 长期挂回合
const STALL_MS = 20 * 1000;          // 进度无进展超过 20s 判定疑似卡死
const POLL_MS = 500;                 // 轮询粒度（onceFinal 事件穿透，轮询只是兜底）
const FIRST_WINDOW_S = 5;            // 首窗：仅建立基线/豁免慢速检测，不判定
const WINDOW_S = 10;                 // 常规检测窗：10s
const DROP_RATIO = 0.3;              // 双窗降速判定线：均速 < EMA × 30%
const EMA_ALPHA = 0.3;               // EMA 新样本权重
const SMALL_FILE_BYTES = 100 * 1024 * 1024; // 小文件阈值：< 100MB
const SMALL_FILE_ETA_LIMIT_S = 3 * 60;   // 小文件 ETA 超过 3 分钟判异常缓慢
const HIST_SLOW_RATIO = 0.3;         // 当前速度 < 该域名历史均速 30% 判显著偏慢
const HIST_SLOW_ETA_LIMIT_S = 5 * 60;    // 且 ETA 超过 5 分钟才报

const FINAL = { done: 1, failed: 1, canceled: 1, interrupted: 1 };

export async function execute(input, toolCtx) {
  const taskId = String(input?.taskId || "").trim();
  if (!taskId) throw new Error("缺少 taskId（来自 download-file 的返回值）");

  const manager = getTaskManager(toolCtx.dataDir);

  // 守望开关（插件设置 waitWatchMode，默认关闭）：
  //   关闭（默认）= 立即快照，Agent 收束后由 deferred 异步唤醒；
  //   开启 = 守望最多 90 秒（同步通道），守望期间 Agent 可并行执行其他工具。
  let watchMode = false;
  try {
    watchMode = toolCtx.config?.get?.("waitWatchMode") === true;
  } catch { /* 配置读取失败按默认快照模式 */ }

  // 标记 wait 活跃（提前到拿帧之前：覆盖拿帧期间任务完成的 consumedByWait 判定）
  manager.markWaitActive(taskId);
  let snap = null;
  let watchStart = 0;
  let stalled = false;
  let slowAlert = false;
  let slowSmall = false;
  let histSlow = false;
  try {
    // ── 拿第一帧（最多等 5s）──
    const t0 = Date.now();
    snap = manager.snapshot(taskId);
    while ((!snap || (snap.total == null && (snap.state === "pending" || (snap.state === "running" && snap.received === 0)))) && Date.now() - t0 < 5000) {
      await sleep(200);
      snap = manager.snapshot(taskId);
      if (!snap) break;
    }
    if (!snap) {
      return { content: [{ type: "text", text: `任务 ${taskId} 不存在或已过期（可能已被清理）。` }] };
    }

    // 已终态 → 同步返回结果（两种模式一致）
    if (FINAL[snap.state]) {
      manager.markConsumedByWait(taskId);
      return buildResult(manager, taskId, snap, { immediate: true, waitedMs: 0 });
    }

    // 快照模式（默认，守望开关关闭）：立即返回当前状态，不阻塞；收束后由 deferred 自动唤醒
    if (!watchMode) {
      return buildResult(manager, taskId, snap, { immediate: true, waitedMs: 0, snapshot: true });
    }

    // 守望模式：二次守望拦截（预算已用尽 → 只返回快照，防回查循环）
    if (snap.waitBudgetExhausted === true) {
      return buildResult(manager, taskId, snap, { immediate: true, waitedMs: 0, exhausted: true });
    }

    // ── 守望模式（同步通道）──
    watchStart = Date.now();
    const start = watchStart;
    let lastReceived = snap.received;
    let lastMove = Date.now();
    let percentAtReturn = snap.percent;

    // 双窗降速检测状态
    let baseline = null;
    let prevWindowSlow = false;
    let winStartT = start;
    let winStartR = snap.received;
    let nextCheckAt = start + FIRST_WINDOW_S * 1000;

    while (!FINAL[snap.state] && Date.now() - start < WATCH_BUDGET_MS) {
      // 终态即时唤醒：手动取消/完成瞬间穿透，不等轮询间隔
      const waiter = manager.onceFinal(taskId);
      await Promise.race([sleep(POLL_MS), waiter.promise]);
      waiter.cancel(); // 清理本轮 waiter，防止无界累积
      snap = manager.snapshot(taskId);
      if (!snap) {
        return {
          content: [{ type: "text", text: `任务 ${taskId} 在等待期间消失（可能已被清理）。` }],
        };
      }
      percentAtReturn = snap.percent;

      if (snap.state === "running") {
        // 后端停滞标记（dlcore 层 30s 无新数据）→ 立即返回
        if (snap.stalledAt != null) { stalled = true; break; }
        // 本地卡死检测：received 连续 20s 无增长（覆盖 chunked）
        if (snap.received > lastReceived) {
          lastReceived = snap.received;
          lastMove = Date.now();
        } else if (Date.now() - lastMove >= STALL_MS) {
          stalled = true;
          break;
        }

        // 慢速/历史对比检测：首窗 5s 内豁免（TCP 慢启动/代理建立/测速未稳，避免瞬时低速误报）
        // 主动限速（speedLimit>0）不检测——限速是 Agent 预期行为，速度慢不代表异常
        if (Date.now() - start >= FIRST_WINDOW_S * 1000 && (snap.speedLimit || 0) <= 0) {
          // 小文件慢速检测：<100MB 但 ETA 超 3 分钟 → 异常
          if (snap.total != null && snap.total > 0 && snap.total < SMALL_FILE_BYTES) {
            const eta = etaSecondsOf(snap, false);
            if (eta != null && eta > SMALL_FILE_ETA_LIMIT_S) { slowSmall = true; break; }
          }

          // 显著慢于该域名历史速度：当前 < 历史均速×30% 且 ETA 超 5 分钟
          if (snap.speed > 0 && snap.total != null) {
            const host = hostOf(snap.url);
            const hist = host ? manager.getHostSpeed(host) : null;
            const eta = etaSecondsOf(snap, false);
            if (hist && hist > 0 && snap.speed < hist * HIST_SLOW_RATIO && eta != null && eta > HIST_SLOW_ETA_LIMIT_S) {
              histSlow = true;
              break;
            }
          }
        }

        // ── 双窗降速检测（pending 等非运行态顺延窗口，不消耗检测点）──
        if (Date.now() >= nextCheckAt) {
          if (snap.state !== "running") {
            nextCheckAt = Date.now() + 1000; // 未开跑：顺延，不消耗检测点
          } else {
            const now = Date.now();
            const durS = Math.max(0.001, (now - winStartT) / 1000);
            const winSpeed = (snap.received - winStartR) / durS; // 字节/秒

            if (baseline === null) {
              // 首窗：仅建立基线，不判定（豁免慢启动）
              baseline = Math.max(winSpeed, 1);
            } else {
              const isSlow = winSpeed < baseline * DROP_RATIO;
              if (isSlow && prevWindowSlow) {
                slowAlert = true;
                break; // 连续两窗低于基线 30% → 带诊断包交 Agent 决策
              }
              prevWindowSlow = isSlow;
              baseline = baseline * (1 - EMA_ALPHA) + winSpeed * EMA_ALPHA; // EMA 更新
            }
            // 开新窗
            winStartT = now;
            winStartR = snap.received;
            nextCheckAt = now + WINDOW_S * 1000;
          }
        }
      }
    }
  } finally {
    manager.markWaitInactive(taskId);
  }

  const done = !!FINAL[snap.state];
  if (done) manager.markConsumedByWait(taskId);

  // 预算到点（健康未完成）→ 标记禁二次守望；后续 wait 对该任务直接快照（deferred 接管）
  if (!done && !stalled && !slowAlert && !slowSmall && !histSlow) {
    manager.markWaitBudgetExhausted(taskId);
  }

  return buildResult(manager, taskId, snap, {
    immediate: false,
    waitedMs: Date.now() - watchStart,
    stalled,
    slowAlert,
    slowSmall,
    histSlow,
    etaSeconds: etaSecondsOf(snap, done),
  });
}

// ── 组装返回 ──
function buildResult(manager, taskId, snap, o) {
  const { immediate, waitedMs, stalled, slowAlert, slowSmall, histSlow, exhausted, snapshot } = o;
  const done = !!FINAL[snap.state];
  const etaSeconds = o.etaSeconds != null ? o.etaSeconds : etaSecondsOf(snap, done);
  const hist = snap.url ? (manager.getHostSpeed(hostOf(snap.url)) || null) : null;
  const registered = snap.deferredRegistered === true;

  // 快照模式的一次性异常提示（无时间窗，仅基于当前快照；主动限速不提示）
  let slowSmallSnap = false;
  let histSlowSnap = false;
  if (snapshot && !done && snap.state === "running" && (snap.speedLimit || 0) <= 0) {
    if (snap.total != null && snap.total > 0 && snap.total < SMALL_FILE_BYTES) {
      const eta = etaSecondsOf(snap, false);
      if (eta != null && eta > SMALL_FILE_ETA_LIMIT_S) slowSmallSnap = true;
    }
    if (snap.speed > 0 && snap.total != null) {
      const eta = etaSecondsOf(snap, false);
      if (hist && hist > 0 && snap.speed < hist * HIST_SLOW_RATIO && eta != null && eta > HIST_SLOW_ETA_LIMIT_S) {
        histSlowSnap = true;
      }
    }
  }

  const parts = [];
  if (done) {
    parts.push(`下载结束（${snap.state}${snap.canceledBy === "user" ? "，用户在卡片上手动取消" : ""}）`);
  } else if (exhausted) {
    parts.push("快照（该任务已守望过预算，不再重复守望）");
  } else if (snapshot) {
    parts.push("快照（查询，未守望）");
    if (snap.stalledAt != null) parts.push("注意：该下载已停滞（长时间无新数据）");
    else if (slowSmallSnap) parts.push("提示：小文件（<100MB）下载异常缓慢（ETA 超 3 分钟），正常应秒级完成");
    else if (histSlowSnap) {
      parts.push(`提示：显著慢于该域名历史速度（当前 ${fmtBytes(snap.speed)}/s ≈ 历史 ${fmtBytes(hist)}/s 的 ${snap.speed && hist ? Math.round(snap.speed / hist * 100) : "?"}%）`);
    }
  } else if (immediate) {
    parts.push("快照（查询时已终态）");
  } else if (stalled) {
    parts.push("疑似卡死：下载进度已 20s 无进展或后端停滞标记");
  } else if (slowSmall) {
    parts.push("异常：小文件（<100MB）下载异常缓慢（ETA 超 3 分钟），正常应秒级完成，请决策：换源重下 / 接受慢速继续（收束等自动唤醒）/ 取消任务");
  } else if (histSlow) {
    parts.push(`异常：显著慢于该域名历史速度（当前 ${fmtBytes(snap.speed)}/s ≈ 历史 ${fmtBytes(hist)}/s 的 ${snap.speed && hist ? Math.round(snap.speed / hist * 100) : "?"}%），请决策：换源重下 / 接受慢速继续（收束等自动唤醒）/ 取消任务`);
  } else if (slowAlert) {
    parts.push("降速警报：连续两个检测窗（10s/窗）均速低于常态基线的 30%，请决策：换源重下 / 接受慢速继续（收束等自动唤醒）/ 取消任务");
  } else {
    parts.push(`已守望 ${Math.round(waitedMs / 1000)}s 仍未完成（守望预算 90 秒已到）`);
  }
  parts.push(`进度 ${snap.percent == null ? "—" : snap.percent + "%"}`);
  parts.push(`已下载 ${fmtBytes(snap.received)}` + (snap.total ? ` / ${fmtBytes(snap.total)}` : ""));
  if (snap.speed > 0) parts.push(`速度 ${fmtBytes(snap.speed)}/s`);
  if (etaSeconds != null) parts.push(`预计还需 ${fmtDuration(etaSeconds)}`);
  if (snap.error) parts.push(`错误：${snap.error}`);
  if (done && snap.filePath) parts.push(`文件：${snap.filePath}`);

  // 收束指引：未完成时唯一方向——收束等自动唤醒（deferred 接管），不提供继续守望选项
  let suggestion = null;
  if (!done) {
    if (snapshot) {
      suggestion = registered
        ? "占位已自动注册：下载完成会自动投递唤醒本会话，无需等待，可直接收束回合"
        : "注意：占位未能注册，下载完成不会自动唤醒。建议收束后稍后手动回查，或换源重下";
    } else if (exhausted) {
      suggestion = registered
        ? "占位已自动注册：下载完成会自动投递唤醒本会话。建议直接收束回合，无需再 wait"
        : "注意：占位未能注册，下载完成不会自动唤醒。建议稍后手动回查或换源重下";
    } else if (stalled || slowAlert || slowSmall || histSlow) {
      // 异常：决策后收束（deferred 接管），不再守望
      suggestion = registered
        ? "占位已自动注册：决策后可收束回合，下载完成（或停滞解除）会自动唤醒本会话"
        : "注意：占位未能注册，下载完成不会自动唤醒。建议收束后稍后手动回查";
    } else {
      suggestion = registered
        ? "占位已自动注册：下载完成会自动投递唤醒本会话。建议直接收束回合等自动唤醒（守望预算已到，无需继续 wait）"
        : "注意：占位未能注册，下载完成不会自动唤醒。建议收束后稍后手动回查，或换源重下";
    }
  }

  const summary = parts.join("，") + (suggestion ? `。${suggestion}` : "");

  return {
    content: [{ type: "text", text: summary }],
    details: {
      download: {
        taskId: snap.taskId,
        state: snap.state,
        canceledBy: snap.canceledBy || null,
        userCanceled: snap.canceledBy === "user",
        done: done,
        immediate: immediate,
        exhausted: exhausted,
        stalled: stalled,
        slowAlert: slowAlert,
        slowSmall: slowSmall,
        histSlow: histSlow,
        consumedByWait: done,
        waitedMs: waitedMs,
        total: snap.total,
        received: snap.received,
        percent: snap.percent,
        speed: snap.speed,
        etaSeconds: etaSeconds,
        error: snap.error,
        filePath: snap.filePath,
        fileName: snap.fileName,
        deferredAutoRegistered: registered, // 真实注册状态（非硬编码）
      },
    },
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return n + "B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n, i = -1;
  do { v /= 1024; i += 1; } while (v >= 1024 && i < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + units[i];
}

function etaSecondsOf(snap, done) {
  if (done) return 0;
  if (snap.total && snap.speed > 0 && snap.received < snap.total) {
    return Math.max(0, Math.round((snap.total - snap.received) / snap.speed));
  }
  return null;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

function fmtDuration(s) {
  if (s == null) return "";
  if (s < 60) return Math.max(1, s) + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  return (s / 3600).toFixed(1) + "h";
}
