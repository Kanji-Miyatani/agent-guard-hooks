<!--
  CLAUDE.md テンプレート（Next.js / TypeScript の Web 制作プロジェクト向け）
  - 【記入：...】の部分を、あなたのプロジェクトの内容に書き換えてください。
  - 使わない項目は行ごと削除してください。空欄のまま残すと Claude が迷います。
  - この囲みのような HTML コメントは Claude には読み込まれません。チーム向けのメモに使えます。
  - 200 行以内を目安に保ってください。長い手順は .claude/skills/ に、特定のフォルダだけのルールは .claude/rules/ に分けます。
-->

# 【記入：プロジェクト名】

## プロジェクトの概要

- 目的: 【記入：例）中小企業向けコーポレートサイトと採用ページ】
- 利用者: 【記入：例）一般の閲覧者、社内の更新担当者】
- 本番 URL: 【記入：例）https://example.com（Claude に操作させない）】
- 主な機能: 【記入：例）お知らせ一覧・詳細、問い合わせフォーム、採用エントリー】

## 技術構成

- フレームワーク: Next.js 【記入：バージョン】（App Router）
- 言語: TypeScript（strict）
- スタイル: 【記入：例）Tailwind CSS / CSS Modules】
- データ取得: 【記入：例）ヘッドレス CMS の API、Prisma + PostgreSQL】
- テスト: 【記入：例）Vitest（単体）、Playwright（E2E）】
- パッケージマネージャー: 【記入：npm / pnpm】
- Node.js: 【記入：例）22 系（.nvmrc を参照）】
- デプロイ先: 【記入：例）Vercel / Railway など】（デプロイは人が行う）

## ディレクトリ構成

<!-- tree -L 2 -I node_modules の結果などを参考に、主要なものだけ書く -->
- `app/`: ルーティングとページ（App Router）
- `components/`: 共通 UI コンポーネント
- `lib/`: API クライアント、ユーティリティ
- `public/`: 画像などの静的ファイル
- `tests/`: 【記入：テストの置き場所】

## よく使うコマンド

<!-- package.json の scripts に合わせて書き換える。Claude はここに書かれたコマンドを優先して使う -->
- 開発サーバー: `npm run dev`
- lint: `npm run lint`
- 型チェック: `npm run typecheck`（中身は `tsc --noEmit`）
- テスト: `npm run test`
- ビルド: `npm run build`

作業を終える前に、lint・型チェック・テストを実行し、すべて通ることを確認する。

## コーディングルール

- TypeScript は strict のまま使う。`any`・`// @ts-ignore`・`eslint-disable` で問題を隠さない。
- コンポーネントは Server Component を基本にし、`"use client"` は必要な末端だけに付ける。
- 関数とコンポーネントは名前付き export にする（ページなど Next.js が default export を求めるファイルは除く）。
- ファイル名: コンポーネントは `PascalCase.tsx`、それ以外は `kebab-case.ts`。
- 文言（画面に出る日本語）は 【記入：例）各コンポーネントに直接書く / `lib/messages.ts` に集める】。
- 日付は 【記入：例）date-fns を使い、表示は日本時間（Asia/Tokyo）】。
- 新しい依存パッケージを追加する前に、理由を説明して確認を取る。

## やること（Do）

- 変更は小さく分け、1つの作業で関係のないファイルを触らない。
- 振る舞いを変えたら、テストを追加または更新する。
- 不明点や仕様の判断が必要な点は、作業を進める前に質問する。
- コミットメッセージは 【記入：例）Conventional Commits（feat: / fix: / docs: ...）、日本語可】。

## やらないこと（Don't）

- `.env` や `.env.local` などの環境変数ファイルを読まない・書かない。必要な変数名は `.env.example` を見る。
- `git push`、本番環境へのデプロイ、データベースのリセットを自分の判断で行わない。
- ロックファイル（`package-lock.json` / `pnpm-lock.yaml`）を手で書き換えない。
- テストを通すためだけにテストを削除・スキップしない。
- 本番 URL や本番データベースに対して操作しない。

## 補足

- チームのレビュー観点: `/team-review` を実行する。
- Next.js のフォルダ別ルール: `.claude/rules/nextjs-app-router.md`（app/ や components/ を触るときに自動で読み込まれる）。
- テストのルール: `.claude/rules/testing.md`。
- 【記入：その他、新しく入った人に毎回説明していること】
