// tools/download-file.js — 下载工具
// 以"准备态"启动下载：工具立即返回进度卡片（details.card，渲染在工具块正下方），
// 任务短暂延迟后自动开始，保证卡片从"准备中"→ 0% → 100% 全程可见。

import path from "node:path";
import { getTaskManager } from "../lib/dlcore.js";

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
    saveDir = path.resolve(String(input.saveDir).trim());
  } else {
    try { saveDir = String(toolCtx.config?.get?.("defaultSaveDir") || "").trim(); } catch { saveDir = ""; }
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

  return {
    content: [{ type: "text", text: `已开始下载 ${snap.fileName}（后台流式下载，卡片实时显示进度）。` }],
    details: {
      card: {
        route: `/card/download?taskId=${snap.taskId}`,
        title: `下载 ${snap.fileName}`,
        description: `正在准备下载 ${snap.fileName}`,
        aspectRatio: "8:1", // 初始高度 ≈ 50px，配合 ui.resize 自适应
      },
    },
  };
}
