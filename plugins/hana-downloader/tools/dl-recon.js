#!/usr/bin/env node
// dl-recon.js — 下载占位补注册的外部侦察脚本（B' 方案最小验证）
// 职责：watch 会话 jsonl 检测"回合收束"，收束瞬间找出"该补注册占位"的下载任务，写标记文件给插件。
// 只读 jsonl/tasks.json，只写标记目录 _tmp/dl-recon/。不碰宿主、不碰任务、不碰任务文件。

import fs from "node:fs";
import path from "node:path";

const TASKS = "C:/Users/John Galt/.hanako/plugin-data/download-progress/tasks.json";
const MARK_DIR = "D:/HanakoWorks/_temp/dl-recon";

function loadTasks() {
  try {
    const d = JSON.parse(fs.readFileSync(TASKS, "utf8"));
    const ts = Array.isArray(d) ? d : d.tasks || Object.values(d);
    return Array.isArray(ts) ? ts : Object.values(ts);
  } catch {
    return [];
  }
}

// 判断任务是否"该补注册"：未完成 + 占位未注册 + 有 sessionPath 可唤醒
function needsRegister(t) {
  if (!t) return false;
  if (!(t.state === "running" || t.state === "pending")) return false; // 未完成
  if (t.deferredRegistered === true) return false; // 已注册过，不重复
  if (!t.sessionPath) return false; // 无会话上下文无法唤醒
  return true;
}

// 读一个 jsonl 的尾部，检测是否"回合收束"（最后一条是 assistant stop，且之后静默）
// 返回 { isSettled, lastKind, lastTime }
function readSettle(sessionPath) {
  try {
    if (!sessionPath || !fs.existsSync(sessionPath)) return { isSettled: false, reason: "no-file" };
    const stat = fs.statSync(sessionPath);
    const size = stat.size;
    if (size === 0) return { isSettled: false, reason: "empty" };
    // 读尾部最后 ~2KB 找最后一条记录
    const fd = fs.openSync(sessionPath, "r");
    const buf = Buffer.alloc(Math.min(size, 4096));
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    fs.closeSync(fd);
    const tail = buf.toString("utf8");
    // 最后一条 JSON line（从尾部往前找换行）
    const lines = tail.split("\n").filter((l) => l.trim().length > 0);
    const last = lines[lines.length - 1];
    if (!last) return { isSettled: false, reason: "no-line" };
    let o;
    try { o = JSON.parse(last); } catch { return { isSettled: false, reason: "parse" }; }
    // 判定收束：最后一条是 assistant 且 stopReason=stop
    const isStop = o.type === "message" && o.message?.role === "assistant" && o.message?.stopReason === "stop";
    return {
      isSettled: isStop,
      lastKind: isStop ? "assistant-stop" : (o.type + ":" + (o.message?.role || o.customType || "")),
      lastTime: o.timestamp || null,
    };
  } catch {
    return { isSettled: false, reason: "err" };
  }
}

function main() {
  fs.mkdirSync(MARK_DIR, { recursive: true });
  const tasks = loadTasks();
  const due = tasks.filter(needsRegister);
  let wrote = 0;
  for (const t of due) {
    const settle = readSettle(t.sessionPath);
    // 收束特征：该 session jsonl 尾部已 assistant-stop（回合结束、agent 不再处理）
    if (settle.isSettled) {
      const mk = path.join(MARK_DIR, `${t.taskId}.json`);
      const payload = {
        taskId: t.taskId,
        sessionPath: t.sessionPath,
        fileName: t.fileName,
        state: t.state,
        deliveredAt: new Date().toISOString(),
      };
      fs.writeFileSync(mk, JSON.stringify(payload, null, 2));
      wrote++;
      console.log(`[recon] MARK ${t.taskId} state=${t.state} settled=${settle.lastKind}`);
    } else {
      console.log(`[recon] skip ${t.taskId} state=${t.state} settled=${settle.isSettled} (${settle.reason || settle.lastKind})`);
    }
  }
  console.log(`[recon] done: ${due.length} due, ${wrote} marked`);
}

main();
