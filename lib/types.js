/**
 * 活动行的数据结构（宿主半身与浏览器半身共用的词汇表）。
 *
 * 单独成文件的原因：wire.ts / history.ts / index.ts / client.tsx 都要引用它，
 * 而 index.ts 会 import 前两者 —— 类型若留在 index.ts 会形成循环依赖。
 * index.ts 仍然把它们 re-export 出去（`export type { ActivityRow, ActivitySection }`），
 * 对外 API 不变。
 */
export {};
