// tools/download-command.js — 命令型下载工具
// 把 git clone / pnpm install 这类"体感上是下载行为"的命令，包进下载进度条插件：
// 立即返回进度卡片（details.card），后台 spawn 命令，解析 stdout/stderr 输出实时刷新进度。
// 参数语义化、命令白名单（git-clone / pnpm-install），禁止任意命令执行、不做 shell 拼接。

import path from "node:path";
import fs from "node:fs";
import { getTaskManager } from "../lib/dlcore.js";
import { registerDeferred } from "../lib/deferred.js";

export const name = "download-command";
export const description =
  "执行下载型命令（git clone / pnpm install）并在聊天流显示实时进度卡片。" +
  "git clone 用于克隆仓库，pnpm install 用于安装依赖。需要克隆仓库或安装依赖时优先用本工具。";

export const sessionPermission = { kind: "external_side_effect" };

export const parameters = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["git-clone", "pnpm-install"], description: "命令类型" },
    repo: { type: "string", description: "git-clone 专用：仓库地址（http/https/git@/本地路径）" },
    targetDir: { type: "string", description: "git-clone 专用：目标目录绝对路径（可选，默认取仓库名）" },
    workdir: { type: "string", description: "执行工作目录（install 必填；git-clone 可选，默认当前目录）" },
    label: { type: "string", description: "卡片显示名（可选）" },
  },
  required: ["kind"],
};

export async function execute(input, toolCtx) {
  const kind = String(input?.kind || "").trim();
  const workdir = (input?.workdir && String(input.workdir).trim()) || process.cwd();
  const resolveWd = path.resolve(workdir);

  const manager = getTaskManager(toolCtx.dataDir);
  const stallTimeoutMs = toolCtx.config?.get?.("stallTimeoutMs") ?? 30000;

  // ── 参数组装 + 白名单校验（不做 shell 拼接，spawn 数组传参）──
  let cmd;
  let fileName;
  let filePath;
  let unit;

  if (kind === "git-clone") {
    const repo = String(input?.repo || "").trim();
    if (!repo) throw new Error("git-clone 需要仓库地址（repo）");
    if (!fs.existsSync(resolveWd)) throw new Error(`工作目录不存在：${resolveWd}`);

    const repoName = repoNameOf(repo);
    const targetDir = (input?.targetDir && String(input.targetDir).trim())
      ? path.resolve(String(input.targetDir).trim())
      : path.join(resolveWd, repoName);

    if (fs.existsSync(targetDir)) {
      throw new Error(`目标目录已存在，为避免覆盖：${targetDir}`);
    }

    filePath = targetDir;
    fileName = (input?.label && String(input.label).trim()) || repoName;
    unit = "objects";
    cmd = { type: "git-clone", args: [repo, targetDir], workdir: resolveWd, targetDir };
  } else if (kind === "pnpm-install") {
    if (!fs.existsSync(resolveWd)) throw new Error(`工作目录不存在：${resolveWd}`);
    filePath = resolveWd;
    fileName = (input?.label && String(input.label).trim()) || path.basename(resolveWd) + "（依赖安装）";
    unit = "packages";
    cmd = { type: "pnpm-install", args: [], workdir: resolveWd };
  } else {
    throw new Error(`不支持的命令类型：${kind}（仅支持 git-clone / pnpm-install）`);
  }

  // ── 准备态（pending）：卡片先渲染，延迟后自动启动 ──
  const task = manager.prepare({
    kind: "command",
    cmd,
    unit,
    fileName,
    filePath,
    saveDir: path.dirname(filePath),
    startDelayMs: Number(input?.startDelayMs) || 0,
    sessionId: toolCtx.sessionId,
    sessionRef: toolCtx.sessionRef,
    stallTimeoutMs,
    sessionPath: toolCtx.sessionPath,
  });

  const snap = manager.snapshot(task.taskId);

  // 创建即注册 deferred 占位：命令完成后自动唤醒发起会话
  // await 注册完成再返回：消除「工具返回时占位还没建立」的竞态窗口
  await registerDeferred(toolCtx.bus, task, { kind: "command", cmdType: cmd.type });

  const action = kind === "git-clone" ? `克隆 ${cmd.args[0]}` : `安装 ${path.basename(resolveWd)} 依赖`;

  return {
    content: [{ type: "text", text: `已开始${kind === "git-clone" ? "克隆" : "安装"}（任务ID：${snap.taskId}，后台执行命令，卡片实时显示进度）。` }],
    details: {
      card: {
        route: `/card/download?taskId=${snap.taskId}`,
        title: action,
        description: snap.fileName,
        aspectRatio: "8:1", // 初始高度 ≈ 50px，配合 ui.resize 自适应
      },
    },
  };
}

// 从仓库地址提取仓库名（去掉 .git 后缀）
function repoNameOf(repo) {
  const cleaned = repo.replace(/\.git(?:\/)?$/, "");
  const seg = cleaned.split(/[/\\]+/).filter(Boolean).pop() || "repo";
  return sanitizeName(seg);
}

function sanitizeName(name) {
  return String(name).replace(/[\\/:*?"<>|\r\n\t]/g, "_").replace(/^\.+/, "").trim() || "repo";
}
