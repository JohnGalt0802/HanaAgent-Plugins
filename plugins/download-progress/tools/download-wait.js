// tools/download-wait.js — 下载等待/回查工具（v0.4.0：健康续窗 + 双窗降速警报）
//
// 设计原则（v0.4.0 定稿）：
//   检测归脚本，决策归 Agent。健康状态下 wait 一直挂着直到终态，
//   Agent 不被打扰；唯一的提前返回口是「异常」：
//   - 终态（done/failed/canceled/interrupted）→ 正常出口
//   - 停滞（后端 stalled 标记 / 本地 20s 无进展）→ 清零立即返回
//   - 双窗降速（连续两个检测窗均速 < EMA 基线 ×30%）→ 带诊断包返回，交 Agent 决策
//
// 检测窗模型：
//   - 首窗 5s：仅建立 EMA 基线，不判定（豁免 TCP 慢启动）
//   - 此后每 10s 一个检测窗：均速 < EMA×30% 且上窗亦然 → 触发降速警报
//   - EMA 更新：baseline = baseline×0.7 + winSpeed×0.3（反映近期常态，抗单点抖动）
//   - 任务处于 pending 等非运行态时窗口顺延，不消耗检测点
//
// 模式：
//   auto（默认）：上述全自动守望。
//   self（慎用）：Agent 全权——传 timeoutMs 硬等，不传查一次立即返回。
// notifyWhenDone=true（大文件专用）：wait 时间清零即时返回快照；
//   若任务仍在下则注册 deferred 双占位（终态+停滞），回合结束后终态投递唤醒 Agent。

import { getTaskManager } from "../lib/dlcore.js";

export const name = "download-wait";
export const description =
  "等待并回查一个下载任务的进度（与 download-file 配合使用）。\n" +
  "auto 模式（默认，推荐）：脚本全程守望——健康则持续等待直到终态（期间零打扰），\n" +
  "异常立即返回：完成/失败/取消正常返回；停滞或连续两个检测窗（10s/窗）均速跌破常态基线 30%\n" +
  "则带诊断包（当前速度/基线/比值/ETA）提前返回，交 Agent 决策（换源/接受慢速/取消）。\n" +
  "notifyWhenDone=true 用于结束回合前：立即返回快照并注册后台通知，离场后终态投递唤醒。\n" +
  "self 模式（慎用）：Agent 全权决定回查节奏。";

export const parameters = {
  type: "object",
  properties: {
    taskId: {
      type: "string",
      description: "download-file 返回的任务 ID",
    },
    mode: {
      type: "string",
      enum: ["auto", "self"],
      description: "可选：auto=脚本全程守望（默认，推荐）；self=Agent 自觉回查（回查时机与等待时长全由 Agent 自主决定，不传 timeoutMs 则查一次立即返回；慎用，会增加调用与上下文占用）",
    },
    timeoutMs: {
      type: "number",
      description: "可选：auto 模式下作为总等待硬上限（安全阀，默认 30 分钟）；self 模式下是 Agent 自定的等待时长（不传则查一次立即返回）",
    },
    notifyWhenDone: {
      type: "boolean",
      description: "可选（大文件专用）：设为 true 表示'本次回查后会话将结束，若下载未完成请在完成/失败时通知我'——工具立即返回当前快照（不等观察窗），若任务仍在下则注册后台通知（deferred），下载完成/失败时宿主投递提醒唤醒 Agent。仅 Agent 决定结束回合且下载未完时使用；小下载用普通 wait 等到 done 即可，无需此参数。",
    },
  },
  required: ["taskId"],
};

const HARD_CAP_MS = 30 * 60 * 1000;   // 单次等待硬上限（安全阀，防无限挂起）
const STALL_MS = 20 * 1000;           // 进度无进展超过 20s 判定疑似卡死（速度为零的哨兵）
const POLL_MS = 500;                  // 轮询粒度（onceFinal 事件穿透，轮询只是兜底）
const FIRST_WINDOW_S = 5;             // 首窗：仅建立基线，不判定
const WINDOW_S = 10;                  // 常规检测窗：10s
const DROP_RATIO = 0.3;               // 降速判定线：均速 < EMA × 30%
const EMA_ALPHA = 0.3;                // EMA 新样本权重（反映近期常态）

const FINAL = { done: 1, failed: 1, canceled: 1, interrupted: 1 };

