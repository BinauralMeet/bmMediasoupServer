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
  //  acquired) so a GPU somebody else is holding is skipped rather than fought over.
  //    {kind:'sensevoice', endpoint:'https://.../SENSEVOICE/asr',
  //     gpuStatus:'https://.../SWITCH5070TI', apiKeyEnv:'LM_HASELAB_API_KEY', timeoutMs:3000},
  //    {kind:'cpuWhisper', endpoint:'http://localhost:8190/asr', timeoutMs:8000},
  stt: {
    backends: [],
    maxSessions: 8,           //  concurrent transcriptions per media worker
    interimIntervalMs: 1500,  //  how often an open utterance is re-transcribed for interim text
  },

  //  Translation runs on the main server (it is where the room's participants and their desired
  //  languages are known). `backend` empty = original-language subtitles only.
  translation: {
    endpoint: '',             //  POST {texts, src, dsts} -> {lang: text}
    apiKeyEnv: '',
    timeoutMs: 5000,
    maxConcurrent: 4,
    cacheSize: 2000,
  },
};
