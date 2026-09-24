import { RtpInfos, RtpInfo } from './streaming';
import { getCodecInfoFromRtpParameters } from './utils'

//  Audio-only SDP for the speech-to-text pipeline. createSdpText() below cannot be reused for
//  this: it dereferences `video!` unconditionally, so an audio-only RtpInfos would crash it.
export function createAudioSdpText(audio: RtpInfo){
  const codec = getCodecInfoFromRtpParameters('audio', audio.rtpParameters)

  return `v=0
o=- 0 0 IN IP4 127.0.0.1
s=BMSTT
c=IN IP4 127.0.0.1
t=0 0
m=audio ${audio.remoteRtpPort} RTP/AVP ${codec.payloadType}
a=rtpmap:${codec.payloadType} ${codec.codecName}/${codec.clockRate}/${codec.channels}
a=sendonly
`
}

// File to create SDP text from mediasoup RTP Parameters
export function createSdpText(rtpParameters: RtpInfos){
  const { video, audio } = rtpParameters;

  // Video codec info
  const videoCodecInfo = getCodecInfoFromRtpParameters('video', video!.rtpParameters)

  // Audio codec info
  const audioCodecInfo = audio ? getCodecInfoFromRtpParameters('audio', audio!.rtpParameters): undefined;

  return `v=0
  o=- 0 0 IN IP4 127.0.0.1
  s=FFmpeg
  c=IN IP4 127.0.0.1
  t=0 0
  m=video ${video!.remoteRtpPort} RTP/AVP ${videoCodecInfo.payloadType}
  a=rtpmap:${videoCodecInfo.payloadType} ${videoCodecInfo.codecName}/${videoCodecInfo.clockRate}
  a=sendonly` +

    (audio && `
m=audio ${audio.remoteRtpPort} RTP/AVP ${audioCodecInfo!.payloadType}
  a=rtpmap:${audioCodecInfo!.payloadType} ${audioCodecInfo!.codecName}/${audioCodecInfo!.clockRate}/${audioCodecInfo!.channels}
  a=sendonly
  `);
};
