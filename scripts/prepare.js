#!/usr/bin/env node
/**
 * 安装期钩子（npm/pnpm 安装本包后执行 prepare）。
 *
 * 原则：标准安装路径（`dsh plugin add <git-url>` → pnpm git 依赖）**只装生产依赖、
 * 不装 devDependencies**，本包没有生产依赖 → tsc/esbuild 不在。此时不得尝试编译，
 * 只校验仓库内已提交的 lib/ 产物在位（dsh 官方插件同模式：编译产物随包发布）。
 * 本地开发（仓库自身为 root 安装、devDeps 齐全）才现场重编译，保证 lib 最新。
 */
import { existsSync } from 'node:fs'
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

// 标准安装（git 依赖 / npm registry）：校验已随仓库发布的产物
// 清单口径：lib/index.js 运行时真正 import 的模块 + 各自的 .d.ts + 客户端包 + 补丁配置。
// 少列一个（例如新增模块忘了加）会让标准安装装完才在 import 阶段炸 —— prepare 是唯一能在安装期拦住它的地方。
const artifacts = [
  'lib/index.js', 'lib/index.d.ts',
  'lib/client.js',
  'lib/config.js', 'lib/config.d.ts',
  'lib/derive.js', 'lib/derive.d.ts',
  'lib/history.js', 'lib/history.d.ts',
  'lib/sig.js', 'lib/sig.d.ts',
  'lib/types.js', 'lib/types.d.ts',
  'lib/wire.js', 'lib/wire.d.ts',
  'cordis.patch.yml', 'package.json',
]
const missing = artifacts.filter((rel) => !existsSync(path.join(root, rel)))
if (missing.length) {
  console.error(`[activity-monitor prepare] 缺少已发布的产物：${missing.join(', ')}（当前环境无 typescript/esbuild 无法现场编译）——请在本仓库先跑 npm run build 并提交 lib/，或改用带 node_modules 的本地路径安装`)
  process.exit(1)
}
console.log('[activity-monitor prepare] 无构建工具，使用仓库内已提交的 lib/ 产物')
