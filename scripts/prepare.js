#!/usr/bin/env node
/**
 * 安装期钩子（npm/pnpm 安装本包后执行 prepare）。
 *
 * 原则：标准安装路径（`dsh plugin add <git-url>` → pnpm git 依赖）**只装生产依赖、
 * 不装 devDependencies**，本包没有生产依赖 → tsc/esbuild 不在。此时不得尝试编译，
 * 只校验仓库内已提交的 lib/ 产物在位（dsh 官方插件同模式：编译产物随包发布）。
 * 本地开发（仓库自身为 root 安装、devDeps 齐全）才现场重编译，保证 lib 最新。
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const require0 = createRequire(path.join(root, 'package.json'))
const has = (m) => { try { require0.resolve(m); return true } catch { return false } }

if (has('typescript') && has('esbuild')) {
  // 本地开发环境：现场编译（execFileSync 不经过 sh，无引号解析问题）。
  // --noCheck：干净环境下 devDeps 可能与传递依赖版本并存（如 dsh-llm 双线），
  // branded 类型可能互斥；安装期只要产物，完整类型检查留在 npm run build/test。
  execFileSync(path.join(root, 'node_modules', '.bin', 'tsc'), ['--noCheck'], { cwd: root, stdio: 'inherit' })
  execFileSync(process.execPath, ['build-client.mjs'], { cwd: root, stdio: 'inherit' })
  process.exit(0)
}

// 标准安装（git 依赖 / npm registry）：校验已随仓库发布的产物。
//
// 清单**不再手写**：手写清单正是错漏的来源（`lib/cross.js` 漏在 files 里，本地 link: 安装永远测不出来，
// git 安装却会在 import 阶段炸）。现在只保留一处清单（package.json 的 files），
// 由 scripts/check-artifacts.js 对着磁盘产物与运行时 import 闭包核对 —— 安装期与 CI 跑的是同一段逻辑。
// （该脚本失败会以非零退出码冒泡：execFileSync 抛错 → 安装直接失败，这正是我们要的 —— 拦在安装期而非运行期。）
execFileSync(process.execPath, [path.join(root, 'scripts', 'check-artifacts.js')], { cwd: root, stdio: 'inherit' })
console.log('[activity-monitor prepare] 无构建工具，使用仓库内已提交的 lib/ 产物（清单已核对）')
