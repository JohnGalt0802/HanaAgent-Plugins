// tools/download-file.js — 下载工具
// 以"准备态"启动下载：工具立即返回进度卡片（details.card，渲染在工具块正下方），
// 任务短暂延迟后自动开始，保证卡片从"准备中"→ 0% → 100% 全程可见。

import path from "node:path";
import fs from "node:fs";
import { getTaskManager } from "../lib/dlcore.js";
import { registerDeferred } from "../lib/deferred.js";

export const name = "download-file";
export const description =
  "从 URL 下载文件到本地。下载过程会在聊天流中显示实时进度卡片（进度条、文件总大小、下载速度、已完成量），" +
  "卡片渲染在工具块正下方，从准备中开始实时跟进。需要下载文件时请优先使用本工具，而不是 exec_command 里的 curl / Invoke-WebRequest。";

export const sessionPermission = { kind: "external_side_effect" };

export const parameters = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "文件下载地址（http/https）",
    },
    saveDir: {
      type: "string",
      description: "可选：保存目录的绝对路径（如 C:\\Users\\Leo\\Downloads）。留空则保存到插件默认目录（可在插件设置中配置）。",
    },
    fileName: {
      type: "string",
      description: "可选：自定义保存文件名（含扩展名）。留空则从 URL 自动推断。",
    },
    speedLimit: {
      type: "number",
      description: "可选：限速下载（字节/秒），如 1048576 = 1MB/s。大文件限速可避免占满带宽，也便于观察下载进度。",
    },
    startDelayMs: {
      type: "number",
      description: "可选：延迟启动毫秒数（默认 0，立即开始下载；卡片渲染晚于下载也无妨，完成后照常显示 100%）。",
    },
  },
  required: ["url"],
};

export async function execute(input, toolCtx) {
  const url = String(input?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("url 必须是 http/https 地址");
  }

  const manager = getTaskManager(toolCtx.dataDir);

  // 停滞判定阈值：配置可调，默认 30s 无新数据判定停滞
  const stallTimeoutMs = toolCtx.config?.get?.("stallTimeoutMs") ?? 30000;

  let saveDir = "";
  if (input?.saveDir && String(input.saveDir).trim()) {
    // Agent 显式指定目录：优先（Agent 自选模式的核心路径）
    saveDir = path.resolve(String(input.saveDir).trim());
  } else {
    // 读取插件设置 config.json：defaultSaveDir（默认目录）/ agentChooses（Agent 自选）
    let cfg = null;
    try {
      const cfgPath = path.join(toolCtx.dataDir, "config.json");
      if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    } catch { cfg = null; }
    const defaultDir = cfg?.defaultSaveDir && String(cfg.defaultSaveDir).trim() ? String(cfg.defaultSaveDir).trim() : "";
    const agentChooses = cfg?.agentChooses === true;
    if (defaultDir && !agentChooses) {
      // 已设默认目录且非 Agent 自选：统一落默认目录
      saveDir = path.resolve(defaultDir);
    } else if (!defaultDir || agentChooses) {
      // 无默认目录或 Agent 自选：回退插件配置系统 defaultSaveDir（兼容旧配置），再回退插件数据目录
      try { saveDir = String(toolCtx.config?.get?.("defaultSaveDir") || "").trim(); } catch { saveDir = ""; }
    }
  }

  // 准备态：卡片先渲染，延迟后自动从 0% 开始
  const task = manager.prepare({
    url,
    fileName: input?.fileName,
    saveDir: saveDir || undefined,
    speedLimit: input?.speedLimit,
    startDelayMs: Number(input?.startDelayMs) || 0,
    sessionId: toolCtx.sessionId,
    sessionRef: toolCtx.sessionRef,
    stallTimeoutMs,
    sessionPath: toolCtx.sessionPath,
  });

  const snap = manager.snapshot(task.taskId);

  // 创建即注册 deferred 占位：下载完成后自动唤醒发起会话（不依赖 Agent 后续调 wait）
  // await 注册完成再返回：消除「工具返回时占位还没建立」的竞态窗口
  await registerDeferred(toolCtx.bus, task, { url });

  return {
    content: [{ type: "text", text: `已开始下载 ${snap.fileName}（任务ID：${snap.taskId}）。后台流式下载，卡片实时显示进度；无需立即回查——需要等待结果时再调用 download-wait 并传入此任务 ID。` }],
    details: {
      card: {
        type: "webview", // PLUGINS.md L349 新协议必需；缺则卡片回退到 WebView ... Chalkboard 占位壳
        route: `/card/download?taskId=${snap.taskId}`,
        title: `下载 ${snap.fileName}`,
        description: `正在准备下载 ${snap.fileName}`,
      },
    },
  };
}
