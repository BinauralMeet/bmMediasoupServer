# CHANGELOG — bmMediasoupServer の変更履歴

**いつ読むか**: いつ・なぜ今の状態になったか調べる / 過去の動作確認の記録を探す /
変更を加えたので追記する

日付が付く記録はここに。現在形の事実は各 topic README へ。

## 2026-08-05 — docsを新設 {#2026-08-05-docs-added}

このリポジトリには`docs/`が無く、`README.md`もサーバー構成の実体(main/media
2プロセス構成、RTSP配信パイプライン)を反映していなかった。`docs/bin`
(doc-tool)を導入し、コードを読んで`architecture`/`rtsp-streaming`の2トピックを
新設。`README.md`にあった`ROOM_PROP`メッセージ処理の説明は`architecture`に移し、
sandbox固有のLinux/ポートフォワーディング事情(親workspace `bm/`の
`dev-environment`トピックに既に書かれている内容)は重複を避けて`README.md`から
削った。
