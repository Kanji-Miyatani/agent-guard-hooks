#!/usr/bin/env node
// PreToolUse フック（matcher: "Edit|Write|NotebookEdit"）
// Claude が書き換えようとしているファイルのパスを検査し、触らせたくないファイルを守る。
//
// 入力: stdin に PreToolUse の JSON（tool_input.file_path、NotebookEdit は tool_input.notebook_path。絶対パス）
// 出力: 判定が必要なときだけ stdout に hookSpecificOutput.permissionDecision を出して exit 0
// 仕様: https://code.claude.com/docs/en/hooks#pretooluse-input
//
// 守る対象は PROTECTED_RULES を編集して調整してください。

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// 除外は .env.example だけ（settings.json の Read(!.env.example) と .gitignore に合わせる）
const ENV_ALLOWED_SUFFIX = new Set(['.example']);

/**
 * 上から順に評価し、最初に一致したルールを使う。
 * test(posixPath, baseName) が true なら decision を返す。
 */
export const PROTECTED_RULES = [
  {
    name: 'env-file',
    decision: 'deny',
    test: (_p, base) => {
      if (base === '.envrc') return true;
      const m = /^\.env(\.[A-Za-z0-9_-]+)?$/.exec(base);
      return Boolean(m) && !ENV_ALLOWED_SUFFIX.has(m[1] || '');
    },
    reason: '.env 系ファイルは秘密情報を含むため、Claude には書き換えさせない設定です。値の追加・変更は人が行い、変数名は .env.example に追記してください。',
  },
  {
    name: 'private-key',
    decision: 'deny',
    test: (_p, base) => /\.(pem|key|p12|pfx)$/i.test(base) || /^id_(rsa|ed25519|ecdsa)/.test(base),
    reason: '秘密鍵・証明書ファイルは編集できません。',
  },
  {
    name: 'git-internal',
    decision: 'deny',
    test: (p) => /(^|\/)\.git\//.test(p),
    reason: '.git ディレクトリの中身は直接編集しないでください。git コマンドを使ってください。',
  },
  {
    name: 'dependencies',
    decision: 'deny',
    test: (p) => /(^|\/)node_modules\//.test(p),
    reason: 'node_modules の中は直接編集しないでください。変更はパッケージの更新や patch で行います。',
  },
  {
    name: 'build-output',
    decision: 'deny',
    test: (p) => /(^|\/)\.next\//.test(p),
    reason: '.next はビルド時に生成されるディレクトリです。ソースコード側を修正してください。',
  },
  {
    name: 'lockfile',
    decision: 'deny',
    test: (_p, base) => ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'].includes(base),
    reason: 'ロックファイルは手で書き換えず、パッケージマネージャー（npm / pnpm など）のコマンドで更新してください。',
  },
  {
    name: 'next-env',
    decision: 'deny',
    test: (_p, base) => base === 'next-env.d.ts',
    reason: 'next-env.d.ts は Next.js が自動生成するファイルです。編集しないでください。',
  },
  {
    name: 'team-settings',
    decision: 'ask',
    test: (p) => /(^|\/)\.claude\/(settings\.json|hooks\/)/.test(p),
    reason: 'チームで共有している Claude Code の設定（.claude/settings.json または .claude/hooks/）を変更しようとしています。内容を確認してください。',
  },
];

export function normalizePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

/** 戻り値: { decision, reason, rule } または null */
export function evaluatePath(filePath) {
  const p = normalizePath(filePath);
  if (!p) return null;
  const base = p.slice(p.lastIndexOf('/') + 1);
  for (const rule of PROTECTED_RULES) {
    if (rule.test(p, base)) return { decision: rule.decision, reason: rule.reason, rule: rule.name };
  }
  return null;
}

export function buildOutput(evaluation) {
  if (!evaluation) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: evaluation.decision,
      permissionDecisionReason: `[guard-files] ${evaluation.reason}`,
    },
  };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.stdout.write(JSON.stringify(buildOutput({ decision: 'ask', reason: 'フックの入力を解析できなかったため、念のため確認を求めています。' })));
    return;
  }
  const ti = input.tool_input || {};
  const filePath = ti.file_path || ti.notebook_path;
  const out = buildOutput(evaluatePath(filePath));
  if (out) process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