export async function execute(input, toolCtx) {
  const taskId = String(input?.taskId || "").trim();
  if (!taskId) throw new Error("缺少 taskId（来自 download-file 的返回值）");

  const manager = getTaskManager(toolCtx.dataDir);

  // ── 模式解析：显式 mode > 插件设置 > 默认 auto ──
  const explicitMode = String(input?.mode || "").toLowerCase();
  let mode = explicitMode === "self" || explicitMode === "manual" ? "self"
    : explicitMode === "auto" ? "auto" : null;
  if (!mode) {
    mode = "auto";
    try {
      if (toolCtx.config?.get?.("waitMode") === "self") mode = "self";
    } catch { /* 忽略配置错误 */ }
  }

  let manualMs = 60_000;
  try {
    const v = Number(toolCtx.config?.get?.("manualTimeoutMs"));
    if (Number.isFinite(v) && v > 0) manualMs = v;
  } catch { /* 忽略 */ }
  void manualMs;

  // ── 先拿第一帧（任务可能刚创建；total 在下载开始后才有，最多等 5s）──
  const t0 = Date.now();
  let snap = manager.snapshot(taskId);
  while ((!snap || snap.total == null) && Date.now() - t0 < 5000) {
    await sleep(200);
    snap = manager.snapshot(taskId);
    if (!snap) break;
  }
  if (!snap) {
    return { content: [{ type: "text", text: `任务 ${taskId} 不存在或已过期（可能已被清理）。` }] };
  }

  // ── notifyWhenDone：即时快照 + 若未完成注册 deferred 双占位 ──
  const notifyWhenDone = input?.notifyWhenDone === true || String(input?.notifyWhenDone) === "true";

  // ── self 模式的等待窗 ──
  const explicitTimeoutMs = Number.isFinite(Number(input?.timeoutMs)) && Number(input.timeoutMs) > 0
    ? Number(input.timeoutMs)
    : null;
  let windowMs;
  let thresholdUsed;
  if (notifyWhenDone) {
    windowMs = 0;
    thresholdUsed = "notifyWhenDone(即时快照+后台通知)";
  } else if (mode === "self") {
    if (explicitTimeoutMs) {
      windowMs = Math.min(explicitTimeoutMs, HARD_CAP_MS);
      thresholdUsed = `self(${Math.round(windowMs / 1000)}s)`;
    } else {
      windowMs = 0;
      thresholdUsed = "self(即时快照)";
    }
  } else {
    // auto：健康续窗模型——循环内按检测窗推进直至终态，硬上限兜底
    windowMs = explicitTimeoutMs ? Math.min(explicitTimeoutMs, HARD_CAP_MS) : HARD_CAP_MS;
    thresholdUsed = `auto(守望至终态, 上限 ${Math.round(windowMs / 60000)}min)`;
  }

  // ── 等待主循环 ──
  const start = Date.now();
  let lastReceived = snap.received;
  let lastMove = Date.now();
  let stalled = false;
  let percentAtReturn = snap.percent;

  // 双窗降速检测状态
  let baseline = null;        // EMA 基线（近期常态均速，字节/秒）
  let prevWindowSlow = false; // 上一检测窗是否低于阈值
  let slowAlert = false;      // 双窗降速触发
  let winStartT = start;         // 当前检测窗起点时间
  let winStartR = snap.received; // 当前检测窗起点字节
  let nextCheckAt = start + FIRST_WINDOW_S * 1000; // 首窗 5s：只建基线不判定

  while (!FINAL[snap.state] && Date.now() - start < windowMs) {
    // 终态即时唤醒：手动取消/完成瞬间穿透，不等轮询间隔
    await Promise.race([sleep(POLL_MS), manager.onceFinal(taskId)]);
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
    }

    // ── 双窗降速检测（仅 auto 模式；pending 等非运行态顺延窗口，不消耗检测点）──
    if (mode === "auto" && !notifyWhenDone && Date.now() >= nextCheckAt) {
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

  const elapsedMs = Date.now() - start;
  const done = !!FINAL[snap.state];
  const etaSeconds = etaSecondsOf(snap, done);
  const speedOk = snap.speed > 0 || done;

  // ── 组装输出 ──
  const parts = [];
  if (stalled) parts.push("疑似卡死：下载进度已 20s 无进展或后端停滞标记");
  else if (done) parts.push(`下载结束（${snap.state}${snap.canceledBy === "user" ? "，用户在卡片上手动取消" : ""}）`);
  else if (slowAlert) {
    const ratio = baseline ? Math.round((snap.speed / baseline) * 100) : null;
    parts.push(`降速警报：连续两个检测窗（${WINDOW_S}s/窗）均速低于常态基线的 ${Math.round(DROP_RATIO * 100)}%`
      + `（当前 ${fmtBytes(snap.speed)}/s ≈ 基线 ${fmtBytes(baseline)}/s 的 ${ratio == null ? "?" : ratio + "%"}），请决策：换源重下 / 接受慢速继续（再次调用 wait 守望）/ 取消任务`);
  } else if (mode === "self" && !explicitTimeoutMs) parts.push("快照（self 模式即时返回，Agent 自主决定回查节奏）");
  else parts.push(`等待 ${Math.round(elapsedMs / 1000)}s 后仍在下载中（未完成，已达上限 ${thresholdUsed}）——健康下载会一直守到终态，本次返回即触及上限`);
  parts.push(`进度 ${percentAtReturn == null ? "—" : percentAtReturn + "%"}`);
  parts.push(`已下载 ${fmtBytes(snap.received)}` + (snap.total ? ` / ${fmtBytes(snap.total)}` : ""));
  if (snap.speed > 0) parts.push(`速度 ${fmtBytes(snap.speed)}/s`);
  if (etaSeconds != null) parts.push(`预计还需 ${fmtDuration(etaSeconds)}`);
  if (snap.error) parts.push(`错误：${snap.error}`);
  if (done && snap.filePath) parts.push(`文件：${snap.filePath}`);
  const summary = parts.join("，");

  return {
    content: [{ type: "text", text: summary }],
    details: {
      download: {
        taskId: snap.taskId,
        state: snap.state,
        canceledBy: snap.canceledBy || null,
        userCanceled: snap.canceledBy === "user",
        done: done,
        timedOut: !done && !stalled && !slowAlert,
        stalled: stalled,
        stalledAt: snap.stalledAt || null,
        slowAlert: slowAlert,
        speedBaseline: slowAlert ? Math.round(baseline) : null,
        mode: mode,
        thresholdUsed: thresholdUsed,
        waitedMs: elapsedMs,
        total: snap.total,
        received: snap.received,
        percent: percentAtReturn,
        speed: snap.speed,
        etaSeconds: etaSeconds,
        speedOk: speedOk,
        error: snap.error,
        filePath: snap.filePath,
        fileName: snap.fileName,
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

function fmtDuration(s) {
  if (s == null) return "";
  if (s < 60) return Math.max(1, s) + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  return (s / 3600).toFixed(1) + "h";
}
