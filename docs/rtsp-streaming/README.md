# rtsp-streaming — mediasoupトラックをRTSPへ変換して配信する機能

**いつ読むか**: `MediaServer/streaming.ts`/`ffmpeg.ts`/`sdp.ts`/`port.ts`に触る /
RTSP配信が始まらない・映像が出ない原因を調べる / `vrcss`(VRChatへの画面共有)が
何を前提にこのサーバーを使っているか確認する

このサーバー自体はRTSPサーバーを持たない。mediasoupで受信したProducerの
RTPを外部の**MediaMTXサーバー(別プロセス、このリポジトリの管轄外)へ
ffmpeg経由でpushする**だけの機能。現在の唯一の利用者は`vrcss`(VRChatの
ビデオプレイヤーへ画面共有を配信するツール)。

## 構成 {#arch}

- トリガーはメッセージ駆動のみ。クライアントが`streamingStart`
  (`{id, producers: string[]}`)を送ると`media.ts`が`streaming.ts`の
  `streamingStart(router, msg)`を呼ぶ(部屋やProducerが出来ても自動的には
  始まらない)。main.tsは`streamingStart`/`streamingStop`をそのままworkerへ
  中継するだけ(`MainServer/handlers.ts`の`setRelayHandlers`)。
- 指定された各Producerについて`publishProducer()`が個別に`PlainTransport`を
  作り(`config.mediasoup.plainTransport`)、`port.ts`の`getPort()`
  (20000-30000番から採番)でローカルUDPポートを確保、ProducerのRTPをその
  PlainTransportへconsumeする。
- 全Producerの用意ができたら、`sdp.ts`の`createSdpText()`が組み立てたSDPを
  ffmpeg(または`PROCESS_NAME`定数で選べるgstreamer、既定はffmpeg)の標準入力へ
  流し込み、`ffmpeg.ts`の`_commandArgs`が組んだコマンドで
  `rtsp://localhost/<id>`へpublishする(`<id>`は`streamingStart`で渡された`id`
  そのもの、ホスト名は決め打ちの`localhost` — **MediaMTXがこのサーバーと同じ
  ホストで動いている前提**。`config.js`には行き先を変える設定項目は無い)。
- 3秒ごとにconsumerを`resume()`し、キーフレームを要求する
  (`streaming.ts`)。
- **1つの`media.ts`プロセス内でしか動かない**: `streaming.ts`は
  `import {producers} from '../media'`で当該workerの`producers`マップを直接
  参照している。複数worker構成(`architecture#arch`)であっても、配信対象の
  Producerが載っているworker上でしか`streamingStart`は機能しない。

## セキュリティ上の要点 {#security}

- `streamingStart`の送信元(peer)がそのProducerの所有者かどうかは
  コード上チェックしていない。他人のProducer idを指定して配信を開始できる
  かどうかは未検証。

## 既知の制限 {#limits}

- **映像コーデックはH264でなければ`-c:v copy`(無変換)が失敗/不正なRTSPに
  なる**(`ffmpeg.ts`の`_videoArgs`)。VP8で送られたProducerを指定すると
  正しく配信されない可能性が高い。`vrcss`側はこれを踏まえ、画面共有の
  Producer作成時に明示的にH264(`profile-level-id=4d001f`)を指定している。
- 音声は`aac`へ変換される(`_audioArgs`、mediasoup側はopusなので必ず変換が
  入る)。
- MediaMTX(または互換のRTSPサーバー)がこのサーバーと同じホストで稼働している
  ことが前提で、ホスト名は設定できない(`rtsp://localhost/...`固定)。
- `RECORD_FILE_LOCATION_PATH`という環境変数が参照されているが
  (`ffmpeg.ts`)、現在の配信経路(`-f rtsp`出力)では使われていない
  (録音・録画用途の名残と見られる)。

## 設計判断の記録 {#design}

- **このサーバー自身はRTSPサーバーを実装しない**。ffmpegを子プロセスとして
  spawnし外部のMediaMTXへpushする側に回ることで、RTSP自体のプロトコル実装・
  クライアント管理を自前で持たずに済ませている。
