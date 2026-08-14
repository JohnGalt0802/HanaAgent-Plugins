// extensions/enforce-download.js — 插件级下载约束注入（预留）
// 机制：宿主在 LLM 请求前触发 before_provider_request 事件（可改写请求）。
// 本扩展在每次请求前把"下载必须走 download-file"约束注入 system 消息，对所有 Agent/会话生效，
// 不依赖任何全局规则文件。
//
// ⚠ 现状（2026-08-11 实测）：0.446.6 宿主未把 before_provider_request 桥接给插件扩展
// （bundle 中该事件仅有宿主自身订阅，插件扩展收不到）。代码保留，宿主升级支持后自动生效。
// 在此之前，下载约束依赖：① download-file 工具描述引导（模型天然优先用工具）② 环境全局规则。

export default function (pi) {
  pi.on("before_provider_request", (event) => {
    const payload = event?.payload;
    if (!payload || !Array.isArray(payload.messages)) return payload;

    const RULE =
      "【下载铁律】需要下载 http/https 文件时，必须使用 download-progress_download-file 工具" +
      "（下载中可调用 download-progress_download-wait 回查进度并按进度决策），" +
      "禁止使用 exec_command 里的 curl / Invoke-WebRequest 裸下载。";
    const MARK = "【下载铁律】";

    try {
      const messages = payload.messages.map((m) => {
        if (m?.role === "system" && !String(m.content || "").includes(MARK)) {
          return { ...m, content: String(m.content || "") + "\n" + RULE };
        }
        return m;
      });
      if (!messages.some((m) => m?.role === "system")) {
        messages.unshift({ role: "system", content: RULE });
      }
      return { ...payload, messages };
    } catch {
      return payload; // 注入失败不阻塞请求
    }
  });
}
