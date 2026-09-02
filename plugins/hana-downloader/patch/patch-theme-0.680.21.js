// patch-theme-0.680.21.js
// 一键重打：Hana 0.680.21 宿主 theme.js 主题跟随 patch
// 作用：applyConcreteTheme(minified N(e)) 设完 data-theme + themeSheet.href 后：
//   1) 广播 CustomEvent("hana-theme-applied", {detail:theme}) —— 供宿主窗口内监听
//   2) 遍历 window.frames postMessage({type:"hana.theme.changed", theme}) —— 通知插件 iframe 切主题
// 插件侧（manager.js / card.js）监听 window message 的 hana.theme.changed → 更新 body data-hana-theme + t-dark 切换。
//
// 为什么：0.680.21 宿主 applyConcreteTheme 只改宿主自己 html data-theme + themeSheet.href，**不通知插件 iframe**、
// 也不重注 iframe 的 CSS 变量（--bg-card/--accent 等）。插件必须自包含两套色板（浅/深）+ t-dark 判定 +
// 本事件监听才能跟随主题切换。THEME_CHANGED 常量已注册但宿主无调用方，故由本 patch 自建广播链路。
//
// 用法：node patch-theme-0.680.21.js <theme.js 路径>
//   默认两条 renderer：artifacts/renderer/0.680.21 + artifacts/server/0.680.21-win32-x64/desktop/dist-renderer
// 说明：Hana 升级会覆盖 renderer 文件，升级后需用本脚本重打。备份：打前自动生成 .bak-patch。

const fs = require("fs");
const OLD = 'window.hana?.syncWindowTheme?.(e))}';
const TAIL = 'window.dispatchEvent(new CustomEvent("hana-theme-applied",{detail:e})),(()=>{try{for(var k in window.frames){try{window.frames[k].postMessage({type:"hana.theme.changed",theme:e},"*")}catch(_){}}}catch(_){}})(),}';

function patchTheme(p) {
  if (!fs.existsSync(p)) { console.error("文件不存在: " + p); return false; }
  let s = fs.readFileSync(p, "utf8");
  if (s.includes("hana.theme.changed") && s.includes("hana-theme-applied")) { console.log("[跳过] 已含 patch: " + p); return true; }
  const bak = p + ".bak-patch";
  if (!fs.existsSync(bak)) { fs.writeFileSync(bak, s); console.log("备份: " + bak); }
  // 清理半成品 patch（若上次打失败）
  const junk = 'window.dispatchEvent(new CustomEvent("hana-theme-applied",{detail:e})))}';
  if (s.includes(junk) && !s.includes("hana.theme.changed")) { s = s.replace(junk, 'window.hana?.syncWindowTheme?.(e))}'); }
  const cnt = s.split(OLD).length - 1;
  if (cnt !== 1) { console.error("[失败] OLD 匹配 " + cnt + " 处（应为 1）: " + p); return false; }
  s = s.replace(OLD, 'window.hana?.syncWindowTheme?.(e),' + TAIL);
  fs.writeFileSync(p, s);
  console.log("[OK] patched: " + p);
  return true;
}

const args = process.argv.slice(2);
if (!args.length) {
  const base = "C:/Users/John Galt/.hanako/artifacts/";
  const paths = [
    base + "renderer/0.680.21/lib/theme.js",
    base + "server/0.680.21-win32-x64/desktop/dist-renderer/lib/theme.js",
  ];
  console.log("未传路径，使用默认两条 renderer：");
  paths.forEach(p => patchTheme(p));
} else {
  args.forEach(p => patchTheme(p));
}
