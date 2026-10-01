#!/usr/bin/env node
/**
 * 产物清单一致性检查 —— 把「打包白名单」与「运行时真实需要的东西」变成**机器核对**的关系。
 *
 * 为什么要有它：`package.json` 的 `files`（打包白名单）与 prepare 的产物清单，曾经是**两份手写清单**。
 * 新增 `lib/cross.js` 时两份都忘了加，后果非常隐蔽：
 *   本地开发用 `link:` 安装 → 直接读工作目录磁盘，一切正常（永远测不出来）；
 *   git 安装（`dsh plugin add github:…`，npm 按 `files` 打包）→ 装出来的包里没有这个模块，
 *   直到 import 阶段才 `Cannot find module './cross.js'`。
 * 所以现在清单只有一处（`package.json` 的 `files`），其余全部由磁盘产物与 import 图核对。
 *
 * 三项检查（任何一项失败都退出码 1，安装期与 CI 都会直接拦住）：
 *  ① `files` 列出的每个 `lib/` 条目在磁盘上确实存在（防手写笔误）；
 *  ② 从 `lib/index.js` 出发的**相对 import 闭包**全部在 `files` 里（防新增模块漏列）；
 *  ③ 磁盘上 `lib/` 的每个产物（排除只用于开发自测的 smoke / diag 脚本）都在 `files` 里（防反向遗漏）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const files = new Set(pkg.files ?? [])
const errors = []

// ① files 的 lib/ 条目必须在磁盘上
for (const rel of files) {
  if (rel.startsWith('lib/') && !existsSync(path.join(root, rel))) {
    errors.push(`files 列了但磁盘上没有：${rel}（打包出来的包会缺它，或者是笔误）`)
  }
}

// ② 相对 import 闭包：从宿主入口走一遍，每个被 import 的本地文件都必须在 files 里
const seen = new Set()
function walk(rel) {
  if (seen.has(rel)) return
  seen.add(rel)
  const abs = path.join(root, rel)
  if (!existsSync(abs)) {
    errors.push(`import 指向的文件不存在：${rel}（被打包清单漏掉时就是这个后果）`)
    return
  }
  if (!files.has(rel)) {
    errors.push(`运行时 import 到 ${rel}，但它不在 package.json 的 files 里 → git / npm 安装会缺文件`)
  }
  let text = ''
  try {
    text = readFileSync(abs, 'utf8')
  } catch {
    return
  }
  for (const m of text.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
    walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])))
  }
}
walk('lib/index.js')

// ③ 磁盘上的每个产物，要么在 files 里，要么在下面这份**已知开发期产物**清单里。
// 这份清单很小且基本不变（与「每加一个模块都要动一次」的打包白名单不是一回事）：
// 出现既不在 files、也不在这里的新产物时会报错 —— 逼出一次「发还是不发」的决定，而不是默默漏掉。
const DEV_ONLY = new Set([
  'lib/client.raw.js', // esbuild 压缩前的中间产物（lib/client.js 才是最终产物）
  'lib/client.d.ts',   // 客户端入口的类型声明：exports 的 ./client 不暴露 types，无需随包
  'lib/diag.d.ts', 'lib/diag.js',
  'lib/smoke.d.ts', 'lib/smoke.js',
  'lib/smoke-llm.d.ts', 'lib/smoke-llm.js',
  'lib/smoke-tools.d.ts', 'lib/smoke-tools.js',
])
for (const name of readdirSync(path.join(root, 'lib'))) {
  if (!/\.js$|\.d\.ts$/.test(name)) continue
  const rel = `lib/${name}`
  if (files.has(rel) || DEV_ONLY.has(rel)) continue
  errors.push(`磁盘上的产物 ${rel} 既不在 files 里、也不在已知开发期产物清单里`
    + ' → 要么加进 files 发布，要么在 DEV_ONLY 里声明为不发布')
}

if (errors.length) {
  console.error(`[activity-monitor check:files] 产物清单不一致，共 ${errors.length} 处：`)
  for (const e of errors) console.error(`  - ${e}`)
  console.error('提示：修 package.json 的 files（这是唯一的手写清单），再跑 npm run build 确认产物在位。')
  process.exit(1)
}
console.log(`[activity-monitor check:files] OK：files ↔ 磁盘产物 ↔ import 闭包 一致`
  + `（files ${files.size} 条目，import 闭包 ${seen.size} 个文件）`)
