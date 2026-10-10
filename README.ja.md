# agent-guard-hooks

[![test](https://github.com/Kanji-Miyatani/agent-guard-hooks/actions/workflows/test.yml/badge.svg)](https://github.com/Kanji-Miyatani/agent-guard-hooks/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md)

Next.js / TypeScript のリポジトリで、AIコーディングエージェントの Claude Code を安全に動かすためのフック、権限ルール、テストです。フックは Node.js のスクリプトだけで動き、追加の依存はありません。テストは149件あります。

> **非公式です。** このリポジトリは個人が作ったもので、Anthropic 社の公式な製品ではなく、同社とは関係がありません。Claude と Claude Code は Anthropic 社の商標です。
>
> 導入の手順、権限モードの選び方、困ったときの対処は、Zenn の無料の本にまとめています: [AIコーディングエージェントの安全な初期設定](https://zenn.dev/yakankun/books/claude-code-starter-kit-nextjs)

## 何を止めるか

| フック | 動くとき | すること |
|---|---|---|
| `guard-bash.mjs` | `PreToolUse`（`Bash` と `PowerShell`） | 実行する前にシェルのコマンドを調べる。危険なものは禁止し、注意が要るものは確認を求める |
| `guard-files.mjs` | `PreToolUse`（`Edit`、`Write`、`NotebookEdit`） | 触らせたくないファイルの書き換えを止める |
| `format-lint.mjs` | `PostToolUse`（`Edit` と `Write`） | 書き換えた直後に、そのファイルだけをプロジェクトの Prettier で整形し、ESLint で調べる。ESLint のエラーは Claude に返し、直させる。Prettier と ESLint が入っていなければ何もしない |
| `session-context.mjs` | `SessionStart` | 今のブランチ、コミットしていないファイルの数、パッケージマネージャーを Claude に伝える |

**`guard-bash` が禁止するコマンド:**

- `sudo`
- 再帰的な削除のうち、対象がルート、ホーム、絶対パス、親ディレクトリ、ワイルドカード、変数、`.git` のもの。`node_modules`、`.next`、`dist` などの生成物は消してよい。それ以外の再帰的な削除は確認を求める
- 強制プッシュ（`--force`、`-f`、`+refspec`、`--mirror`）
- `git reset --hard`、`git clean -f`、`git filter-branch`、`git filter-repo`
- `npm`、`pnpm`、`yarn`、`bun` の `publish` と `unpublish`
- `chmod -R 777`
- ダウンロードしたスクリプトをそのままシェルに渡す操作（`curl … | sh`、`irm … | iex` など）
- `.env` 系のファイルを読む操作（`cat .env.local` など）。`.env.example` は読んでよい
- `shutdown`、`reboot`、`mkfs`、`dd of=/dev/…`

**`guard-bash` が確認を求めるコマンド:**

- `--force-with-lease` でのプッシュ
- リモートのブランチの削除
- `git checkout -- .` と `git restore .`
- `git stash drop` と `git branch -D`
- `find -delete`
- 環境変数をすべて表示する操作
- `prisma migrate reset`
- `psql` などを使った `DROP` と `TRUNCATE`
- PowerShell の `-EncodedCommand`

`guard-bash` は、次の書き方の中にあるコマンドも調べます。

- `&&`、`||`、`;`、`|`、`&` でつないだコマンド
- サブシェル、`$( … )`、バッククォート
- `bash -c`、`eval`、`xargs`
- シェルに渡すヒアドキュメント
- PowerShell の `-Command` と `Invoke-Expression`
- `cmd /c`

**`guard-files` が書き換えを止めるファイル:**

- `.env` 系のファイル（`.env.example` は除く）
- 秘密鍵
- `.git/`、`node_modules/`、`.next/` の中のファイル
- ロックファイル
- `next-env.d.ts`

`.claude/settings.json` と `.claude/hooks/` を書き換える前には、確認を求めます。

**`.claude/settings.json`** は、上の4つのフックを登録しています。そのほかに、次の設定があります。

- 許可するコマンド: 読み取りだけの git コマンド、lint、型チェック、テスト、ビルド
- 確認を求めるコマンド: `git push`、パッケージの追加、`npx`、`curl`、デプロイ用の CLI など
- 禁止する操作: `.env` 系のファイル、鍵、`~/.ssh`、`~/.aws` の読み取りなど
- 権限の確認を飛ばすモードを使えなくする設定（`disableBypassPermissionsMode`）

このほかに、次のものも入っています。

- スキル4つ: `/team-review`、`/test-fix`、`/pr-description`、`/explain`
- ファイルを書き換えるツールを持たない、レビュー用のサブエージェント
- App Router のフォルダとテストのフォルダで読み込まれるルール

### 限界

文字列で調べているだけなので、完全な防御ではありません。書き方を変えたコマンドは、すり抜けることがあります。禁止ルール、サンドボックス、バックアップと組み合わせて使ってください。

## 動作環境

- Claude Code（2.1.295 で確認）
- Node.js 22 または 24。Node.js 20 でもテストは合格しますが、2026年4月30日にサポートが終わっています
- git

## 入れ方

プロジェクトのルートで、次のコマンドを実行します。Windows では、Git for Windows に付いている Git Bash で実行してください。

```bash
tmp=$(mktemp -d)
git clone --depth 1 https://github.com/Kanji-Miyatani/agent-guard-hooks.git "$tmp"
cp -r "$tmp/.claude" .
[ -e CLAUDE.md ] || cp "$tmp/templates/CLAUDE.md" CLAUDE.md
cat "$tmp/templates/gitignore-additions.txt" >> .gitignore
rm -rf "$tmp"
```

> **すでに `.claude/settings.json` があるプロジェクトでは、** `cp -r` で上書きされます。先に今のファイルを別の場所に保存し、あとで2つを手で合わせてください。`CLAUDE.md` は、すでにあれば上書きしません。

1. `CLAUDE.md` の空欄（`【記入：…】`）を埋め、使わない行を消します。
2. プロジェクトの中で、フックのテストを実行します。

   ```bash
   node --test .claude/hooks/__tests__/hooks.test.mjs
   ```

   148件が合格し、1件が省略されれば正常です。省略されるのは `examples/` を調べるテストで、`examples/` はプロジェクトにコピーしないためです。
3. Claude Code を起動して `/hooks` を実行し、4つのフックが登録されていることを確かめます。

Git for Windows を入れていない Windows では、Claude Code は PowerShell を使います。この場合、`settings.json` の `Bash(...)` のルールは効きません。`examples/settings.local.powershell.example.json` を `.claude/settings.local.json` としてコピーしてください。フックは PowerShell のコマンドも調べます。

## 確かめたこと

- **単体テスト。** Claude Code が渡すのと同じ形の JSON を各フックに渡し、終了コードと出力を確かめます。Linux 上の Node.js 20.20.0、22.22.0、24.21.0 で、149件すべてが合格しました。GitHub Actions でも、Linux、macOS、Windows で同じテストを実行しています。最新の結果は、上のバッジで分かります。
- **実際の Claude Code での確認。** 2026年10月10日に、試験用のリポジトリで Claude Code 2.1.295 をヘッドレス（`claude -p`）で動かしました。結果は次のとおりです。
  - `git push --force origin main` は、実行の前に guard-bash が止めた
  - `.env.local` への書き込みは、設定の禁止ルールが止めた
  - format-lint が、ESLint の構文エラーを Claude に返した
  - session-context が、ブランチ名を Claude に伝えた

**まだ確かめていないこと:**

- 対話画面での動き
- 実際の Next.js のアプリでの動き
- macOS と Windows の Claude Code の中で、フックを動かすこと

## リポジトリの中身

| パス | 中身 | プロジェクトにコピーするか |
|---|---|---|
| `.claude/settings.json` | 権限ルールとフックの登録 | する |
| `.claude/hooks/` | 4つのフックと、そのテスト | する。テストは消してもよい |
| `.claude/skills/`、`.claude/agents/`、`.claude/rules/` | スキル、レビュー用のサブエージェント、フォルダ別のルール | する。使わないものは消す |
| `templates/CLAUDE.md` | プロジェクトの説明とルールのテンプレート | `CLAUDE.md` としてコピーする |
| `templates/gitignore-additions.txt` | `.gitignore` に足す行 | `.gitignore` に追記する |
| `examples/` | 個人用の設定の例（PowerShell 用のルールを含む） | 必要なら `.claude/settings.local.json` としてコピーする |

## 自分たちに合わせて変える

- 守るファイルは、`.claude/hooks/guard-files.mjs` の `PROTECTED_RULES` で変えます。
- 消してよい生成物のフォルダは、`.claude/hooks/guard-bash.mjs` の `SAFE_RM_TARGETS` で変えます。
- 変えたら、毎回テストを実行してください。

## ライセンス

[MIT](LICENSE)
