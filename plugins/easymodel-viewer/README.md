# EasyModel 模型查看器（Hana 插件）

在 Hana 工作台内直接渲染 STL / OBJ / PLY / GLB / GLTF / 3MF / STEP / IGES 工程模型。作为卡片在工作台任意位置摆放。

## 用途

- 单模型浏览：打开一个文件查看、缩放、旋转、换视角、换颜色、换肤
- 多模型工作集：打开文件夹，加载所有支持的模型，横向预览条 + ◀▶ 切换
- Agent 调用：agent 通过 `open_model` 工具在卡片中打开模型（v2.0 起支持结构化返回值）

支持的格式：STL、OBJ、PLY、GLB、GLTF、3MF、STEP（mm 单位）、IGES（mm 单位）

## 安装

把插件目录放到 `~/.hanako/plugins/easymodel-viewer/`（社区版），重启 HanaAgent 后右上角导航栏出现 EasyModel 图标，点击打开 widget。

开发流程：
1. 复制到 `~/.hanako/plugin-dev-sources/easymodel-viewer/`
2. `plugin_dev_install(sourcePath)` → `plugin_dev_enable()`
3. 改完代码 → `plugin_dev_reset()` 秒级热重载
4. 验证通过后用 `Copy-Item` 同步到社区版目录，重启生效
5. `plugin_dev_uninstall()` 清理 dev slot

## 使用

### 用户手动

- 右上角 EasyModel 图标 → 打开 widget → 点「打开文件」或「打开文件夹」或拖拽文件进来
- 视图操作：滚轮缩放、拖拽旋转、空格选正视方向、Esc 关闭弹层
- 工具栏：线框切换、自转、网格切换、视角下拉（重置/透视/正交/正视方向）、颜色下拉（预设色板 + 色轮）、换肤（深/浅）、光源控制（光源⇄视角 / 光源复位）
- 多模型：◀▶ 切换 + 预览条点选

### Agent 调用

工具：`open_model`

参数：
- `file`（必填）：模型文件绝对路径
- `fit`（可选，默认 true）：打开后自动 fit 视角
- `mode`（可选，默认 `replace`）：`replace` 替换查看器内容 / `append` 追加到当前工作集

返回值：
```javascript
{
  content: [{ type: "text", text: "已就绪 cube.stl（1.2 MB · stl）..." }],
  details: {
    filePath: "C:\\models\\cube.stl",
    fileName: "cube.stl",
    fileSize: 1258291,
    format: "stl",
    openUrl: "/api/plugins/easymodel-viewer/viewer?file=...&fit=true&mode=replace",
    cardAction: "open",
    fit: true,
    mode: "replace",
  },
}
```

错误时返回 `isError: true`。

## 配置

v2.0 起**无配置项**。v1.x 时代的 `placement` 配置（right / center 二选一）已废弃。

迁移说明：
- v1.x 的 `placement: right`（默认）→ v2.0 等价，widget 在右上角导航栏
- v1.x 的 `placement: center` → v2.0 把 EasyModel 卡片从右侧栏拖到中间主区域即可
- 配置项被删除后，已有的旧用户配置 `right` / `center` 会被忽略，但 widget 实例已生成，对实际使用无影响

## 结构

```
easymodel-viewer/
├── manifest.json                 # 插件清单（v2.0 单一 widget 入口）
├── routes/
│   └── viewer.js                 # Hono 路由：/viewer（widget shell）/viewer/model /viewer/scan /viewer/diag
├── tools/
│   └── open-model.js             # Agent 工具：open_model
├── assets/
│   ├── viewer.v2.js              # 渲染核心（three.js + ArcballControls + 各种 loader + 自定义 UI 绑定）
│   ├── viewer.css                # WebView 内部样式（深/浅双主题）
│   └── vendor/legacy/            # three.min.js + STL/OBJ/PLY/GLTF/3MF Loader + ArcballControls
└── README.md
```

## v2.0 变更

| 变更 | 详情 |
|:---|:---|
| 删除 `placement` 配置 | 老前端「右侧栏 / 中间栏」二选一机制已废弃，新前端统一卡片化 |
| 删除 `manifest.full.json` | 不再需要双 manifest 同步模板 |
| 删除 `syncManifestWithConfig` | 不再需要配置变更后改写 manifest + 重启 Hana |
| 删除 `enforcePlacement` | 前端不再做 slot 检测 + 自动跳转 |
| 删除 `/viewer/center` 路由 | 不再有 page surface 入口 |
| 删除「请点击另一处使用」占位 tip | widget 始终渲染完整查看器 |
| `open_model` 工具结构化 | 返回 details（filePath/fileName/fileSize/format/openUrl/cardAction/fit/mode），错误用 `isError` 标记 |

## 已知坑

- **WKWebView / iframe 沙箱**：`confirm()` / `alert()` 不可用，必须用 HTML 弹窗或 toast 替代（已用 `hana.toast.show`）
- **CORP: same-origin**：跨源 iframe 会被拦截 assets 请求，因此 three.js + loaders + viewer 全部内联到 HTML 输出里
- **保留 `view.v2.js` mtime 缓存**：路由里的 `inlineCache` 用 mtime 检测文件变更，dev 版改完代码后会被自动刷新（cache key mismatch）
- **宿主通信靠 postMessage**：viewer.v2.js 里的 `hana.ready()`、`hana.ui.resize()`、`hana.api.fetch()`、`hana.toast.show()`、`hana.resources.pick()` 走 `hana.plugin.ui` 协议（无 SDK 依赖）
- **STEP/IGES 走 OpenCascade WASM**：路由 `/viewer/model` 在主进程调用 `occt-import-js`（首次调用时加载 7MB wasm，之后复用单例）

## 版本

- 2.0.0（2026-08-23）：移除 right/center 二选一配置
- 1.5.0：缩略图预览条 + WebGL 上下文修复
- 1.2.0：打开文件夹 + 多模型工作集
- 1.0.0：初版（基于独立 Electron 应用 EasyModel 的渲染核心移植）
