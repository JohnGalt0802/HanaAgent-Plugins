// tools/download-wait.js — 下载等待/回查工具
// 两种模式（可在插件设置里切换默认）：
//   auto（默认）：工具内部先拿文件总大小，按分档规则本地估算等待阈值（不费 LLM 算力）；
//                 若显式传入 timeoutMs 则作为阈值上限覆盖。
//   manual：直接用 timeoutMs（未传则用插件设置 manualTimeoutMs，默认 60000）。
// 轮询过程中检测"卡死"（进度长时间不动）会提前返回，不等阈值到点。
// 返回完整进度快照供 Agent 决策（继续等 / 取消 / 换源）。

import { getTaskManager } from "../lib/dlcore.js";

export const name = "download-wait";
export const description =
  "等待并回查一个下载任务的进度（与 download-file 配合使用）。内部轮询任务状态，直到任务完成、失败、被取消、达到超时时间，或检测到进度长时间不动（疑似卡死）。" +
  "auto 模式（默认）会自动按文件大小估算合理等待时长，Agent 无需自己算阈值；也可传 timeoutMs 手动指定。" +
  "返回最新进度快照（state/total/received/percent/speed/eta/error/filePath/stalled 等），Agent 据此决策：正常→继续等；疑似卡死或速度过慢→取消/换源；完成→使用文件；失败→按错误重试。";

export const parameters = {
  type: "object",
  properties: {
    taskId: {
      type: "string",
      description: "download-file 返回的任务 ID",
    },
    mode: {
      type: "string",
      enum: ["auto", "manual"],
      description: "可选：auto=按文件大小自动估算等待阈值（默认，也可在插件设置中切换）；manual=用 timeoutMs 手动阈值",
    },
    timeoutMs: {
      type: "number",
      description: "可选：手动等待毫秒数（manual 模式必用；auto 模式下作为估算阈值的上限）。默认按模式取插件设置值。",
    },
  },
  required: ["taskId"],
};

const HARD_CAP_MS = 30 * 60 * 1000;   // 单次等待硬上限 30 分钟
const STALL_MS = 20 * 1000;           // 进度无进展超过 20s 判定疑似卡死
const POLL_MS = 1000;

// auto 分档估算：文件越小档位越短（单位毫秒）；有同域名历史速度时用 total/历史速度×1.5 更准
function autoTimeoutFor(total, histSpeed) {
  if (total == null) return 60_000;              // 无 Content-Length：保守 60s
  if (histSpeed && histSpeed > 0) {
    const est = Math.round((total / histSpeed) * 1000 * 1.5); // 安全系数 1.5
    return Math.min(Math.max(est, 15_000), 3_600_000);        // 15s ~ 60min
  }
  if (total <= 10 * 1024 * 1024) return 60_000;   // ≤10MB
  if (total <= 100 * 1024 * 1024) return 300_000; // ≤100MB
  if (total <= 500 * 1024 * 1024) return 900_000; // ≤500MB
  if (total <= 2 * 1024 * 1024 * 1024) return 1_800_000; // ≤2GB
  return 3_600_000;                               // 更大
}

export async function execute(input, toolCtx) {
  const taskId = String(input?.taskId || "").trim();
  if (!taskId) throw new Error("缺少 taskId（来自 download-file 的返回值）");

  const manager = getTaskManager(toolCtx.dataDir);

  const FINAL = { done: 1, failed: 1, canceled: 1, interrupted: 1 };

  // ── 模式解析：显式 mode > 插件设置 > 默认 auto ──
  let mode = String(input?.mode || "").toLowerCase() === "manual" ? "manual" : "auto";
  try {
    const cfg = toolCtx.config?.get?.("waitMode");
    if (cfg === "manual") mode = "manual";
  } catch { /* 忽略配置错误 */ }

  let manualMs = 60_000;
  try {
    const v = Number(toolCtx.config?.get?.("manualTimeoutMs"));
    if (Number.isFinite(v) && v > 0) manualMs = v;
  } catch { /* 忽略 */ }

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

  // ── 计算等待阈值 ──
  let timeoutMs;
  let thresholdUsed;
  if (mode === "manual") {
    timeoutMs = Number.isFinite(Number(input?.timeoutMs)) && Number(input.timeoutMs) > 0
      ? Number(input.timeoutMs)
      : manualMs;
    thresholdUsed = `manual(${timeoutMs}ms)`;
  } else {
    let histSpeed = null;
    try {
      const u = new URL(snap.url || "");
      if (u.host) histSpeed = manager.getHostSpeed(u.host);
    } catch { /* 忽略 */ }
    timeoutMs = autoTimeoutFor(snap.total, histSpeed);
    if (Number.isFinite(Number(input?.timeoutMs)) && Number(input.timeoutMs) > 0) {
      timeoutMs = Math.min(timeoutMs, Number(input.timeoutMs));
    }
    thresholdUsed = `auto(${timeoutMs}ms)` + (snap.total != null ? `, total=${fmtBytes(snap.total)}` : "") + (histSpeed ? `, 历史速度 ${fmtBytes(histSpeed)}/s` : "");
  }
  timeoutMs = Math.min(timeoutMs, HARD_CAP_MS);

  // ── 轮询：完成 / 失败 / 超时 / 卡死提前返回 ──
  const start = Date.now();
  let lastReceived = snap.received;
  let lastMove = Date.now();
  let stalled = false;
  let percentAtReturn = snap.percent;

  while (!FINAL[snap.state] && Date.now() - start < timeoutMs) {
    await sleep(POLL_MS);
    snap = manager.snapshot(taskId);
    if (!snap) {
      return {
        content: [{ type: "text", text: `任务 ${taskId} 在等待期间消失（可能已被清理）。` }],
      };
    }
    percentAtReturn = snap.percent;
    // 卡死检测：下载中但进度（received）长时间无进展。total 未知（chunked）时也纳入检测
    if (snap.state === "running" && snap.received > 0 && (snap.total == null || snap.received < snap.total)) {
      if (snap.received !== lastReceived) {
        lastReceived = snap.received;
        lastMove = Date.now();
      } else if (Date.now() - lastMove >= STALL_MS) {
        stalled = true;
        break;
      }
    }
  }

  const elapsedMs = Date.now() - start;
  const done = !!FINAL[snap.state];
  const etaSeconds = etaSecondsOf(snap, done);
  const speedOk = snap.speed > 0 || done;

  const parts = [];
  if (stalled) parts.push("疑似卡死：下载进度已 20s 无进展");
  else if (done) parts.push(`下载结束（${snap.state}）`);
  else parts.push(`等待 ${Math.round(elapsedMs / 1000)}s 后仍在下载中（未完成，阈值 ${thresholdUsed}）`);
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
        done: done,
        timedOut: !done && !stalled,
        stalled: stalled,
        stalledAt: snap.stalledAt || null,
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
