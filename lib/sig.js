/**
 * 归一化错误文本 → 可聚类的签名片段。必须幂等：
 * `normalizeErrorText(normalizeErrorText(x)) === normalizeErrorText(x)`。
 */
export function normalizeErrorText(input) {
    let s = String(input ?? '');
    // 终端上色残留（ESC 序列）不带信息，去掉
    s = s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
    // 绝对路径 → <path>：路径里往往带 tmp 名 / 随机目录 / 用户目录，逐字比对会把同类失败拆开
    s = s.replace(/(?:[A-Za-z]:\\[^\s'"]+|\/(?:[\w.@+-]+\/)+[\w.@+-]+)/g, '<path>');
    // 十六进制（哈希 / 地址）与数字（行号 / 字节数 / 耗时）都不稳定
    s = s.replace(/0x[0-9a-f]+/gi, '<n>');
    s = s.replace(/\d+/g, '<n>');
    // 错误的可辨识部分几乎都在第一行；折叠空白并小写化
    const first = (s.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    return first.length > 120 ? first.slice(0, 120) : first;
}
/** 失败签名 = 工具名 | 错误类别 | 归一化错误首行 */
export function failureSig(toolName, errClass, text) {
    return `${toolName}|${errClass}|${normalizeErrorText(text) || '(空错误信息)'}`;
}
