// Agent 工具：在 EasyModel 卡片中打开模型文件
// v2.0：结构化返回值（details 含 filePath/fileName/fileSize/format/openUrl/cardAction），
//      错误用 isError 标记，描述里加 fit/mode 参数说明与触发指引。
import fs from "node:fs";
export const name = "open_model";
export const description =
  "在 EasyModel 模型查看器卡片中打开一个 3D 模型文件（STL/OBJ/PLY/GLB/GLTF/3MF/STEP/IGES），" +
  "作为卡片在工作台渲染显示。用户给出模型文件（本地绝对路径或拖入对话的文件）时优先调用。";
export const parameters = {
  type: "object",
  properties: {
    file: {
      type: "string",
      description: "模型文件的本地绝对路径，如 C:\\models\\part.stl",
    },
    fit: {
      type: "boolean",
      description: "打开后自动 fit 视角到模型包围盒（默认 true）",
      default: true,
    },
    mode: {
      type: "string",
      enum: ["replace", "append"],
      description: "replace 替换查看器当前内容；append 追加到当前工作集（默认 replace）",
      default: "replace",
    },
  },
  required: ["file"],
};

export async function execute(input, toolCtx) {
  const p = input && input.file;
  const fit = input && typeof input.fit === "boolean" ? input.fit : true;
  const mode = input && input.mode === "append" ? "append" : "replace";
  if (!p || typeof p !== "string") {
    return {
      content: [{ type: "text", text: "缺少模型文件路径（file 参数）" }],
      isError: true,
    };
  }
  let stat = null;
  try {
    if (!fs.existsSync(p)) {
      return {
        content: [{ type: "text", text: "文件不存在: " + p }],
        isError: true,
      };
    }
    stat = fs.statSync(p);
  } catch { /* 非本地场景忽略：保留调用权给宿主后续处理 */ }

  const params = new URLSearchParams({ file: p, fit: String(fit), mode });
  const url = "/api/plugins/easymodel-viewer/viewer?" + params.toString();
  const fname = p.split(/[\\/]/).pop();
  const ext = (p.split(".").pop() || "").toLowerCase();
  const sizeKB = stat ? Math.max(0.1, stat.size / 1024) : 0;
  return {
    content: [{
      type: "text",
      text: `已就绪 ${fname}（${sizeKB ? sizeKB.toFixed(1) + " KB" : "未知大小"} · ${ext}）。` +
            `点击链接在工作台 EasyModel 卡片中打开：[${fname}](${url})`,
    }],
    details: {
      filePath: p,
      fileName: fname,
      fileSize: stat ? stat.size : null,
      format: ext,
      openUrl: url,
      cardAction: "open",
      fit,
      mode,
    },
  };
}
