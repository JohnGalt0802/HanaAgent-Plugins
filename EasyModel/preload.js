// 预加载桥：安全地把主进程能力暴露给页面
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stlAPI', {
  // 返回 { files: [绝对路径...], index: 当前索引 }；找不到返回 { files: [], index: -1 }
  listModels: (currentPath) => ipcRenderer.invoke('list-models', currentPath),
  // 解析 STEP/IGES（按路径或按二进制内容），返回 { success, result|error }
  parseCad: (filePath) => ipcRenderer.invoke('parse-cad', filePath),
  parseCadBuffer: (payload) => ipcRenderer.invoke('parse-cad-buffer', payload),
  // 弹出系统「打开方式」对话框（用于设为默认打开方式）
  openAsDialog: (filePath) => ipcRenderer.invoke('open-as-dialog', filePath),
  // 选择文件夹并扫描目录内模型，返回 { canceled, dir, files: [{name,path,ext}] }
  scanFolder: () => ipcRenderer.invoke('scan-folder'),
});
