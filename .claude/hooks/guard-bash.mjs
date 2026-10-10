#!/usr/bin/env node
// PreToolUse フック（matcher: "Bash|PowerShell"）
// Claude が実行しようとしているシェルコマンドを検査し、危険なものを止める。
//
// 入力: stdin に PreToolUse の JSON（tool_name, tool_input.command など）
// 出力: 判定が必要なときだけ stdout に次の JSON を出して exit 0
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//     "permissionDecision":"deny"|"ask","permissionDecisionReason":"..."}}
// 判定なし（通常の権限フローに任せる）のときは何も出さずに exit 0。
//
// 仕様: https://code.claude.com/docs/en/hooks#pretooluse-decision-control
// 注意: これは文字列ベースのベストエフォート検査です。完全な防御ではありません。
//       settings.json の deny ルールやサンドボックスと組み合わせて使ってください。
//
// 検査する書き方: && || ; | & 改行で区切った各コマンド、( … ) と { …; } の中、
// for / while / if の本体、$( … ) とバッククォートの中、bash -c / bash -lc / sh -ec、
// eval、xargs（オプション付きも含む）、bash へのヒアドキュメント、
// PowerShell の -Command / Invoke-Expression、cmd /c。
// PowerShell（\ がパスの区切り、` がエスケープ）と cmd（^ がエスケープ）は書式を分けて解析する。

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// 再帰削除してよい「生成物」ディレクトリ（プロジェクト内の相対パスのみ）
export const SAFE_RM_TARGETS = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  '.turbo',
  '.cache',
  '.vercel',
  'storybook-static',
  'playwright-report',
  'test-results',
]);

// .env 系ファイル（.env.example だけは対象外。.envrc も対象）
const ENV_FILE_RE = /(^|[\s'"=/\\(:])\.env(rc|\.[A-Za-z0-9_-]+)?(?=$|[\s'")\];,|&<>])/g;
const ENV_ALLOWED_SUFFIX = new Set(['.example']);
// ワイルドカードが .env 系に一致するかを調べるときの見本
const ENV_SAMPLE_NAMES = ['.env', '.env.local', '.env.production', '.env.development.local', '.envrc'];

// ファイルの中身を読み出す・持ち出すコマンド
const READER_COMMANDS = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk',
  'source', '.', 'scp', 'rsync', 'base64', 'xxd', 'od', 'strings', 'bat',
  'nl', 'cut', 'sort', 'uniq', 'diff', 'vim', 'vi', 'nano', 'code', 'tee', 'dotenv',
  'get-content', 'gc', 'type', 'select-string', 'sls', 'findstr',
]);

const WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'command', 'builtin', 'exec', 'stdbuf', 'noglob']);
// sh 系のシェル（-c の後ろの文字列を Bash の書式で検査する）
const SH_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const PS_SHELLS = new Set(['pwsh', 'powershell']);
// コマンドの前に付く Bash の予約語（then rm -rf ~ の rm を取り出すため）
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}']);
// xargs のオプションのうち、次の単語を値として取るもの
const XARGS_VALUE_OPTS = new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--process-slot-var']);
// PowerShell の Remove-Item で、次の単語を値として取る（削除対象ではない）パラメーター
const PS_VALUE_PARAMS = new Set(['-include', '-exclude', '-filter', '-stream', '-credential', '-erroraction', '-ea', '-warningaction', '-wa', '-informationaction', '-errorvariable', '-ev', '-outvariable', '-ov']);
const PS_REMOVE = new Set(['remove-item', 'ri', 'rm', 'rmdir', 'del', 'erase', 'rd']);
const CMD_REMOVE = new Set(['rd', 'rmdir', 'del', 'erase']);

const DENY = 'deny';
const ASK = 'ask';

function escapeCharFor(toolName) {
  if (toolName === 'PowerShell') return '`';
  if (toolName === 'cmd') return '^';
  return '\\';
}

/**
 * 引用符を考慮してコマンド文字列を区切る。
 * 区切り: && || ; | & 改行、グループの ( ) と { }。$( … ) と ${ … } は単語の一部として残す
 * （$( … ) の中身は extractSubstitutions で別に検査する）。
 */
