// 自测：occt-import-js 解析 STEP
const fs = require('fs');
const path = require('path');
const occtPromise = require('occt-import-js')();

occtPromise.then((occt) => {
  const file = path.join(__dirname, 'test-model', 'cube.stp');
  const content = fs.readFileSync(file);
  const result = occt.ReadStepFile(content, { linearUnit: 'millimeter' });
  console.log('success:', result.success);
  if (result.success) {
    const tris = result.meshes.reduce((s, m) => s + (m.index ? m.index.array.length / 3 : m.attributes.position.array.length / 3), 0);
    console.log('meshes:', result.meshes.length);
    console.log('triangles:', tris);
    const p = result.meshes[0].attributes.position.array;
    const xs = [], ys = [], zs = [];
    for (let i = 0; i < p.length; i += 3) { xs.push(p[i]); ys.push(p[i + 1]); zs.push(p[i + 2]); }
    console.log('bbox: x[' + Math.min(...xs).toFixed(1) + ',' + Math.max(...xs).toFixed(1) + '] y[' + Math.min(...ys).toFixed(1) + ',' + Math.max(...ys).toFixed(1) + '] z[' + Math.min(...zs).toFixed(1) + ',' + Math.max(...zs).toFixed(1) + ']');
  }
}).catch((e) => { console.error('occt init failed:', e.message); process.exit(1); });
