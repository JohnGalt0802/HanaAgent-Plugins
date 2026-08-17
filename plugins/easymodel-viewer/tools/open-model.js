// Agent 工具：在 EasyModel 页面中打开模型文件
export const name = "open_model";
export const description =
  "在 EasyModel 模型查看器中打开一个 3D 模型文件（STL/OBJ/PLY/GLB/GLTF/3MF/STEP/IGES），在 Hana 内新页面渲染显示。用户给出模型文件（本地路径或拖入对话的文件）时调用。";
export const parameters = {
  type: "object",
  properties: {
    file: {
      type: "string",
      description: "模型文件的本地绝对路径，如 C:\\models\\part.stl",
    },
  },
  required: ["file"],
};

export async function execute(input, toolCtx) {
  const p = input && input.file;
  if (!p || typeof p !== "string") {
    return { content: [{ type: "text", text: "缺少模型文件路径（file 参数）" }] };
  }
  try {
    const fs = require("node:fs");
    if (!fs.existsSync(p)) {
      return { content: [{ type: "text", text: "文件不存在: " + p }] };
    }
  } catch { /* 非本地场景忽略 */ }

  const encoded = encodeURIComponent(p);
  const url = "/api/plugins/easymodel-viewer/viewer?file=" + encoded;
  const fname = p.split(/[\\\\/]/).pop();
  return {
    content: [{
      type: "text",
      text: `模型 ${fname} 已就绪：**[在 EasyModel 中打开](${url})**（点击在新页面渲染）。\n也可以在 Hana 的「EasyModel 模型查看」页面点「打开文件」选择模型。`,
    }],
    details: { filePath: p, openUrl: url, format: (p.split(".").pop() || "").toLowerCase() },
  };
}