export function splitSegments(command, toolName = 'Bash') {
  const ps = toolName === 'PowerShell';
  const cmdShell = toolName === 'cmd';
  const esc = escapeCharFor(toolName);
  const segments = [];
  const stack = [];
  let cur = '';
  let quote = null;
  const flush = () => {
    if (cur.trim()) segments.push(cur.trim());
    cur = '';
  };
  const inSubst = () => stack.includes('subst');
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const prev = i > 0 ? command[i - 1] : '';
    const next = command[i + 1];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      else if (ch === esc && quote === '"' && !cmdShell && i + 1 < command.length) cur += command[++i];
      continue;
    }
    if (ch === '"' || (ch === "'" && !cmdShell)) {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === esc && i + 1 < command.length) {
      cur += ch + command[++i];
      continue;
    }
    if (ch === '$' && next === '{' && !cmdShell) {
      const end = command.indexOf('}', i + 2);
      const stop = end < 0 ? command.length - 1 : end;
      cur += command.slice(i, stop + 1);
      i = stop;
      continue;
    }
    if (ch === '$' && next === '(' && !cmdShell) {
      stack.push('subst');
      cur += '$(';
      i++;
      continue;
    }
    if (ch === '(') {
      if (inSubst()) {
        stack.push('paren');
        cur += ch;
      } else {
        stack.push('group');
        flush();
      }
      continue;
    }
    if (ch === ')') {
      const top = stack.pop();
      if (top === 'subst' || top === 'paren') cur += ch;
      else flush();
      continue;
    }
    if (inSubst()) {
      cur += ch;
      continue;
    }
    if (!cmdShell && (ch === '{' || ch === '}')) {
      const isWord = ps
        ? prev !== '@'
        : ch === '{'
          ? (i === 0 || /[\s;&|(]/.test(prev)) && (next === undefined || /\s/.test(next))
          : (i === 0 || /[\s;]/.test(prev)) && (next === undefined || /[\s;&|)]/.test(next));
      if (isWord) {
        flush();
        continue;
      }
    }
    if (ch === '&' && (prev === '>' || next === '>' || prev === '<')) {
      cur += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      flush();
      if ((ch === '|' || ch === '&' || ch === ';') && next === ch) i++;
      continue;
    }
    cur += ch;
  }
  flush();
  return segments;
}

