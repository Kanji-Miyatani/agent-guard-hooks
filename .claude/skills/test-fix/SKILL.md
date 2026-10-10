---
name: test-fix
description: lint・型チェック・テストを実行し、失敗している箇所を最小限の変更で直す。直せないものは原因と次の手を報告する。
argument-hint: "[対象のテストファイルやテスト名（省略可）]"
disable-model-invocation: true
allowed-tools: Bash(npm run lint *) Bash(npm run typecheck *) Bash(npm run test *) Bash(npm test *) Bash(pnpm lint *) Bash(pnpm typecheck *) Bash(pnpm test *) Bash(pnpm run lint *) Bash(pnpm run typecheck *) Bash(pnpm run test *) Bash(git status *) Bash(git diff *)
---

## 対象

$ARGUMENTS
（空欄の場合はプロジェクト全体）

## 手順

1. CLAUDE.md の「よく使うコマンド」に書かれた lint・型チェック・テストのコマンドを確認する。書かれていなければ package.json の scripts から選ぶ。
2. lint → 型チェック → テストの順に実行し、失敗を一覧にする。対象が指定されていればそのテストだけを実行する。
3. 失敗ごとに原因を特定してから直す。次のことは守る。
   - テストを通すためだけにテストを削除・スキップ（`.skip`、`it.only` の放置など）しない
   - 期待値を書き換えるのは、仕様が変わったと確認できたときだけ。その場合は理由を報告に書く
   - `any`、`// @ts-ignore`、`eslint-disable` で問題を隠さない
   - 依存パッケージの追加・更新はしない（必要なら報告して人に判断してもらう）
4. 修正したら、同じコマンドをもう一度実行して通ることを確認する。修正と再実行は最大3回まで。
5. 3回で直らないものは、それ以上触らずに報告する。

## 報告の形式

- 実行したコマンドと結果（成功/失敗の件数）
- 直したもの: `ファイルパス` 何を・なぜ直したか
- 直せなかったもの: エラー内容の要約、考えられる原因、人に確認したいこと
