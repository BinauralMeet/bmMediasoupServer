const announcedIp='vrc.jp'

module.exports = {

  websocketTimeout: 60 * 1000,        //  Web sockets for peer will be disconnected when no pakect received in 60 second.
  workerWebsocketTimeout: 15 * 1000,  //  Web sockets for worker uses ping-pong with 15 second timeout.
  //===========================================================================
  //  For Main server
  //
  //
  //  Main server's http server ip, port
  //  For Deploy ---------------------------------------------
  //httpIp: "main.titech.binaural.me",  //  ip to listen
  //httpPort: 443,                      //  port to listen
  //  For Debug ----------------------------------------------
  // httpIp: "localhost",                  //  ip to listen
  httpIp: "localhost",
  httpPort: 3100,                       //  port to listen
  //----------------------------------------------------------

  //  Path to certs
  sslCrt: './certs/fullchain.pem',
  sslKey: './certs/privkey.pem',

  // Google OAuth2.0 config file path
  //TODO: change to server credentials.json path
  googleOAuth2Config: './credentials.json',


  //===========================================================================
  //  For Media server
  //
  //
  //  url to main server
  mainServer: "wss://localhost:3100", //  url to the main server FOR DEOPLOY
  //mainServer: "wss://main.titech.binaural.me", //  url to the main server FOR DEBUG
  mediasoup: {
    worker: {
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
      logLevel: "debug",
      logTags: [
        "info",
        "ice",
        "dtls",
        "rtp",
        "srtp",
        "rtcp",
        // 'rtx',
        // 'bwe',
        // 'score',
        // 'simulcast',
        // 'svc'
      ],
    },
    router: {
      mediaCodecs: [
        {
          kind: "audio",
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: "video",
          mimeType: "video/VP8",
          clockRate: 90000,
          parameters: {
            //                'x-google-start-bitrate': 1000
          },
        },
        {
          kind: "video",
          mimeType: "video/H264",
          clockRate: 90000,
          parameters: {
            "packetization-mode": 1,
            "profile-level-id": "4d0032",
            "level-asymmetry-allowed": 1,
            //						  'x-google-start-bitrate'  : 1000
          },
        },
        {
          kind: "video",
          mimeType: "video/H264",
          clockRate: 90000,
          parameters: {
            "packetization-mode": 1,
            "profile-level-id": "42e01f",
            "level-asymmetry-allowed": 1,
            //						  'x-google-start-bitrate'  : 1000
          },
        },
      ],
    },

    // rtp listenIps are the most important thing, below. you'll need
    // to set these appropriately for your network for the demo to
    // run anywhere but on localhost
    webRtcTransport: {
      listenIps: [
        //  no entry = auto find = try to find host's ip or use 127.0.0.1
        //{ ip: "127.0.0.1", announcedIp: null },
        // { ip: '10.10.23.101', announcedIp: null },
      ],
      initialAvailableOutgoingBitrate: 800000,
    },

    plainTransport: {
      listenIp: { ip: '0.0.0.0', announcedIp: null },
      rtcpMux: true,
      comedia: false
    }
  },
  //===========================================================================
  //  Speech-to-text and translation (bm workspace doc: `stt-translation`)
  //
  //  `backends` is tried in order for every utterance; an entry that is locked, unreachable or
  //  failing is skipped and the next one is used. Empty (the default below) = feature off:
  //  clients asking for STT get a clear refusal instead of silence.
  //
  //  A GPU-backed entry may name `gpuStatus`, whose `<gpuStatus>/lock/status` is *read* (never
  //  acquired) so a GPU somebody else is holding is skipped rather than fought over. With
  //  `gpuMode` set, an *unlocked* GPU running something else is asked to switch into that mode
  //  (`POST <gpuStatus>/activate/<gpuMode>`) -- which stops whatever was running there, so only
  //  set it for a GPU whose other users accept that.
  //
  //  Only ONE entry per GPU may carry `gpuMode`: two of them would take turns switching the
  //  card into their own mode, every utterance, forever.
  //
  //  `upload`/`langParam`/`langAuto` cover the differences between services: bm/stt-sidecars
  //  takes a raw WAV body and `lang` (absent = detect it), SenseVoice takes multipart `file` and
  //  `language` (for which 'auto' is a value). `timeoutMs` has to cover the longest utterance the
  //  VAD hands over (30s) at whatever speed the backend runs. With
  //  `gpuMode` set, an *unlocked* GPU running something else is asked to switch into that mode
  //  (`POST <gpuStatus>/activate/<gpuMode>`) -- which stops whatever was running there, so only
  //  set it for a GPU whose other users accept that.
  //    {kind:'sensevoice', endpoint:'https://.../SENSEVOICE/transcribe',
  //     upload:'multipart', langParam:'language', langAuto:'auto',
  //     gpuStatus:'https://.../SWITCH5070TI', gpuMode:'sensevoice',
  //     apiKeyEnv:'LM_HASELAB_API_KEY', timeoutMs:15000},
  //    {kind:'cpuWhisper', endpoint:'http://localhost:8190/asr', timeoutMs:40000},
  //
  //  Host-side setup for both entries below: `stt-translation#hostwork` / `bm/stt-sidecars`.
  //  sensevoice's path is already publicly proxied (`lm-tool#arch`) but was **not live-tested
  //  against the real request shape below** -- rtx5070ti's shared GPU was in `hidream` mode at
  //  setup time, and BM deliberately never switches GPU modes itself (`#fallback`), so verifying
  //  it would have meant kicking whoever/whatever was using ComfyUI. First real meeting that
  //  falls through to it is the actual test; cpuWhisper was fully verified (real speech in,
  //  correct transcript out) so the meeting keeps working either way.
  stt: {
    backends: [
      {kind: 'sensevoice', endpoint: 'https://lm.haselab.net/SENSEVOICE/asr',
        gpuStatus: 'https://lm.haselab.net/SWITCH5070TI', apiKeyEnv: 'LM_HASELAB_API_KEY',
        timeoutMs: 3000},
      {kind: 'cpuWhisper', endpoint: 'http://localhost:8190/asr', timeoutMs: 8000},
    ],
    maxSessions: 8,           //  concurrent transcriptions per media worker
    interimIntervalMs: 1500,  //  how often an open utterance is re-transcribed for interim text
  },

  //  Translation runs on the main server (it is where the room's participants and their desired
  //  languages are known). No endpoint at all = original-language subtitles only.
  //
  //  `endpoints` is tried in order and each is asked only for the languages still missing, so a
  //  dedicated pair model can sit in front of a multilingual one: FuguMT translates ja<->en
  //  better than any many-to-many model, while the multilingual one behind it answers the pairs
  //  FuguMT has never heard of. An endpoint that is down costs only the languages nobody else
  //  covers. A single `endpoint: '...'` still works and means a chain of one.
  //    endpoints: [
  //      {endpoint: 'http://.../translate'},                       //  bm/stt-sidecars, ja<->en
  //      {endpoint: 'https://.../GPUWHISPER/translate',            //  M2M-100, everything else
  //        apiKeyEnv: 'LM_HASELAB_API_KEY', timeoutMs: 8000},
  //    ],
  translation: {
    endpoints: [],
    timeoutMs: 5000,
    maxConcurrent: 4,
    cacheSize: 2000,
  },
};