/** $( ... ) とバッククォートの中身を取り出す（入れ子は1段まで） */
export function extractSubstitutions(command) {
  const inner = [];
  const dollar = /\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  const backtick = /`([^`]*)`/g;
  let m;
  while ((m = dollar.exec(command))) inner.push(m[1]);
  while ((m = backtick.exec(command))) inner.push(m[1]);
  return inner;
}

/** 1つのセグメントを単語に分解する（引用符は取り除く）。toolName でエスケープ文字を切り替える */
export function tokenize(segment, toolName = 'Bash') {
  const cmdShell = toolName === 'cmd';
  const esc = escapeCharFor(toolName);
  const words = [];
  let cur = '';
  let quote = null;
  let has = false;
  let depth = 0; // $( … ) の中は空白で区切らない
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === esc && quote === '"' && !cmdShell && i + 1 < segment.length) cur += segment[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || (ch === "'" && !cmdShell)) {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === esc && i + 1 < segment.length) {
      cur += segment[++i];
      has = true;
      continue;
    }
    if (ch === '$' && segment[i + 1] === '(' && !cmdShell) {
      depth++;
      cur += '$(';
      i++;
      has = true;
      continue;
    }
    if (depth > 0) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur) words.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has || cur) words.push(cur);
  return words;
}

/** ヒアドキュメントの本文（<<EOF ... EOF）を取り除く。本文中の文字列をコマンドと誤認しないため */
export function stripHeredocs(command) {
  return splitHeredocs(command).command;
}

/**
 * ヒアドキュメントを本文と分ける。
 * 戻り値の shellBodies は、bash / sh / pwsh などシェル自体に渡している本文（中身もコマンドとして検査する）。
 */
export function splitHeredocs(command) {
  const lines = command.split('\n');
  const out = [];
  const shellBodies = [];
  let delimiter = null;
  let body = null;
  for (const line of lines) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) {
        if (body) shellBodies.push(body.join('\n'));
        delimiter = null;
        body = null;
      } else if (body) {
        body.push(line);
      }
      continue;
    }
    out.push(line);
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (m) {
      delimiter = m[2];
      const before = line.slice(0, m.index);
      body = /(^|[\s;&|(])(\S*\/)?(ba|z|da|k)?sh(\s+-\S+)*\s*$|(^|[\s;&|(])(pwsh|powershell)(\.exe)?(\s+-\S+)*\s*$/i.test(before) ? [] : null;
    }
  }
  return { command: out.join('\n'), shellBodies };
}

/** リダイレクト（> file, 2>&1, </dev/null など）を単語列から取り除く */
export function stripRedirections(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const t = words[i];
    if (/^\d*(>>?|<<?<?|&>>?|>&|<>)$/.test(t)) {
      i++; // 次の単語はリダイレクト先
      continue;
    }
    if (/^\d*(>>?|<|&>>?)\S+$/.test(t) || /^\d*>&\d+-?$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

const RUNNER_SUBCOMMANDS = { pnpm: ['dlx', 'exec'], yarn: ['dlx', 'exec'], npm: ['exec'], bun: ['x'] };

/** 先頭の予約語・環境変数代入・ラッパー（timeout, nice, npx, xargs など）を外して実体のコマンドを返す */
export function stripPrefixes(words) {
  let w = [...words];
  let changed = true;
  while (changed && w.length) {
    changed = false;
    // ( や { が単語にくっついている場合（例: "(rm"）は外す
    if (/^[({]+./.test(w[0])) {
      w[0] = w[0].replace(/^[({]+/, '');
      changed = true;
    }
    while (w.length && SHELL_KEYWORDS.has(w[0])) {
      w.shift();
      changed = true;
    }
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) {
      w.shift();
      changed = true;
    }
    if (!w.length) break;
    const head = commandName(w[0]);
    if (head === 'env') {
      const rest = w.slice(1);
      while (rest.length && (rest[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]))) rest.shift();
      if (!rest.length) break; // `env` 単体は環境変数の一覧表示なのでそのまま評価する
      w = rest;
      changed = true;
    } else if (head === 'xargs') {
      w.shift();
      while (w.length && w[0].startsWith('-') && w[0] !== '-') {
        const opt = w.shift();
        if (opt === '--') break;
        if (XARGS_VALUE_OPTS.has(opt)) w.shift();
      }
      changed = true;
    } else if (head === 'npx' || head === 'bunx') {
      w.shift();
      while (w.length && w[0].startsWith('-')) w.shift();
      changed = true;
    } else if (RUNNER_SUBCOMMANDS[head] && RUNNER_SUBCOMMANDS[head].includes(w[1])) {
      w.splice(0, 2);
      while (w.length && w[0].startsWith('-')) w.shift();
      changed = true;
    } else if (WRAPPERS.has(head)) {
      w.shift();
      if (head === 'timeout') {
        while (w.length && w[0].startsWith('-')) w.shift();
        if (w.length && /^\d/.test(w[0])) w.shift();
      } else if (head === 'nice') {
        if (w[0] === '-n') w.splice(0, 2);
        else if (w.length && /^-\d+$/.test(w[0])) w.shift();
      } else if (head === 'stdbuf') {
        while (w.length && w[0].startsWith('-')) w.shift();
      }
      changed = true;
    }
  }
  return w;
}

function baseName(p) {
  const s = String(p).replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1).toLowerCase();
}

/** コマンド名（パスと Windows の .exe を除き、小文字にしたもの） */
function commandName(p) {
  return baseName(p).replace(/\.exe$/, '');
}

function isEnvFileToken(token) {
  const name = baseName(token);
  if (name === '.envrc') return true;
  const m = /^\.env(\.[A-Za-z0-9_-]+)?$/.exec(name);
  if (!m) return false;
  return !ENV_ALLOWED_SUFFIX.has(m[1] || '');
}

/** ワイルドカード（* ? [ ]）を含む引数が .env 系ファイルに一致しうるか */
export function globMayMatchEnv(token, isPowerShell = false) {
  const name = baseName(token);
  if (!/[*?[]/.test(name)) return false;
  // Bash では先頭のドットは明示しないと一致しない（* は .env に一致しない）
  if (!isPowerShell && !name.startsWith('.')) return false;
  let re = '';
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = name.indexOf(']', i + 1);
      if (end < 0) {
        re += '\\[';
        continue;
      }
      let cls = name.slice(i + 1, end);
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      re += `[${cls.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  let rx;
  try {
    rx = new RegExp(`^${re}$`, 'i');
  } catch {
    return true; // 解析できないワイルドカードは一致しうるものとして扱う
  }
  return ENV_SAMPLE_NAMES.some((n) => rx.test(n) && isEnvFileToken(n));
}

/** コマンド全体に .env 系ファイルへの言及があるか */
export function mentionsEnvFile(command) {
  ENV_FILE_RE.lastIndex = 0;
  let m;
  while ((m = ENV_FILE_RE.exec(command))) {
    if (m[2] === 'rc' || !ENV_ALLOWED_SUFFIX.has(m[2] || '')) return true;
  }
  return false;
}

/** rm / Remove-Item / rd /s の引数を解析する。mode: 'Bash' | 'PowerShell' | 'cmd' */
export function parseRemove(args, mode = 'Bash') {
  const isPowerShell = mode === 'PowerShell' || mode === true;
  const isCmd = mode === 'cmd';
  let recursive = false;
  let force = false;
  let noPreserveRoot = false;
  const targets = [];
  let endOfFlags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!endOfFlags && a === '--') {
      endOfFlags = true;
      continue;
    }
    if (isCmd && /^\/[a-z]/i.test(a)) {
      const lower = a.toLowerCase();
      if (lower === '/s') recursive = true;
      if (lower === '/q' || lower === '/f') force = true;
      continue;
    }
    if (!endOfFlags && a.startsWith('-') && a.length > 1) {
      const lower = a.toLowerCase();
      if (isPowerShell && PS_VALUE_PARAMS.has(lower)) {
        i++; // 値は削除対象ではない
        continue;
      }
      if (lower === '--recursive' || lower === '-recurse' || lower === '-r') recursive = true;
      else if (lower === '--force' || lower === '-force' || lower === '-fo' || lower === '-f') force = true;
      else if (lower === '--no-preserve-root') noPreserveRoot = true;
      else if (!a.startsWith('--') && !(isPowerShell && a.length > 3)) {
        for (const c of a.slice(1)) {
          if (c === 'r' || c === 'R') recursive = true;
          if (c === 'f') force = true;
        }
      }
      continue;
    }
    targets.push(a);
  }
  return { recursive, force, noPreserveRoot, targets };
}

