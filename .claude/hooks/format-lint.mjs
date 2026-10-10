#!/usr/bin/env node
// PostToolUse フック（matcher: "Edit|Write"）
// Claude がファイルを書き換えた直後に、プロジェクトに入っている Prettier で整形し、
// ESLint でそのファイルだけを検査する。ESLint のエラーがあれば Claude に伝えて直させる。
//
// 入力: stdin に PostToolUse の JSON（tool_input.file_path は絶対パス）
// 出力:
//   - ESLint エラーあり → {"decision":"block","reason":"..."}（理由がツール結果の横に表示され、Claude が修正に入る）
//   - ESLint 自体が動かない → {"systemMessage":"..."}（人への注意表示のみ）
//   - それ以外 → 何も出さない
// 仕様: https://code.claude.com/docs/en/hooks#posttooluse-decision-control
//
// 前提: prettier / eslint はプロジェクトの devDependencies に入っているものを使う。
//       入っていなければ何もしない（グローバルのツールや npx でのダウンロードは行わない）。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PRETTIER_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json', '.css', '.scss', '.md', '.mdx', '.yml', '.yaml', '.html']);
const ESLINT_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const SKIP_DIR_RE = /(^|\/)(node_modules|\.next|\.git|dist|build|out|coverage)\//;
const MAX_MESSAGES = 20;

/** file の場所から projectDir まで上にたどって node_modules/<pkg> を探す */
export function findPackage(pkg, fromDir, stopDir) {
  let dir = fromDir;
  const stop = path.resolve(stopDir);
  for (;;) {
    const pj = path.join(dir, 'node_modules', pkg, 'package.json');
    if (existsSync(pj)) {
      try {
        const meta = JSON.parse(readFileSync(pj, 'utf8'));
        const binField = typeof meta.bin === 'string' ? meta.bin : meta.bin && (meta.bin[pkg] || Object.values(meta.bin)[0]);
        if (binField) {
          return { root: dir, bin: path.join(dir, 'node_modules', pkg, binField), version: String(meta.version || '0') };
        }
      } catch {
        /* 壊れた package.json は無視 */
      }
    }
    if (path.resolve(dir) === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function run(bin, args, cwd, timeoutMs) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
}

export function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** ESLint の JSON 出力からエラーだけを要約する */
export function summarizeEslint(jsonText, filePath, projectDir) {
  let results;
  try {
    results = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const errors = [];
  for (const r of results) {
    for (const m of r.messages || []) {
      if (m.severity === 2) errors.push(m);
    }
  }
  if (!errors.length) return null;
  const rel = path.relative(projectDir, filePath).replace(/\\/g, '/');
  const lines = errors.slice(0, MAX_MESSAGES).map((m) => `- ${rel}:${m.line ?? '?'}:${m.column ?? '?'} ${m.ruleId ?? 'parse-error'}: ${m.message}`);
  if (errors.length > MAX_MESSAGES) lines.push(`- ほか ${errors.length - MAX_MESSAGES} 件`);
  return { count: errors.length, text: lines.join('\n') };
}

export function processFile(filePath, projectDir) {
  const out = { prettier: 'skipped', eslint: 'skipped', output: null };
  if (!filePath) return out;
  const file = path.resolve(filePath);
  const posix = file.replace(/\\/g, '/');
  if (!isInside(file, projectDir) || SKIP_DIR_RE.test(posix)) return out;
  if (!existsSync(file) || !statSync(file).isFile()) return out;
  const ext = path.extname(file).toLowerCase();

  // 1) Prettier で整形（失敗しても作業は止めない）
  if (PRETTIER_EXT.has(ext)) {
    const prettier = findPackage('prettier', path.dirname(file), projectDir);
    if (prettier) {
      const r = run(prettier.bin, ['--write', file], prettier.root, 30000);
      out.prettier = r.status === 0 ? 'formatted' : `failed(${r.status})`;
    }
  }

  // 2) ESLint で検査（エラーがあれば Claude に返す）
  if (ESLINT_EXT.has(ext)) {
    const eslint = findPackage('eslint', path.dirname(file), projectDir);
    if (eslint) {
      const major = parseInt(eslint.version.split('.')[0], 10) || 0;
      const args = ['--format', 'json'];
      if (major >= 9) args.push('--no-warn-ignored');
      args.push(file);
      const r = run(eslint.bin, args, eslint.root, 45000);
      if (r.status === 0) {
        out.eslint = 'clean';
      } else if (r.status === 1) {
        const summary = summarizeEslint(r.stdout, file, projectDir);
        if (summary) {
          out.eslint = `errors(${summary.count})`;
          out.output = {
            decision: 'block',
            reason: `[format-lint] ESLint で ${summary.count} 件のエラーが見つかりました。次の内容を修正してください。\n${summary.text}`,
          };
        } else {
          out.eslint = 'warnings-only';
        }
      } else {
        out.eslint = `crashed(${r.status ?? r.signal})`;
        out.output = {
          systemMessage: `[format-lint] ESLint を実行できませんでした（終了コード ${r.status ?? r.signal}）。eslint の設定を確認してください。`,
        };
      }
    }
  }
  return out;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return; // PostToolUse はツール実行後なので、入力が読めなければ何もしない
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const filePath = input.tool_input && input.tool_input.file_path;
  const result = processFile(filePath, projectDir);
  if (process.env.FORMAT_LINT_DEBUG === '1') process.stderr.write(JSON.stringify(result) + '\n');
  if (result.output) process.stdout.write(JSON.stringify(result.output));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
