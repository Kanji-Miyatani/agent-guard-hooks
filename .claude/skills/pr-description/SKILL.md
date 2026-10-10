---
name: pr-description
description: 現在のブランチの変更から、日本語のプルリクエスト説明文（概要・変更点・確認方法・影響範囲）を下書きする。PR の作成や push はしない。
argument-hint: "[比較元ブランチ（省略時は main）]"
disable-model-invocation: true
allowed-tools: Bash(git status *) Bash(git diff *) Bash(git log *) Bash(git branch --show-current) Read Grep Glob
---

## 手順

1. 比較元ブランチを決める。指定: $ARGUMENTS （空欄なら `main`。存在しなければ `master` を使う）
2. 次のコマンドで変更内容を把握する。
   - `git branch --show-current`
   - `git log --oneline <比較元>..HEAD`
   - `git diff --stat <比較元>...HEAD`
   - 必要に応じて `git diff <比較元>...HEAD -- <ファイル>` で中身を読む
3. 下のテンプレートを埋めた Markdown を出力する。推測で書いた部分には「（要確認）」と付ける。
4. プルリクエストの作成、push、コミットはしない。出力した文章は人が確認してから貼り付ける。

## テンプレート

```markdown
## 概要
<!-- 何のための変更か。1〜3行 -->

## 変更点
- 

## 確認方法
<!-- レビュアーが手元で確かめる手順。コマンドや画面の操作 -->
1. 

## 影響範囲
<!-- 影響する画面・API・データ。影響しない範囲も書けると親切 -->

## スクリーンショット
<!-- 画面の変更がある場合のみ。人が貼り付ける -->

## レビューで特に見てほしい点

## 関連
<!-- Issue 番号など -->
```
