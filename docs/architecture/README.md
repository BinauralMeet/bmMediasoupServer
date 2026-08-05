# architecture — main/mediaサーバー構成とクライアントプロトコル

**いつ読むか**: `src/MainServer/`・`src/MediaServer/`・`src/DataServer/`のどこに
何を書けばいいか迷う / `main.ts`と`media.ts`の関係を確認する / クライアント
(binaural-meet/vrcss)との通信プロトコルを確認する

`main.ts`(ゲートウェイ)と`media.ts`(mediasoup worker)という**2つの別プロセス**
で構成される。クライアントは`binaural-meet`と`vrcss`の2つ(いずれも同じ
mediasoupシグナリングプロトコルを話す。`vrcss`はデータ同期・位置情報の
チャンネルを使わない縮小サブセット)。

## 構成 {#arch}

### main.ts / media.ts の関係

- **`main.ts`にmediasoupのコードは一切無い**。HTTP(S)+WebSocketサーバーと
  `rest.ts`のREST API(監視用)を立て、peer(クライアント)⇄worker間のメッセージを
  中継するだけの**ゲートウェイ**(`MainServer/mainServer.ts:14-22`の
  コメントが明記: "main server only for signaling")。
- **`media.ts`が実際のSFU**。`mediasoup.createWorker()`+routerを1つ持ち、
  `transports`/`producers`/`consumers`を保持する。
- `media.ts`が`config.mainServer`(`ws://`/`wss://`)へ**自分から**接続し、
  `workerAdd`メッセージで自己登録する(`media.ts:369-371`,
  `MainServer/mainServer.ts`の`workers`マップ)。
- **1つのmainに対してmediaは複数台ぶら下げられる設計**(`mainServer.ts:14-22`:
  「media server 1がproducer1を持ち、media server 2がproducer2を持つ」)。
  main.tsは`getVacantWorker()`(`MainServer/types.ts:20-26`)で
  **最も負荷(`workerUpdate`で報告される`load`)が低いworker**を選び、
  以後そのpeerに関する全シグナリングをそのworkerへ中継する
  (`MainServer/handlers.ts`の`setRelayHandlers`)。
- 現在の`bm/`ワークスペースの実運用では`yarn main`/`yarn media`を1台ずつ
  起動する構成(`docs/dev-environment`参照)だが、コード上は複数`media.ts`を
  同時に繋いで負荷分散する前提で書かれている。

### サブシステム

| ディレクトリ | 役割 |
|---|---|
| `MainServer/` | ゲートウェイ本体。`mainServer.ts`(peer/room/worker登録・キュー)、`handlers.ts`(メッセージ型ごとのハンドラ+peer⇄worker中継)、`types.ts`(`Peer`/`Room`/`MedServer`、`getVacantWorker`)、`mainLogin.ts`(Google Driveから読む部屋ログイン設定) |
| `MediaServer/` | `media.ts`専用。mediasoupシグナリングのワイヤーフォーマット定義(`MediaMessages.ts`、binaural-meetから生成 — 下記参照)、`Peers.ts`(worker側のpeerごとのtransport管理)、RTSP配信パイプライン(`rtsp-streaming`参照) |
| `DataServer/` | mediaと無関係な**別のシグナリングチャンネル**。チャット・pose・マウス位置・共有コンテンツ・`ROOM_PROP`等(`dataServer.ts`、`DataMessageType.ts`) |
| `PositionServer/` | 現状23行のスタブ。`positionConnect`を受けると円運動するダミーの`position`/`orientation`を500ms毎に送るだけで、実際のクライアント入力には基づかない |
| `GoogleServer/` | Google Drive OAuth2連携。部屋ログイン用の設定ファイル読み書き、admin追加/ファイルアップロード |

`MediaMessages.ts`・`DataMessageType.ts`はファイル先頭のコメントの通り
`binaural-meet/src/models/conference/`から`getSourceFromBM.sh`で**生成**される
(手で編集しない)。`vrcss`も同じファイルをコピーして使っており
(`vrcss`側の`copySource.sh`)、3リポジトリで同じワイヤーフォーマットを
共有している。

### クライアントとの通信

1つのWebSocket(`httpIp`/`httpPort`、または`useHttp`ならプレーンHTTP経由)で、
最初のメッセージの`type`によって用途が決まる(`main.ts`):

- `preConnect` → 部屋ログイン要否の確認
- `connect`→`join`→mediasoupハンドシェイク(`rtpCapabilities`/`createTransport`/
  `connectTransport`/`produceTransport`/`consumeTransport`/`resumeConsumer`/
  `restartIce`/`closeProducer`等)。これらは全てmain.tsが該当workerへ中継する。
- `dataConnect` → `DataServer`のチャット/pose/共有コンテンツ等の同期チャンネル
- `positionConnect` → `PositionServer`(スタブ)

**`vrcss`はmediasoupハンドシェイクのチャンネルしか使わない**。`dataConnect`/
`positionConnect`は一切開かず、`preConnect`の応答も待たない(vrcss側
`RtcConnection.ts`のコメント: 「現状のbmMediasoupServerは`preConnect`を実装して
おらず応答が来ないので、ログイン不要と仮定して進める」)。`binaural-meet`は
3チャンネルとも使う。

#### `ROOM_PROP`メッセージの特殊扱い

`ROOM_PROP`は複数の異なる部屋プロパティを`[name, value]`タプルとして多重化する
唯一の`MessageType`(他の型は「1種類の状態を表し、キュー内で最新のものが勝てば
良い」という前提)。`ParticipantStore.pushOrUpdateMessage()`
(`DataServer/Stores.ts`)は`mergeKeyExtra`を受け取り、連続してキューされた
別プロパティが送信前に同じ`(type, peer)`キューのスロットで衝突・上書きされる
のを防ぐ。`dataServer.ts`の`ROOM_PROP`ハンドラだけがこれを渡す唯一の呼び出し元。
これはbinaural-meetの`DataConnection.ts`の`sendMessage()`側にある同種の修正と
対になっており、ワイヤーフォーマットは変更せず両側の実装だけを一致させて
解決した(両者は検証済み)。

## セキュリティ上の要点 {#security}

- 部屋ログインの要否・admin管理はGoogle Drive上の設定ファイル
  (`mainLogin.ts`/`GoogleServer.ts`)に依存する。
- `rest.ts`(`/room`, `/peer`, `/load`, `/server/streams`)は認証無しの監視用
  エンドポイント — 外部に直接晒す想定ではない。いずれも件数・状態のみを返し、
  部屋名や利用者を識別できる値(peer id・participant id)は返さない
  (`CHANGELOG#2026-08-05-rest-leak-fix`)。

## 運用 {#ops}

- `yarn main` / `yarn media`(`README.md`参照)。`workerWebsocketTimeout`
  (既定15秒)でworkerのping/pong切れを検出、`websocketTimeout`(既定60秒)で
  無通信peerを切断する。
- worker選択は`load`の低い順(`getVacantWorker()`)。`workerUpdate`メッセージで
  各`media.ts`が自分の`load`を報告する。
- sandbox上でのLinux運用(`useHttp`、mediasoupのUDPポートリース更新等)は
  この繰り返しになるので`bm/`ワークスペースの`dev-environment`トピックを参照
  (このリポジトリ単体の話ではないため)。

## 既知の制限 {#limits}

- `PositionServer`はダミー実装で、実際の位置情報連携は無い。
- worker(`media.ts`)間の負荷分散はロードの数値比較のみで、地理的近さや
  他の要因は考慮しない。