/** 再帰削除の対象パスを分類する: 'dangerous' | 'safe' | 'unknown' */
export function classifyRmTarget(target) {
  const t = target.replace(/\\/g, '/');
  if (t === '' || /^[/~]/.test(t) || /^[A-Za-z]:/.test(t) || t.includes('$') || t.includes('%')) return 'dangerous';
  if (t.includes('*') && !/^[^*]+\/\*$/.test(t)) return 'dangerous';
  const normalized = t.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (normalized === '' || normalized === '.' || normalized === '..') return 'dangerous';
  const parts = normalized.split('/');
  if (parts.includes('..')) return 'dangerous';
  if (parts.includes('.git')) return 'dangerous';
  const last = parts[parts.length - 1] === '*' ? parts[parts.length - 2] : parts[parts.length - 1];
  if (SAFE_RM_TARGETS.has(last)) return 'safe';
  return 'unknown';
}

/** git のサブコマンドと残りの引数を取り出す（-C dir, -c k=v などのグローバルオプションを飛ばす） */
export function parseGit(args) {
  const a = [...args];
  while (a.length && a[0].startsWith('-')) {
    const opt = a.shift();
    if ((opt === '-C' || opt === '-c' || opt === '--git-dir' || opt === '--work-tree' || opt === '--namespace') && a.length) a.shift();
  }
  return { sub: a.shift() || '', rest: a };
}

function result(decision, reason) {
  return { decision, reason };
}

