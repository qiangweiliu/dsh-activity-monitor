// client.tsx 打包成 lib/client.js（dsh web 模块加载器格式）
//
// 官方格式要求：factory(require) 必须把插件写到 module.exports 上
// （至少要导出 apply 和 inject），加载器校验 "expect function or object
// with an apply method"。
//
// 关键点：esbuild 用 format: 'cjs'，源码的 export 语句会编译成对
// exports/module.exports 的赋值，执行完后我们返回的 module.exports
// 就是插件对象。react 等依赖 external 化，运行时通过 host 的 require 拿。
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

mkdirSync('lib', { recursive: true })

await build({
  entryPoints: ['src/client.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  outfile: 'lib/client.raw.js',
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: false,
})

const body = readFileSync('lib/client.raw.js', 'utf8')

const wrapped = `window.__ModuleLoader__.load({
\tid: "dsh-activity-monitor",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
\t\t;(function(module, exports, require){
${body}
\t\t})(module, exports, (name) => require(name));
\t\treturn module.exports;
\t}
});
`
writeFileSync('lib/client.js', wrapped)
console.log('client bundle written: lib/client.js')
