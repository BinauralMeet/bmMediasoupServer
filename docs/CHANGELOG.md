# CHANGELOG — bmMediasoupServer の変更履歴

**いつ読むか**: いつ・なぜ今の状態になったか調べる / 過去の動作確認の記録を探す /
変更を加えたので追記する

日付が付く記録はここに。現在形の事実は各 topic README へ。

## 2026-08-05 — `GET /room/:roomId`の利用者情報漏洩を修正 {#2026-08-05-rest-leak-fix}

このREST監視エンドポイント(認証無し)が`peers`/`participants`として
peer id・participant id(利用者の表示名由来の識別子)をそのまま返していた。
部屋名を知っている/推測できれば誰でも中の利用者を識別できてしまうため、
`/room`(一覧)と同じ形に揃え、件数(`nPeers`/`nParticipants`)のみを返すように
変更(`src/rest.ts`)。`contents`(共有コンテンツid)は変更なし。既存の
クライアント(binaural-meet/vrcss)はこのエンドポイントを呼んでおらず、
影響なし。

## 2026-08-05 — docsを新設 {#2026-08-05-docs-added}

このリポジトリには`docs/`が無く、`README.md`もサーバー構成の実体(main/media
2プロセス構成、RTSP配信パイプライン)を反映していなかった。`docs/bin`
(doc-tool)を導入し、コードを読んで`architecture`/`rtsp-streaming`の2トピックを
新設。`README.md`にあった`ROOM_PROP`メッセージ処理の説明は`architecture`に移し、
sandbox固有のLinux/ポートフォワーディング事情(親workspace `bm/`の
`dev-environment`トピックに既に書かれている内容)は重複を避けて`README.md`から
削った。
