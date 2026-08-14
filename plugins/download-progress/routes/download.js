// routes/download.js — 下载进度卡片相关路由
//   GET  /card/download?taskId=xxx   进度卡片页面（iframe）
//   GET  /download/status?taskId=xxx 进度 JSON（卡片轮询）
//   POST /download/cancel?taskId=xxx 取消下载

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTaskManager } from "../lib/dlcore.js";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");

// 每次请求时读取卡片资源，改样式/脚本即时生效（不缓存）
function readCardAssets() {
  return {
    css: fs.readFileSync(path.join(APP, "card.css"), "utf-8"),
    js: fs.readFileSync(path.join(APP, "card.js"), "utf-8"),
  };
}

export default function registerDownloadRoutes(app, ctx) {
  const base = "/api/plugins/" + ctx.pluginId;

  // 启动下载（HTTP 入口，供 Agent/外部直接调用，返回任务快照）
  app.post("/download/start", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const url = String(body?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return c.json({ ok: false, error: "url 必须是 http/https 地址" }, 400);
      const manager = getTaskManager(ctx.dataDir);
      const task = manager.create({
        url,
        fileName: body?.fileName ? String(body.fileName) : undefined,
        saveDir: body?.saveDir ? String(body.saveDir) : undefined,
        speedLimit: Number(body?.speedLimit) || 0,
        sessionId: null,
        sessionRef: null,
      });
      return c.json({ ok: true, task: manager.snapshot(task.taskId) });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  // 准备下载（pending）：生成任务占位并延迟自动启动，供卡片先渲染、进度从 0% 开始
  app.post("/download/prepare", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const url = String(body?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return c.json({ ok: false, error: "url 必须是 http/https 地址" }, 400);
      const manager = getTaskManager(ctx.dataDir);
      const task = manager.prepare({
        url,
        fileName: body?.fileName ? String(body.fileName) : undefined,
        saveDir: body?.saveDir ? String(body.saveDir) : undefined,
        speedLimit: Number(body?.speedLimit) || 0,
        startDelayMs: Number(body?.startDelayMs) || 0,
        sessionId: null,
        sessionRef: null,
      });
      return c.json({ ok: true, task: manager.snapshot(task.taskId) });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  app.get("/download/status", (c) => {
    try {
      const taskId = String(c.req.query("taskId") || "");
      if (!taskId) return c.json({ ok: false, error: "缺少 taskId" }, 400);
      const manager = getTaskManager(ctx.dataDir);
      const snap = manager.snapshot(taskId);
      if (!snap) return c.json({ ok: false, error: "任务不存在" }, 404);
      return c.json({ ok: true, task: snap });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  app.post("/download/cancel", (c) => {
    try {
      const taskId = String(c.req.query("taskId") || "");
      if (!taskId) return c.json({ ok: false, error: "缺少 taskId" }, 400);
      const manager = getTaskManager(ctx.dataDir);
      const r = manager.cancel(taskId);
      return c.json(r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 409);
    } catch (e) {
      return c.json({ ok: false, error: e?.message || String(e) }, 500);
    }
  });

  app.get("/card/download", (c) => {
    const assets = readCardAssets();
    const hc = c.req.query("hana-css") || "";
    const th = c.req.query("hana-theme") || "inherit";
    const taskId = String(c.req.query("taskId") || "");
    const hcLink = hc ? `<link rel="stylesheet" href="${esc(hc)}">` : "";
    return c.html(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>下载进度</title>
${hcLink}
<style>${assets.css}<\/style>
</head>
<body data-hana-theme="${esc(th)}">
<div id="dl-root" data-task="${esc(taskId)}"></div>
<script>window.__API="${base}";<\/script>
<script>${assets.js}<\/script>
</body>
</html>`);
  });
}

function esc(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
