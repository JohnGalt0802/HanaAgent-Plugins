// extensions/dl-nextturn.js — v0.11.0 占位扩展（v1 pi 扩展空壳）
//
// v0.11.0 v1 投递权威在 lib/delivery.js（订阅 mgr.onFinal/onStall + 维护 pending 队列），
// 同步注入在 extensions/dl-sync.js（pi.on("before_provider_request") + delivery.injectForSession）。
// 本扩展保留作为 v1 pi 扩展占位（v1 加载器要求 export default function），不参与投递。

export default function (pi) {
  // 占位：v0.11.0 v1 投递链路由 lib/delivery.js + extensions/dl-sync.js 接管。
}