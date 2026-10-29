/** A generation convention, not a formula rewriter or a claim of mathematical correctness. */
export const MATH_GUIDANCE = String.raw`数学排版统一使用 Markdown LaTeX：短公式用 $...$，独立公式用单独成行的 $$ 包围，公式块前后留空行；多行推导可在块内用 aligned。不要把数学公式放进反引号或代码围栏，不混用 Unicode 上下标和 LaTeX 表示同一组符号。变量首次出现时解释含义、单位和适用案例；保持原材料的正负号、系数、上下标、求和范围与条件，不能为了统一样式更改数学含义。普通数值和单位不必全部数学化；API 名、变量代码及可执行代码仍使用反引号或带语言的代码块，不改写为 LaTeX。
公式内比较符号使用 \lt、\gt、\le、\ge，不使用 HTML 实体 &lt;、&gt; 或原始尖括号；百分号在公式中写成 \%，普通文本金额优先写“美元”等单位，避免把货币符号误作数学定界符。这里只规定格式，不填补缺失公式、不声称求解正确。不要使用 HTML、图片、链接、宏定义或外部资源命令排版数学。公式块末尾不加中文句号，解释性标点放在公式外的引出或说明段落；不要改变小数点、分隔符或公式中 text 的原有内容。
返回 JSON 时必须转义 LaTeX 反斜杠：例如正文 $\hat{y}=wx+b$ 在 JSON 字符串中写成 "$\\hat{y}=wx+b$"；不要让 \theta、\frac 等变成 JSON 的制表符或换页控制字符。`;

/**
 * Remove a prose full stop only at the end of a closed, standalone $$ block.
 * This is not a TeX repairer: comments, code, incomplete groups/environments and
 * ambiguous input stay untouched. Never alter commas, decimals or inline math.
 */
export function cleanDisplayMathStops(value: string): string {
  const lines = value.split("\n");
  let fence: { char: string; length: number } | undefined;
  let inlineCode = 0, opening = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (opening < 0 && !inlineCode && marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length }; continue;
    }
    if (!inlineCode && /^ {0,3}\$\$[ \t\r]*$/.test(line)) {
      if (opening < 0) opening = i;
      else {
        const body = lines.slice(opening + 1, i).join("\n");
        if (safeMathStop(body)) {
          let end = i - 1;
          while (end > opening && !lines[end]!.trim()) end--;
          lines[end] = lines[end]!.replace(/。([ \t\r]*)$/, "$1");
        }
        opening = -1;
      }
      continue;
    }
    if (opening >= 0) continue;
    // Carry code-span state across lines; ambiguous/unclosed backticks suppress edits.
    for (const run of line.matchAll(/`+/g)) {
      let escapes = 0;
      for (let at = run.index - 1; at >= 0 && line[at] === "\\"; at--) escapes++;
      if (!inlineCode && escapes % 2) continue;
      if (!inlineCode) inlineCode = run[0].length;
      else if (inlineCode === run[0].length) inlineCode = 0;
    }
  }
  return lines.join("\n");
}
function safeMathStop(body: string): boolean {
  if (!/。\s*$/.test(body) || /[`$]/.test(body) || /^ {0,3}~{3,}/m.test(body) || !/[=^_]|\\[a-zA-Z]+/.test(body)) return false;
  let escapes = 0;
  for (let at = body.trimEnd().length - 2; at >= 0 && body[at] === "\\"; at--) escapes++;
  if (escapes % 2) return false;
  let braces = 0;
  for (let i = 0; i < body.length; i++) {
    const character = body[i];
    if (character === "\\") { i++; continue; }
    if (character === "%") return false; // A comment may hide delimiters or punctuation.
    if (character === "{") braces++;
    if (character === "}" && --braces < 0) return false;
  }
  if (braces) return false;
  const environments: string[] = [];
  for (const match of body.matchAll(/\\(begin|end)\{([^{}]+)\}/g)) {
    if (match[1] === "begin") environments.push(match[2]!);
    else if (environments.pop() !== match[2]) return false;
  }
  return environments.length === 0;
}

