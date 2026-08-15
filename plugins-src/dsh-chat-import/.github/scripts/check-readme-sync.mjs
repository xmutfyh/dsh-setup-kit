// REQ-06：双语 README 结构同步检查（只读、零依赖，CI 与本地均可跑）。
//
// 比对 README.md（EN）与 README.zh-CN.md（ZH）的 Markdown 标题结构：
//   1) 标题层级序列（## / ### 的相对顺序与层级）必须一致 —— 抓「某一版删/加/改层级标题」；
//   2) 语言无关锚点键（首个 ASCII 词，无则取首个 emoji）按序一致 —— 抓「某一版改锚点标题」。
//
// 逐字文本不做比较（两版是翻译对，文本必然不同）；键无法提取的标题跳过
// （宁缺毋滥，避免把翻译差异误报为结构漂移）。标题提取跳过围栏代码块
// （``` 内的 shell 注释行不是标题）。退出码：0 = 同步，1 = 结构漂移，2 = 用法/IO 错误。

import fs from 'node:fs';

const USAGE = 'usage: node check-readme-sync.mjs [en.md] [zh.md]';

function extractHeadings(lines) {
  const headings = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})[ \t]+(.+?)[ \t]*$/);
    if (!m) continue;
    headings.push({ level: m[1].length, text: m[2], line: i + 1 });
  }
  return headings;
}

// 语言无关锚点键：开头的 ASCII 词（Claude / ChatGPT / opencode …），
// 无 ASCII 词时取开头的 emoji（去掉 VS16 变体选择符，⚙ 与 ⚙️ 视为同一键）。
function anchorKey(text) {
  const ascii = text.match(/^[A-Za-z0-9]+/);
  if (ascii) return ascii[0];
  const emoji = text.match(/^\p{Extended_Pictographic}/u);
  return emoji ? emoji[0].replace(/\uFE0F/g, '') : null;
}

function describe(h) {
  return h ? `level ${h.level} "${h.text}" (line ${h.line})` : '(missing)';
}

function compare(en, zh) {
  const errors = [];
  const n = Math.max(en.length, zh.length);
  for (let i = 0; i < n; i++) {
    const a = en[i];
    const b = zh[i];
    if (!a || !b || a.level !== b.level) {
      errors.push(`heading #${i + 1} mismatch: EN=${describe(a)} vs ZH=${describe(b)}`);
      continue;
    }
    const ka = anchorKey(a.text);
    const kb = anchorKey(b.text);
    if (ka !== null && kb !== null && ka !== kb) {
      errors.push(
        `heading #${i + 1} anchor mismatch: EN "${a.text}" (key ${ka}) vs ZH "${b.text}" (key ${kb})`
      );
    }
  }
  return errors;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) {
    console.log(USAGE);
    process.exit(0);
  }
  const [enFile = 'README.md', zhFile = 'README.zh-CN.md'] = args;
  let en;
  let zh;
  try {
    en = extractHeadings(fs.readFileSync(enFile, 'utf8').split(/\r?\n/));
    zh = extractHeadings(fs.readFileSync(zhFile, 'utf8').split(/\r?\n/));
  } catch (err) {
    console.error(`check-readme-sync: cannot read files: ${err.message}`);
    process.exit(2);
  }
  const errors = compare(en, zh);
  if (errors.length === 0) {
    console.log(`check-readme-sync: OK — ${en.length} headings in sync (${enFile} ↔ ${zhFile})`);
    process.exit(0);
  }
  console.error(
    `check-readme-sync: FAIL — bilingual README structure drifted (${errors.length} issue(s)):`
  );
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

main();
