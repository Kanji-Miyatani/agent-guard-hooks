#!/usr/bin/env node
// SessionStart フック（matcher: "startup|resume|clear"）
// セッション開始時に、現在のブランチ・未コミットの変更・パッケージマネージャーを Claude に伝える。
// SessionStart フックの標準出力（プレーンテキスト）は Claude のコンテキストに追加される。
// 仕様: https://code.claude.com/docs/en/hooks#sessionstart-decision-control
//
// 失敗しても作業を止めないよう、常に exit 0 で終わる。

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function detectPackageManager(dir) {
  if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm（pnpm-lock.yaml あり）';
  if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn（yarn.lock あり）';
  if (existsSync(path.join(dir, 'bun.lockb')) || existsSync(path.join(dir, 'bun.lock'))) return 'bun（bun.lock あり）';
  if (existsSync(path.join(dir, 'package-lock.json'))) return 'npm（package-lock.json あり）';
  return null;
}

export function buildContext(dir) {
  const lines = ['[セッション開始時のリポジトリ状態（session-context フック）]'];
  if (git(['rev-parse', '--is-inside-work-tree'], dir) === 'true') {
    const branch = git(['branch', '--show-current'], dir);
    lines.push(`- 現在のブランチ: ${branch || '(detached HEAD)'}`);
    const status = git(['status', '--porcelain'], dir);
    if (status !== null) {
      const count = status ? status.split('\n').length : 0;
      lines.push(`- 未コミットの変更: ${count} ファイル`);
    }
    const last = git(['log', '-1', '--format=%h %s'], dir);
    if (last) lines.push(`- 直近のコミット: ${last}`);
  } else {
    lines.push('- git リポジトリではありません');
  }
  const pm = detectPackageManager(dir);
  if (pm) lines.push(`- パッケージマネージャー: ${pm}`);
  lines.push(`- Node.js: ${process.version}`);
  return lines.join('\n');
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    /* 入力が読めなくても続行 */
  }
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  try {
    process.stdout.write(buildContext(dir) + '\n');
  } catch {
    /* 何も出さずに終了 */
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
