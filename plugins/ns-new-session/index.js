/**
 * NS Plugin — /ns 快捷命令
 * 新建桌面级会话，弥补移动端 /new 不能创建桌面会话的问题。
 */

const nsTool = {
  name: "ns",
  description:
    "新建桌面级 Hana 会话。用户在任意对话中输入 /ns 即可触发，创建一个全新的空白桌面会话。用于弥补 /new 只能创建移动端级别会话的不足。",
  parameters: {
    type: "object",
    properties: {
      label: {
        type: "string",
        description: "新会话的显示标签（可选），如「新任务」「临时会话」"
      }
    },
    required: []
  },
  async execute(input = {}, ctx = {}) {
    const label = input.label?.trim() || `会话 ${new Date().toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;

    try {
      const session = await ctx.createSession({
        label
      });

      return {
        content: [{
          type: "text",
          text: `✅ 桌面级会话已创建「${label}」\n会话 ID: ${session?.id || session?.sessionId || "已创建"}`
        }]
      };
    } catch (err) {
      // 降级：尝试通过 EventBus 创建
      try {
        const result = await ctx.bus.request("session:create", { label });
        return {
          content: [{
            type: "text",
            text: `✅ 桌面级会话已创建「${label}」\n会话 ID: ${result?.id || result?.sessionId || "已创建"}`
          }]
        };
      } catch (err2) {
        return {
          content: [{
            type: "text",
            text: `❌ 创建会话失败: ${err2?.message || err?.message || "未知错误"}`
          }]
        };
      }
    }
  }
};

export default class NsPlugin {
  constructor(ctx) {
    this.ctx = ctx;
    this.toolDisposer = null;
  }

  async onload() {
    this.syncTool();
    this.register(
      this.ctx.bus.subscribe((event) => {
        if (event?.type !== "plugin_config_changed") return;
        if (event.pluginId !== this.ctx.pluginId) return;
        this.syncTool();
      })
    );
    this.ctx.log?.info?.("ns-new-session loaded: /ns command ready");
  }

  onunload() {
    this.disposeTool();
  }

  syncTool() {
    this.disposeTool();
    if (this.ctx.config.get("enableNsTool") === false) return;

    if (typeof this.ctx.registerTool !== "function") {
      this.ctx.log?.warn?.("ns-new-session: registerTool unavailable");
      return;
    }

    this.toolDisposer = this.ctx.registerTool({
      name: "ns",
      description: nsTool.description,
      parameters: nsTool.parameters,
      execute: (input = {}, runtimeCtx = {}) =>
        nsTool.execute(input, { ...this.ctx, ...(runtimeCtx || {}) })
    });
    this.register(this.toolDisposer);
  }

  disposeTool() {
    if (this.toolDisposer) {
      try { this.toolDisposer(); } catch (e) { /* quiet */ }
      this.toolDisposer = null;
    }
  }
}
