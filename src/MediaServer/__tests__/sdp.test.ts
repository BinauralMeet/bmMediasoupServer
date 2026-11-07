import {describe, it, expect} from 'vitest'
import {createSdpText} from '../sdp'
import type {RtpInfo} from '../streaming'

function info(port: number, kind: 'audio'|'video'): RtpInfo {
  const codec = kind === 'video'
    ? {mimeType: 'video/H264', payloadType: 102, clockRate: 90000}
    : {mimeType: 'audio/opus', payloadType: 100, clockRate: 48000, channels: 2}
  return {
    remoteRtpPort: port,
    remoteRtcpPort: -1,
    rtpCapabilities: {codecs: []},
    rtpParameters: {codecs: [codec], headerExtensions: [], encodings: [], rtcp: {}},
  } as RtpInfo
}

describe('createSdpText', () => {
  it('builds a video-only SDP without "undefined"', () => {
    const sdp = createSdpText({video: info(20000, 'video'), fileName: 'f'})
    expect(sdp).not.toContain('undefined')
    expect(sdp).not.toContain('m=audio')
    expect(sdp.split('\n')).toEqual([
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=FFmpeg',
      'c=IN IP4 127.0.0.1',
      't=0 0',
      'm=video 20000 RTP/AVP 102',
      'a=rtpmap:102 H264/90000',
      'a=sendonly',
      '',
    ])
  })

  it('builds a video+audio SDP without "undefined"', () => {
    const sdp = createSdpText({video: info(20000, 'video'), audio: info(20002, 'audio'), fileName: 'f'})
    expect(sdp).not.toContain('undefined')
    const lines = sdp.split('\n')
    expect(lines.slice(5)).toEqual([
      'm=video 20000 RTP/AVP 102',
      'a=rtpmap:102 H264/90000',
      'a=sendonly',
      'm=audio 20002 RTP/AVP 100',
      'a=rtpmap:100 opus/48000/2',
      'a=sendonly',
      '',
    ])
    expect(lines.every(l => l === l.trimStart())).toBe(true)
  })
})
