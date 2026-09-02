// index.js — hana-downloader v0.11.0 v1 插件生命周期
//
// 投递架构（v0.11.0 重做）：
//   - lib/delivery.js 是唯一投递权威：订阅 mgr.onFinal/onStall，
//     未收束 → pending 队列等待 before_provider_request 注入；
//     已收束 → deferred:resolve 异步唤醒。
//   - extensions/dl-nextturn.js 只负责把当前会话 pending 的下载结果
//     拼进下一条 LLM API 请求（before_provider_request）。
//
// 本文件保留 v1 插件入口：onload 构建 TaskManager、注册 abort handler、
// 初始化 delivery，并把 bus/manager 挂到 globalThis 供工具与扩展使用。
import { getTaskManager } from "./lib/dlcore.js";
import { registerHandler } from "./lib/registry.js";
import { createDelivery } from "./lib/delivery.js";
import fs from "node:fs";
import path from "node:path";

export default class DownloadProgressPlugin {
  onload() {
    const { dataDir, bus, log } = this.ctx;
    // 诊断日志：写在插件数据目录下（不硬编码本机路径），确认 onload 执行 + __sessionHooks 状态
    const dbgLog = (s) => { try { fs.appendFileSync(path.join(dataDir, 'stall-debug.log'), `[${new Date().toISOString()}] ${s}\n`); } catch {} };
    dbgLog(`DBG onload entered | sessionHooks=${typeof globalThis.__sessionHooks} | bus=${typeof bus}`);
    try {
      const manager = getTaskManager(dataDir);
      manager.restore();
      this.ctx._dl = manager;
      globalThis.__dlManager = manager;
      globalThis.__dlBus = bus;

      // 宿主 TaskRegistry：注册 type="download" 的 abort handler，让 stop_task 能取消下载。
      // fire-and-forget：宿主 lifecycle onload 不等 async，先让 onload sync 返回，
      // registerHandler 在后台异步执行（v1 bus allowlist 可能拒绝 task:* → try/catch 静默降级）。
      registerHandler(bus, () => getTaskManager(dataDir)).catch(() => {});

      // 投递层唯一权威（订阅 onFinal/onStall，维护 pending 队列）。
      // 同步创建（不被 1ms 截断）：createDelivery 是 sync 返回，确保 globalThis.__dlDelivery
      // 在 onload 返回前已设置，dl-sync.js 的 before_provider_request 回调才能调 injectForSession。
      // onload 幂等：dev 槽重载/重复加载时先退订旧 delivery 的 onStall 订阅，
      // 否则旧回调残留在 manager._stallCbs 单例数组上 → stall 事件双投。
      if (globalThis.__dlDelivery && typeof globalThis.__dlDelivery.dispose === "function") {
        try { globalThis.__dlDelivery.dispose(); } catch {}
      }
      globalThis.__dlDelivery = createDelivery({ bus, manager, dataDir, log });

      // 注册 session-hooks adjudication：agent/pre-step 真同步注入。
      // 实测（2026-09-02）：provider/before-request 在当前 host 从不触发（Pi 引擎不 emit before_provider_request），
      // 但 agent/pre-step、tools/pre-execute 等 event 都由 decide 正常触发。agent/pre-step 的 invocation 带 messages，
      // 正好是注入下载结果的理想位置（host 内置 lkr/dkr/skr 也用它处理 messages）。用 order=999 在 host 内置 hooks 之后注入。
      try {
        const hooks = globalThis.__sessionHooks;
        dbgLog(`DBG sessionHooks type=${typeof hooks} onDecision=${typeof hooks?.onDecision}`);
        if (hooks && typeof hooks.onDecision === "function") {
          if (globalThis.__dlHooksDispose) {
            try { globalThis.__dlHooksDispose(); } catch {}
          }
          globalThis.__dlHooksDispose = hooks.onDecision(
            "agent/pre-step",
            async ({ session, messages }) => {
              dbgLog(`DBG agent/pre-step adjudicator called | sessionFile=${session?.sessionFile} msgs=${Array.isArray(messages) ? messages.length : 'N/A'} delivery=${typeof globalThis.__dlDelivery}`);
              if (!Array.isArray(messages)) return;
              const delivery = globalThis.__dlDelivery;
              if (!delivery || typeof delivery.injectForSession !== "function") return;
              const sp = session?.sessionFile;
              const before = messages.length;
              const ret = delivery.injectForSession(sp, { messages });
              if (ret.messages.length === before) return;
              dbgLog(`DBG agent/pre-step injected (session=${sp}) msgs ${before}->${ret.messages.length}`);
              return { messages: ret.messages };
            },
            { owner: "hana-downloader", order: 999 }
          );
          dbgLog("DBG registered agent/pre-step injection adjudicator (owner=hana-downloader, order=999)");
        } else {
          dbgLog(`DBG sessionHooks unavailable, fallback async`);
        }
      } catch (e) {
        log.warn?.("[dl-sync] onDecision register ERR: " + (e?.message || e));
      }

      log.info(`hana-downloader v0.11.0 loaded (delivery: onDecision + deferred)`);
    } catch (e) {
      log.warn?.("hana-downloader restore failed: " + (e?.message || e));
    }
  }
}