/** 1つのコマンド（単語列）を評価する */
function evaluateWords(rawWords, ctx) {
  const words = stripRedirections(rawWords);
  const w = stripPrefixes(words);
  if (!w.length) return null;
  const cmd = commandName(w[0]);
  const args = w.slice(1);
  const mode = ctx.toolName === 'PowerShell' ? 'PowerShell' : ctx.toolName === 'cmd' ? 'cmd' : 'Bash';
  const isPS = mode === 'PowerShell';
  const viaXargs = words.some((x) => commandName(x) === 'xargs');
  const nested = (command, toolName) => evaluateCommand(command, { ...ctx, toolName }, ctx.depth + 1);

  if (cmd === 'rimraf') {
    const kinds = args.filter((x) => !x.startsWith('-')).map(classifyRmTarget);
    if (!kinds.length) return null;
    if (kinds.includes('dangerous')) return result(DENY, 'rimraf の対象にルート・ホーム・絶対パス・親ディレクトリ・ワイルドカードが含まれるため止めました。');
    if (kinds.every((k) => k === 'safe')) return null;
    return result(ASK, 'rimraf による再帰削除です。対象が正しいか確認してください。');
  }

  if (cmd === 'find') {
    if (args.includes('-delete')) return result(ASK, 'find -delete で一括削除しようとしています。対象を確認してください。');
    const i = args.findIndex((x) => x === '-exec' || x === '-execdir' || x === '-ok');
    if (i >= 0 && ['rm', 'rmdir', 'shred'].includes(commandName(args[i + 1] || ''))) {
      return result(ASK, 'find -exec rm で一括削除しようとしています。対象を確認してください。');
    }
  }

  if (cmd === 'sudo' || cmd === 'doas' || cmd === 'su' || cmd === 'gsudo') {
    return result(DENY, '管理者権限（sudo など）を使うコマンドは Claude に実行させない設定です。必要な場合は人が自分のターミナルで実行してください。');
  }

  // bash -c "..." / bash -lc "..." / sh -ec "..." の中身も検査する
  if (SH_SHELLS.has(cmd)) {
    const i = args.findIndex((x) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
    if (i >= 0) {
      let j = i + 1;
      while (j < args.length && /^(--|[-+][a-zA-Z]+)$/.test(args[j])) j++;
      if (args[j] !== undefined) return nested(args[j], 'Bash');
    }
  }
  // pwsh -Command "..." / powershell -c "..."
  if (PS_SHELLS.has(cmd)) {
    const lower = args.map((x) => x.toLowerCase());
    if (lower.some((x) => x === '-e' || x === '-ec' || (x.length >= 3 && '-encodedcommand'.startsWith(x)))) {
      return result(ASK, 'エンコードされた PowerShell コマンド（-EncodedCommand）は中身を検査できないため確認してください。');
    }
    const i = lower.findIndex((x) => x.length >= 2 && '-command'.startsWith(x));
    if (i >= 0 && args.length > i + 1) return nested(args.slice(i + 1).join(' '), 'PowerShell');
  }
  // cmd /c "..."（Git Bash からは cmd //c と書かれることもある）
  if (cmd === 'cmd') {
    const i = args.findIndex((x) => /^\/\/?[ck]$/i.test(x));
    if (i >= 0 && args.length > i + 1) return nested(args.slice(i + 1).join(' '), 'cmd');
  }
  // eval "..." / Invoke-Expression "..."
  if ((cmd === 'eval' && mode === 'Bash') || (isPS && (cmd === 'invoke-expression' || cmd === 'iex'))) {
    if (args.length) return nested(args.join(' '), ctx.toolName);
  }

  const isRemove = cmd === 'rm' || cmd === 'rmdir' || (isPS && PS_REMOVE.has(cmd)) || (mode === 'cmd' && CMD_REMOVE.has(cmd));
  if (isRemove) {
    const { recursive, force, noPreserveRoot, targets } = parseRemove(args, mode);
    if (noPreserveRoot) return result(DENY, '--no-preserve-root を含む削除コマンドは実行できません。');
    if (isPS && !targets.length) {
      return result(ASK, 'パイプラインから渡されたものを Remove-Item で削除しようとしています。削除対象がコマンドから読み取れないため確認してください。');
    }
    if (recursive || (cmd === 'rmdir' && force)) {
      if (!targets.length) {
        return viaXargs ? result(ASK, 'xargs 経由の再帰削除です。削除対象がコマンドから読み取れないため確認してください。') : null;
      }
      const kinds = targets.map(classifyRmTarget);
      if (kinds.includes('dangerous')) {
        return result(DENY, `再帰削除の対象（${targets.join(' ')}）にルート・ホーム・絶対パス・親ディレクトリ・ワイルドカード・変数・.git が含まれるため止めました。削除が必要なら対象を具体的なプロジェクト内パスに絞るか、人が実行してください。`);
      }
      if (kinds.every((k) => k === 'safe')) return null;
      return result(ASK, `再帰削除です（対象: ${targets.join(' ')}）。生成物ディレクトリ以外を消そうとしています。対象が正しいか確認してください。`);
    }
    return null;
  }

  if (cmd === 'git') {
    const { sub, rest } = parseGit(args);
    if (sub === 'push') {
      const isForce = (x) => x === '--force' || x === '--mirror' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(x) || /^\+/.test(x);
      if (rest.some(isForce)) {
        return result(DENY, '強制プッシュ（--force / -f / +refspec / --mirror）はチームの履歴を壊すおそれがあるため禁止しています。必要なら人が実行してください。');
      }
      if (rest.some((x) => x.startsWith('--force-with-lease') || x.startsWith('--force-if-includes'))) {
        return result(ASK, '--force-with-lease によるプッシュです。リモートの履歴を書き換えてよいか確認してください。');
      }
      if (rest.some((x) => x === '--delete' || x === '-d' || /^:/.test(x))) {
        return result(ASK, 'リモートブランチを削除するプッシュです。削除してよいか確認してください。');
      }
      return null;
    }
    if (sub === 'reset' && rest.includes('--hard')) {
      return result(DENY, 'git reset --hard はコミットしていない変更を消すため禁止しています。git stash で退避するか、人が実行してください。');
    }
    if (sub === 'clean' && rest.some((x) => x === '--force' || (/^-[a-zA-Z]+$/.test(x) && x.includes('f')))) {
      return result(DENY, 'git clean -f は追跡していないファイルを完全に削除するため禁止しています。git clean -n で対象を確認し、人が実行してください。');
    }
    if (sub === 'filter-branch' || sub === 'filter-repo') {
      return result(DENY, '履歴の書き換え（filter-branch / filter-repo）は禁止しています。');
    }
    // git diff / log / show は settings.json で確認なしにしているが、--output はファイルを書き出す
    if (['diff', 'log', 'show', 'format-patch'].includes(sub) && rest.some((x) => /^--output(-directory)?(=|$)/.test(x) || (sub === 'format-patch' && x === '-o'))) {
      return result(ASK, `git ${sub} の --output はファイルを書き出します。書き出し先が正しいか確認してください。`);
    }
    if ((sub === 'checkout' || sub === 'restore') && rest.some((x) => x === '.' || x === ':/' || x === '*')) {
      return result(ASK, '作業中の変更をまとめて元に戻すコマンドです。消えてよい変更か確認してください。');
    }
    if (sub === 'stash' && (rest[0] === 'drop' || rest[0] === 'clear')) {
      return result(ASK, 'stash を削除するコマンドです。退避した変更が不要か確認してください。');
    }
    if (sub === 'branch' && rest.some((x) => x === '-D' || (x === '--delete' && rest.includes('--force')))) {
      return result(ASK, 'ブランチを強制削除するコマンドです。マージ前の作業が消えてよいか確認してください。');
    }
    return null;
  }

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) && (args[0] === 'publish' || args[0] === 'unpublish')) {
    return result(DENY, 'パッケージの公開（publish / unpublish）は Claude に実行させない設定です。');
  }

  if (cmd === 'chmod' && args.some((x) => /^-[a-zA-Z]*R/.test(x) || x === '--recursive') && args.some((x) => /^0?777$/.test(x))) {
    return result(DENY, 'chmod -R 777 は権限を広げすぎるため禁止しています。');
  }

  if (/^mkfs/.test(cmd) || cmd === 'shutdown' || cmd === 'reboot' || cmd === 'halt' || cmd === 'poweroff' || cmd === 'format') {
    return result(DENY, 'システムを変更・停止するコマンドは実行できません。');
  }
  if (cmd === 'dd' && args.some((x) => /^of=\/dev\//.test(x))) {
    return result(DENY, 'デバイスへの直接書き込み（dd of=/dev/...）は実行できません。');
  }

  // .env 系ファイルを読む・持ち出すコマンド
  if (READER_COMMANDS.has(cmd)) {
    if (args.some(isEnvFileToken)) {
      return result(DENY, '.env 系ファイルには API キーなどの秘密情報が入るため、Claude に読ませない設定です。必要な変数名は .env.example を参照してください。');
    }
    if (args.some((x) => globMayMatchEnv(x, isPS))) {
      return result(ASK, 'ワイルドカードが .env 系ファイルに一致するおそれがあります。読み取る対象を確認してください。');
    }
  }

  if ((cmd === 'printenv' || cmd === 'env' || cmd === 'set' || cmd === 'export') && args.length === 0) {
    return result(ASK, '環境変数の一覧を出力しようとしています。API キーなどが表示されるおそれがあるため確認してください。');
  }

  return null;
}

