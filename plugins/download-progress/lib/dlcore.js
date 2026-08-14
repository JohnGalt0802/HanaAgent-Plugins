// lib/tasks.js — 下载任务管理器（插件进程内单例）
// 职责：创建/准备下载任务、流式下载 + 进度统计、限速、取消、状态快照、持久化恢复。
// 不依赖任何第三方库，使用 Node 18+ 全局 fetch。

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const TASKS_FILE = "tasks.json";
const SPEED_CACHE_FILE = "speed-cache.json";
const SPEED_CACHE_MAX = 50;    // 历史速度缓存条目上限
const SPEED_CACHE_KEEP = 5;    // 每域名保留最近样本数
const MAX_TASKS = 64;
const SPEED_SAMPLE_MS = 700;   // 测速采样间隔
const SPEED_SAMPLES_MAX = 5;   // 滑动窗口样本数（≈3.5s）
const CHUNK_SLEEP_MIN_MS = 1;  // 限速时 chunk 间最小等待

let _instance = null;
const MGR_VER = 12; // 每次修改管理器逻辑 +1：globalThis 单例按版本换新实例，绕开插件加载器的 lib 模块缓存
// v1.6.0: 命令型任务（git clone / pnpm install）——_runCommand + 停滞监视器提取 + kind/cmd/unit/stage/child 字段

// 真单例：插件加载器按 import 字符串（./lib vs ../lib）缓存模块，可能产生多个模块实例，
// 用 globalThis 兜底保证所有引用方拿到同一个 TaskManager；版本变化时强制重建。
export function getTaskManager(dataDir) {
  const cur = globalThis.__dlTaskMgr;
  if (cur && cur.__ver === MGR_VER) return cur;
  if (_instance && _instance.__ver === MGR_VER) {
    globalThis.__dlTaskMgr = _instance;
    return _instance;
  }
  _instance = new TaskManager(dataDir);
  _instance.__ver = MGR_VER;
  globalThis.__dlTaskMgr = _instance;
  return _instance;
}

/** 主要供测试/重置 */
export function _resetTaskManager() {
  _instance = null;
}

class TaskManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.downloadDir = path.join(dataDir, "downloads");
    this.tasks = new Map();
    this._finalCb = null;
    this._stallCb = null;
    this._speedCache = null; // 惰性加载
  }

  // ── 历史下载速度缓存（按域名；供 wait auto 模式估算阈值，本地计算不费模型算力）──
  _loadSpeedCache() {
    if (this._speedCache) return this._speedCache;
    try {
      this._speedCache = JSON.parse(fs.readFileSync(path.join(this.dataDir, SPEED_CACHE_FILE), "utf-8"));
    } catch { this._speedCache = {}; }
    return this._speedCache;
  }

  _saveSpeedCache() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(path.join(this.dataDir, SPEED_CACHE_FILE), JSON.stringify(this._speedCache), "utf-8");
    } catch { /* 缓存写入失败不影响下载 */ }
  }

  recordSpeed(host, speed) {
    if (!host || !Number.isFinite(speed) || speed <= 0) return;
    const cache = this._loadSpeedCache();
    const list = cache[host] || (cache[host] = []);
    list.push({ speed: Math.round(speed), at: Date.now() });
    if (list.length > SPEED_CACHE_KEEP) list.splice(0, list.length - SPEED_CACHE_KEEP);
    // 整体条目数上限：清最老的域名
    const hosts = Object.keys(cache);
    if (hosts.length > SPEED_CACHE_MAX) {
      hosts.sort((a, b) => (cache[a][cache[a].length - 1]?.at || 0) - (cache[b][cache[b].length - 1]?.at || 0));
      for (const h of hosts.slice(0, hosts.length - SPEED_CACHE_MAX)) delete cache[h];
    }
    this._saveSpeedCache();
  }

  getHostSpeed(host) {
    const list = this._loadSpeedCache()[host];
    if (!list || !list.length) return null;
    const avg = list.reduce((a, s) => a + s.speed, 0) / list.length;
    return avg > 0 ? avg : null;
  }

  // 注册终态回调（done/failed/canceled），供插件层做 deferred 通知
  onFinal(cb) { this._finalCb = typeof cb === "function" ? cb : null; }

  _fireFinal(task) {
    if (!this._finalCb || !task) return;
    const s = task.state;
    if (s === "done" || s === "failed" || s === "canceled" || s === "interrupted") {
      try { this._finalCb(task); } catch { /* 通知失败不影响下载 */ }
    }
  }

  // 注册停滞回调：无新数据超过 stallTimeoutMs 时触发一次（进度恢复后可再次触发）
  onStall(cb) { this._stallCb = typeof cb === "function" ? cb : null; }

  _fireStall(task) {
    if (!this._stallCb || !task) return;
    try {
      const r = this._stallCb(task);
      if (r && typeof r.catch === "function") r.catch(() => {}); // 异步回调异常也不影响下载
    } catch { /* 通知失败不影响下载 */ }
  }

  // ── 创建并立即启动任务 ──
  create({ url, fileName, saveDir, speedLimit, sessionId, sessionRef, stallTimeoutMs, sessionPath, kind = "url", cmd = null, unit = "bytes", filePath }) {
    const task = this._createTask({ url, fileName, saveDir, speedLimit, sessionId, sessionRef, stallTimeoutMs, sessionPath, kind, cmd, unit, filePath });
    this._run(task); // 后台执行，不等待
    return task;
  }

  // ── 准备任务（pending）：先占位，延迟后自动启动，保证卡片从 0% 开始渲染 ──
  prepare({ url, fileName, saveDir, speedLimit, startDelayMs, sessionId, sessionRef, stallTimeoutMs, sessionPath, kind = "url", cmd = null, unit = "bytes", filePath }) {
    const task = this._createTask({ url, fileName, saveDir, speedLimit, sessionId, sessionRef, state: "pending", stallTimeoutMs, sessionPath, kind, cmd, unit, filePath });
    // 严格解析延迟：只有有限正数才走延迟路径，其余（0/undefined/非法）立即启动
    const raw = Number(startDelayMs);
    const delay = Number.isFinite(raw) && raw > 0 ? raw : 0;
    if (delay > 0) {
      task.pendingTimer = setTimeout(() => {
        this.startPending(task.taskId);
      }, delay);
      if (task.pendingTimer?.unref) task.pendingTimer.unref();
    } else {
      // 立即启动；若同步启动失败，标记失败，避免任务永久卡在 pending（无 timer、无 controller）
      try {
        this.startPending(task.taskId);
      } catch (e) {
        task.state = "failed";
        task.error = friendlyError(e);
        task.finishedAt = Date.now();
        this._persist();
        this._fireFinal(task);
      }
    }
    return task;
  }

  // 启动 pending 任务
  startPending(taskId) {
    const t = this.tasks.get(taskId);
    if (!t || t.state !== "pending") return { ok: false, error: "任务不存在或不在准备中" };
    t.state = "running";
    t.startedAt = Date.now();
    t.controller = new AbortController();
    this._persist();
    this._run(t);
    return { ok: true };
  }

  _createTask({ url, fileName, saveDir, speedLimit, sessionId, sessionRef, state, stallTimeoutMs = 30000, sessionPath = null, kind = "url", cmd = null, unit = "bytes", filePath: explicitPath = null }) {
    if (this.tasks.size >= MAX_TASKS) {
      // 清理最老的已结束任务
      for (const [id, t] of this.tasks) {
        if (t.state !== "running" && t.state !== "pending") { this.tasks.delete(id); if (this.tasks.size < MAX_TASKS) break; }
      }
      if (this.tasks.size >= MAX_TASKS) throw new Error("下载任务过多，请稍后再试");
    }

    const dir = saveDir || this.downloadDir;
    fs.mkdirSync(dir, { recursive: true });

    const rawName = (fileName && String(fileName).trim()) || fileNameFromUrl(url);
    const name = sanitizeFileName(rawName);
    const filePath = explicitPath || uniquePath(path.join(dir, name));

    const taskId = randomUUID().slice(0, 8) + "-" + Date.now().toString(36);
    const task = {
      taskId,
      url,
      fileName: path.basename(filePath),
      filePath,
      saveDir: dir,
      state: state || "running",
      total: null,
      received: 0,
      speed: 0,
      startedAt: state === "pending" ? null : Date.now(),
      finishedAt: null,
      elapsed: 0,
      error: null,
      cancelRequested: false,
      sessionId: sessionId || null,
      sessionRef: sessionRef || null,
      speedLimit: Number.isFinite(speedLimit) && speedLimit > 0 ? speedLimit : 0,
      controller: state === "pending" ? null : new AbortController(),
      pendingTimer: null,
      _samples: [],
      stalledAt: null,
      stallNotified: false,
      _lastProgressAt: Date.now(),
      stallTimeoutMs: Number.isFinite(stallTimeoutMs) && stallTimeoutMs > 0 ? stallTimeoutMs : 30000,
      sessionPath: sessionPath || null,
      kind,
      cmd,
      unit,
      stage: null,
      child: null,
    };
    this.tasks.set(taskId, task);
    this._persist();
    return task;
  }

  // ── 后台下载循环 ──
  _startStallMonitor(task) {
    task._stallTimer = setInterval(() => {
      try {
        if (task.state !== "running") return;
        if (Date.now() - task._lastProgressAt >= task.stallTimeoutMs) {
          if (task.stalledAt == null) {
            task.stalledAt = Date.now();
            this._persist(); // 停滞触发即刷盘，避免排查时只能靠内存态
          }
          if (!task.stallNotified) {
            task.stallNotified = true;
            this._fireStall(task);
          }
        } else if (task.stalledAt != null) {
          // 进度恢复：解除停滞，允许再次停滞再通知
          task.stalledAt = null;
          task.stallNotified = false;
        }
      } catch { /* 停滞判定异常不影响下载 */ }
    }, 5000);
    if (task._stallTimer?.unref) task._stallTimer.unref();
  }

  _stopStallMonitor(task) {
    if (task._stallTimer) { clearInterval(task._stallTimer); task._stallTimer = null; }
  }

  async _run(task) {
    if (task.kind === "command") { await this._runCommand(task); return; }

    const ws = fs.createWriteStream(task.filePath);
    this._startStallMonitor(task);
    try {
      const res = await fetch(task.url, {
        signal: task.controller.signal,
        redirect: "follow",
        headers: {
          "User-Agent": "HanaAgent/1.0 (download-progress)",
          "Accept": "*/*",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if (!res.body) throw new Error("响应没有可读取的内容");

      const cl = parseInt(res.headers.get("content-length") || "", 10);
      task.total = Number.isFinite(cl) && cl > 0 ? cl : null;

      const reader = res.body.getReader();
      let lastTick = Date.now();
      let lastBytes = 0;
      let chunkStart = Date.now();
      for (;;) {
        if (task.cancelRequested) {
          throw new AbortError("canceled by user");
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          ws.write(Buffer.from(value));
          task.received += value.length;
          task._lastProgressAt = Date.now();
          if (task.stalledAt != null) {
            // 进度恢复自动解除停滞，允许再次停滞再通知
            task.stalledAt = null;
            task.stallNotified = false;
          }
          // 已知总大小且已收满：提前收尾，避免 undici 在连接关闭边界再次 read() 时报 terminated
          if (task.total != null && task.received >= task.total) break;
          // 限速：按 chunk 耗时反推应等待时间
          if (task.speedLimit > 0) {
            const want = (value.length / task.speedLimit) * 1000;
            const used = Date.now() - chunkStart;
            if (want > used) await sleep(want - used + CHUNK_SLEEP_MIN_MS);
          }
          chunkStart = Date.now();
          const now = Date.now();
          if (now - lastTick >= SPEED_SAMPLE_MS) {
            const inst = (task.received - lastBytes) / ((now - lastTick) / 1000);
            task._samples.push(inst);
            if (task._samples.length > SPEED_SAMPLES_MAX) task._samples.shift();
            task.speed = task._samples.reduce((a, b) => a + b, 0) / task._samples.length;
            lastTick = now;
            lastBytes = task.received;
          }
        }
      }

      await new Promise((resolve, reject) => {
        ws.end((err) => (err ? reject(err) : resolve()));
      });

      // 流正常结束即下载完整：总大小未知（chunked 无 Content-Length）或声明值与实际不符
      // （如 Content-Encoding 自动解压时 received 为解压后字节）时，以实际接收为准兜底，
      // 保证完成态进度条/大小/落盘数据自洽。注意：received < total 不拉低（undici 对 CL 不符
      // 会抛 terminated 走 catch；此处正常 done 说明服务器已发完，CL 虚高则保持原值警示）
      if (task.received > 0 && (task.total == null || task.received > task.total)) task.total = task.received;

      task.state = "done";
      task.finishedAt = Date.now();
    } catch (e) {
      const aborted = task.cancelRequested || e?.name === "AbortError";
      // 注意：chunked（total=null）半途断连时 complete 恒为 false，会走下方删除分支——
      // body 无长度声明无法验证完整性，failed + 删半成品是保守正确。勿放宽此判定为
      // (total==null || received>=total)：会把残缺文件误判为完成保下来，比删文件更糟。
      const complete = !aborted && task.total != null && task.received >= task.total && task.received > 0;
      if (complete) {
        try {
          await new Promise((res, rej) => ws.end((err) => (err ? rej(err) : res())));
        } catch { /* 落盘失败则按失败处理 */ }
        if (fs.existsSync(task.filePath)) {
          task.state = "done";
          task.error = null;
        } else {
          task.state = "failed";
          task.error = friendlyError(e);
        }
      } else {
        ws.destroy();
        try { if (fs.existsSync(task.filePath)) fs.unlinkSync(task.filePath); } catch { /* 忽略清理失败 */ }
        if (aborted) {
          task.state = "canceled";
          task.error = "已取消";
        } else {
          task.state = "failed";
          task.error = friendlyError(e);
        }
      }
      task.finishedAt = Date.now();
    } finally {
      this._stopStallMonitor(task);
      task.elapsed = (task.finishedAt || Date.now()) - (task.startedAt || Date.now());
      // 记录历史速度（按域名），供 wait auto 模式估算阈值
      if (task.total && task.total > 0 && task.elapsed > 0) {
        const host = hostOf(task.url);
        const avg = (task.received / task.elapsed) * 1000;
        if (host) this.recordSpeed(host, avg);
      }
      task.speed = 0;
      this._persist();
      this._fireFinal(task);
    }
  }

  // ── 命令型任务：git clone / pnpm install ──
  async _runCommand(task) {
    const { parseGitLine, createPnpmParser } = await import("./progress-parsers.js");
    const parser = task.cmd.type === "git-clone" ? parseGitLine : createPnpmParser();
    // Windows 下 npm 全局装的 pnpm 是 .cmd shim，裸 spawn(pnpm) shell:false 无法执行（EINVAL）；
    // 解析真实 JS 入口用 node 运行（数组传参，无 shell，无注入面）；git 是真实 exe 原样 spawn
    const resolved = resolveCommandBin(task.cmd);
    const cmdBin = resolved.bin;
    const fullArgs = resolved.args;

    this._startStallMonitor(task);
    task._cmdBuf = ""; // 输出缓冲（截断 4KB 供错误摘要）

    let child;
    try {
      child = spawn(cmdBin, fullArgs, {
        cwd: task.cmd.workdir || process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      this._stopStallMonitor(task);
      task.state = "failed";
      task.error = "命令无法启动：" + (err?.message || String(err));
      task.finishedAt = Date.now();
      task.elapsed = task.finishedAt - (task.startedAt || task.finishedAt);
      task.speed = 0;
      this._persist();
      this._fireFinal(task);
      return;
    }
    task.child = child;

    const feed = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
      task._lastProgressAt = Date.now(); // 喂停滞监视器
      task._cmdBuf = appendBuf(task._cmdBuf, text); // 缓冲截断
      const lines = text.split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.replace(/\r/g, "").trim();
        if (!line) continue;
        const r = parser(line);
        if (!r) continue;
        if (r.pct != null) {
          task.stage = r.stage;
          if (r.unit) task.unit = r.unit;
          if (r.received != null && r.total != null) {
            task.received = r.received;
            task.total = r.total;
          } else if (r.pct != null && task.total) {
            task.received = Math.round(task.total * r.pct / 100);
          }
        } else if (r.stage) {
          task.stage = r.stage;
        }
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);

    child.on("error", (e) => { task._spawnError = e; });

    child.on("close", (code) => {
      this._stopStallMonitor(task);
      const aborted = task.cancelRequested;
      if (aborted) {
        task.state = "canceled";
        task.error = "已取消";
        // git clone 半成品目录删；node_modules 半成品保留
        if (task.cmd.type === "git-clone" && task.filePath && fs.existsSync(task.filePath)) {
          try { fs.rmSync(task.filePath, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
        }
      } else if (code === 0) {
        task.state = "done";
        if (task.received > 0 && (task.total == null || task.received > task.total)) task.total = task.received;
      } else {
        task.state = "failed";
        const tail = task._cmdBuf ? task._cmdBuf.slice(-4000) : "";
        task.error = (task._spawnError ? task._spawnError.message + "；" : "") + `命令退出码 ${code}` + (tail ? `：${tail.split(/\n/).slice(-3).join("\n")}` : "");
      }
      task.finishedAt = Date.now();
      task.elapsed = task.finishedAt - (task.startedAt || task.finishedAt);
      task.speed = 0;
      this._persist();
      this._fireFinal(task);
    });
  }

  // ── 取消 ──
  cancel(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: "任务不存在" };
    if (t.state === "pending") {
      if (t.pendingTimer) clearTimeout(t.pendingTimer);
      t.state = "canceled";
      t.error = "已取消";
      t.finishedAt = Date.now();
      this._persist();
      this._fireFinal(t);
      return { ok: true };
    }
    if (t.state !== "running") return { ok: false, error: "任务已结束" };
    t.cancelRequested = true;
    if (t.kind === "command" && t.child && t.child.pid) {
      // Windows 杀进程树；非 Windows 信号
      if (process.platform === "win32") {
        try {
          spawnSync("taskkill", ["/pid", String(t.child.pid), "/T", "/F"], { windowsHide: true });
        } catch { try { t.child.kill(); } catch { /* 忽略 */ } }
      } else {
        try { process.kill(-t.child.pid, "SIGTERM"); } catch { try { t.child.kill(); } catch { /* 忽略 */ } }
      }
      return { ok: true };
    }
    t.controller?.abort();
    return { ok: true };
  }

  // ── 状态快照（供 route 返回给卡片）──
  snapshot(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return null;
    const percent = t.total ? Math.min(100, (t.received / t.total) * 100) : null;
    return {
      taskId: t.taskId,
      url: t.url,
      fileName: t.fileName,
      filePath: t.filePath,
      state: t.state,
      stalled: t.stalledAt != null,
      stalledAt: t.stalledAt,
      total: t.total,
      received: t.received,
      speed: Math.round(t.speed),
      percent: percent == null ? null : Math.round(percent * 10) / 10,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      elapsed: t.elapsed,
      error: t.error,
      kind: t.kind || "url",
      cmd: t.cmd || null,
      unit: t.unit || "bytes",
      stage: t.stage || null,
    };
  }

  // ── 重启恢复：running → interrupted、pending → interrupted（定时器丢失），删除半成品 ──
  restore() {
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(this.dataDir, TASKS_FILE), "utf-8"));
    } catch { return; }
    if (!meta || !Array.isArray(meta.tasks)) return;
    const now = Date.now();
    for (const m of meta.tasks) {
      const t = this.tasks.get(m.taskId);
      if (t) continue; // 内存中已有（create/prepare 后立即持久化过）
      if (m.state === "running" || m.state === "pending") {
        const isCmd = m.kind === "command" && m.cmd?.type;
        if (isCmd) {
          // 命令型：git-clone 中断删半成品目录；pnpm-install 保留 node_modules 半成品
          if (m.cmd.type === "git-clone" && m.filePath && fs.existsSync(m.filePath)) {
            try { fs.rmSync(m.filePath, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
          }
        } else {
          try { if (m.filePath && fs.existsSync(m.filePath)) fs.unlinkSync(m.filePath); } catch { }
        }
        this.tasks.set(m.taskId, {
          taskId: m.taskId, url: m.url || "", fileName: m.fileName || "",
          filePath: m.filePath || "", saveDir: m.saveDir || this.downloadDir,
          state: "interrupted", total: m.total || null, received: m.received || 0,
          speed: 0, startedAt: m.startedAt || now, finishedAt: now, elapsed: 0,
          error: isCmd ? "命令被中断（应用重启），请重新执行" : "下载被中断（应用重启），请重新发起下载",
          cancelRequested: false, speedLimit: m.speedLimit || 0,
          sessionId: null, sessionRef: null, controller: null, pendingTimer: null, _samples: [],
          stalledAt: m.stalledAt || null, stallNotified: false, _lastProgressAt: now,
          kind: m.kind || "url", cmd: m.cmd || null, unit: m.unit || "bytes", child: null, stage: null,
        });
      } else {
        // 已完成/失败/取消的旧任务：仅保留 1 天内，用于卡片回放
        const age = now - (m.finishedAt || m.startedAt || 0);
        if (age < 24 * 3600 * 1000) {
          // 历史 done 任务若 total 缺失（chunked 下载时代遗留数据）：用 received 兜底，回放卡片进度/大小正确
          const hisTotal = (m.state === "done" && m.total == null && m.received > 0) ? m.received : (m.total || null);
          this.tasks.set(m.taskId, {
            taskId: m.taskId, url: m.url || "", fileName: m.fileName || "",
            filePath: m.filePath || "", saveDir: m.saveDir || this.downloadDir,
            state: m.state || "interrupted", total: hisTotal, received: m.received || 0,
            speed: 0, startedAt: m.startedAt || now, finishedAt: m.finishedAt || now,
            elapsed: m.elapsed || 0, error: m.error || null, cancelRequested: false, speedLimit: m.speedLimit || 0,
            sessionId: null, sessionRef: null, controller: null, pendingTimer: null, _samples: [],
            stalledAt: m.stalledAt || null, stallNotified: false, _lastProgressAt: now,
            kind: m.kind || "url", cmd: m.cmd || null, unit: m.unit || "bytes", child: null, stage: null,
          });
        }
      }
    }
  }

  // ── 持久化（仅状态转换时调用，进度不落盘；终态任务只保留最近 100 条，防文件无限膨胀）──
  _persist() {
    try {
      const KEEP_FINAL = 100;
      const finalList = [];
      for (const t of this.tasks.values()) {
        if (t.state === "running" || t.state === "pending") continue;
        finalList.push(t);
      }
      // 终态按结束时间倒序，保留最近 KEEP_FINAL 条；超出部分从内存删除（防无限增长）
      finalList.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
      const overflow = finalList.slice(KEEP_FINAL);
      for (const t of overflow) this.tasks.delete(t.taskId);

      const meta = {
        version: 2,
        updatedAt: Date.now(),
        tasks: [...this.tasks.values()].map((t) => ({
          taskId: t.taskId, url: t.url, fileName: t.fileName, filePath: t.filePath,
          saveDir: t.saveDir, state: t.state, total: t.total, received: t.received,
          speedLimit: t.speedLimit || 0,
          startedAt: t.startedAt, finishedAt: t.finishedAt, elapsed: t.elapsed,
          error: t.error,
          kind: t.kind || "url",
          cmd: t.cmd || null,
          unit: t.unit || "bytes",
          stalledAt: t.stalledAt || null, // 停滞为运行时标记，仅存时间戳用于恢复展示；stallNotified/_lastProgressAt/_stallTimer/stallTimeoutMs 不持久化
        })),
      };
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(path.join(this.dataDir, TASKS_FILE), JSON.stringify(meta), "utf-8");
    } catch { /* 持久化失败不阻塞下载 */ }
  }
}

// ── 辅助函数 ──

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

// 命令输出缓冲：追加文本并截断到 4KB，供失败时错误摘要（最后几行）
function appendBuf(buf, text) {
  const next = buf + text;
  if (next.length <= 4096) return next;
  return next.slice(-4096);
}

// 命令可执行入口解析（Windows 兼容）：
// - git-clone：git 是真实 exe，直接 spawn，数组传参
// - pnpm-install：npm 全局装的 pnpm 是 .cmd shim，shell:false 的 spawn 执行不了（EINVAL）；
//   解析到真实 JS 入口（pnpm/bin/pnpm.mjs|cjs）用当前 node 运行，保持无 shell、无注入面
function resolveCommandBin(cmd) {
  const args = cmd.args || [];
  if (cmd.type === "git-clone") return { bin: "git", args: ["clone", ...args] };
  // pnpm-install（及未知类型退化到 pnpm）
  const entry = findPnpmEntry();
  if (entry) return { bin: process.execPath, args: [entry, "install", ...args] };
  return { bin: "pnpm", args: ["install", ...args] }; // 退化：PATH 上有 pnpm.exe 时可用
}

function findPnpmEntry() {
  // 1) where pnpm → .cmd shim → 读内容找 node_modules/pnpm/bin/pnpm.mjs|cjs
  try {
    const r = spawnSync("where.exe", ["pnpm"], { encoding: "utf-8", windowsHide: true });
    if (r.status === 0) {
      for (const line of String(r.stdout || "").split(/\r?\n/)) {
        const p = line.trim();
        if (!p || !/\.cmd$/i.test(p)) continue;
        const content = fs.readFileSync(p, "utf-8");
        const m = content.match(/node_modules[\\/]pnpm[\\/]bin[\\/]pnpm\.(?:mjs|cjs)/);
        if (m) {
          const entry = path.resolve(path.dirname(p), m[0].replace(/\//g, path.sep));
          if (fs.existsSync(entry)) return entry;
        }
      }
    }
  } catch { /* 继续探测 */ }
  // 2) npm root -g 直拼标准结构
  try {
    const r = spawnSync("npm", ["root", "-g"], { encoding: "utf-8", windowsHide: true });
    if (r.status === 0) {
      const root = String(r.stdout || "").trim();
      for (const f of ["pnpm/bin/pnpm.mjs", "pnpm/bin/pnpm.cjs"]) {
        const entry = path.join(root, f);
        if (fs.existsSync(entry)) return entry;
      }
    }
  } catch { /* 返回 null 走退化 */ }
  return null;
}

function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const name = decodeURIComponent(u.pathname.split("/").pop() || "");
    if (name) return name;
  } catch { /* fallthrough */ }
  return "download_" + Date.now();
}

function sanitizeFileName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "download_" + Date.now();
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  const dir = path.dirname(p);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

function friendlyError(e) {
  const msg = e?.message || String(e || "");
  const low = msg.toLowerCase();
  if (low.includes("terminated")) return "连接被中断（terminated）";
  if (low.includes("fetch failed")) return "网络请求失败";
  if (low.includes("aborted")) return "请求被中止";
  if (low.includes("content-length") || low.includes("length")) return "响应异常（长度不符）";
  return msg;
}

class AbortError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "AbortError";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
