---
paths:
  - "app/**/*.{ts,tsx}"
  - "src/app/**/*.{ts,tsx}"
  - "components/**/*.{ts,tsx}"
  - "src/components/**/*.{ts,tsx}"
---

# Next.js（App Router）のルール

このファイルは、上の paths に一致するファイルを Claude が読み書きするときだけ読み込まれます。

- コンポーネントは Server Component を基本にする。`"use client"` は state・イベントハンドラ・ブラウザ API が必要な末端のコンポーネントにだけ付ける。
- データベースや秘密情報を扱うモジュールは、Client Component から import しない。
- Server Action とルートハンドラ（`route.ts`）では、入力値を検証してから使う。認証が必要な処理では、ログインと権限を確認する（問い合わせフォームのような公開の処理には、ログイン確認を足さない）。
- 画像は `next/image` を使い、`<img>` は使わない。内部リンクは `next/link` を使い、内部遷移に `<a href>` は使わない。
- ページごとのタイトルと説明文は `metadata` または `generateMetadata` で設定する。
- 環境変数のうち `NEXT_PUBLIC_` で始まるものはブラウザに公開される。秘密情報には付けない。