const SEVERITY = { [DENY]: 3, [ASK]: 1 };

function pickStrongest(results) {
  let best = null;
  for (const r of results) {
    if (!r) continue;
    if (!best || SEVERITY[r.decision] > SEVERITY[best.decision]) best = r;
  }
  return best;
}

/** コマンド文字列全体を評価する。戻り値: { decision: 'deny'|'ask', reason } または null */
export function evaluateCommand(rawCommand, ctx = { toolName: 'Bash', depth: 0 }, depth = 0) {
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) return null;
  const toolName = ctx.toolName || 'Bash';
  const c = { ...ctx, toolName, depth };
  if (depth > 3) return result(ASK, 'コマンドの入れ子が深すぎて検査できませんでした。内容を確認してください。');
  const { command, shellBodies } = toolName === 'cmd' ? { command: rawCommand, shellBodies: [] } : splitHeredocs(rawCommand);

  const found = [];

  // curl / wget の結果をそのままシェルに流す
  if (/\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^;&\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/i.test(command) ||
      /\b(irm|iwr|invoke-restmethod|invoke-webrequest)\b[^;&\n]*\|\s*(iex|invoke-expression)\b/i.test(command)) {
    found.push(result(DENY, 'ネットから取得したスクリプトをそのまま実行する操作（curl | sh など）は禁止しています。内容を確認してから人が実行してください。'));
  }

  // データベースを消す・作り直す操作
  if (/\bprisma\s+migrate\s+reset\b/.test(command) || /--force-reset\b|--accept-data-loss\b/.test(command) || /\bdrizzle-kit\s+drop\b/.test(command)) {
    found.push(result(ASK, 'データベースの中身を消す・作り直す操作です。接続先（DATABASE_URL）が開発用か確認してください。'));
  }
  if (/\b(psql|mysql|sqlite3|mongosh)\b/.test(command) && /\b(drop\s+(table|database|schema)|truncate\s)/i.test(command)) {
    found.push(result(ASK, 'DROP / TRUNCATE を含むデータベース操作です。接続先と対象を確認してください。'));
  }

  // bash <<'EOF' … EOF のように、シェルに渡しているヒアドキュメントの中身
  for (const body of shellBodies) {
    found.push(evaluateCommand(body, c, depth + 1));
  }

  if (toolName !== 'cmd') {
    for (const inner of extractSubstitutions(command)) {
      found.push(evaluateCommand(inner, c, depth + 1));
    }
  }

  for (const seg of splitSegments(command, toolName)) {
    found.push(evaluateWords(tokenize(seg, toolName), c));
  }

  // 読み出し系でなくても .env に触れるコマンドは確認を挟む
  if (!found.some((r) => r && r.decision === DENY) && mentionsEnvFile(command)) {
    found.push(result(ASK, 'コマンドが .env 系ファイルに触れています。秘密情報を読み出したり書き換えたりしないか確認してください。'));
  }

  return pickStrongest(found);
}

export function buildOutput(evaluation) {
  if (!evaluation) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: evaluation.decision,
      permissionDecisionReason: `[guard-bash] ${evaluation.reason}`,
    },
  };
}

function main() {
  let input;
  try {
    const raw = readFileSync(0, 'utf8');
    input = JSON.parse(raw || '{}');
  } catch {
    // 入力を読めないときは止めずに人へ確認を回す
    process.stdout.write(JSON.stringify(buildOutput(result(ASK, 'フックの入力を解析できなかったため、念のため確認を求めています。'))));
    return;
  }
  const toolName = input.tool_name === 'PowerShell' ? 'PowerShell' : 'Bash';
  const command = input.tool_input && input.tool_input.command;
  const evaluation = evaluateCommand(command, { toolName, depth: 0 });
  const out = buildOutput(evaluation);
  if (out) process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
