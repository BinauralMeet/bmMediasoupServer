import {describe, it, expect, vi} from 'vitest'
import type {RtpInfo} from '../streaming'
import {FFmpeg} from '../ffmpeg'

//  FFmpeg spawns its process in the constructor; give it a dummy one so only the arguments matter.
//  vi.mock is hoisted above the imports, so `spawned` is created by vi.hoisted.
const {spawned} = vi.hoisted(() => ({spawned: [] as string[][]}))
vi.mock('child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    spawned.push(args)
    const {EventEmitter} = require('events')
    const {PassThrough} = require('stream')
    return Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {},
    })
  },
}))

function video(mimeType: string): RtpInfo {
  return {
    remoteRtpPort: 20000,
    remoteRtcpPort: -1,
    rtpCapabilities: {codecs: []},
    rtpParameters: {codecs: [{mimeType, payloadType: 102, clockRate: 90000}], headerExtensions: [], encodings: [], rtcp: {}},
  } as RtpInfo
}

function argsFor(mimeType: string): string[] {
  spawned.length = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
  new FFmpeg({video: video(mimeType), fileName: 'f'})
  return spawned[0]
}

function valueOf(args: string[], key: string){
  return args[args.indexOf(key) + 1]
}

describe('FFmpeg video arguments', () => {
  it('copies H264 without transcoding', () => {
    const args = argsFor('video/H264')
    expect(valueOf(args, '-c:v')).toBe('copy')
    expect(args).not.toContain('libx264')
  })

  it('transcodes VP8 to H264 Main, 4:2:0, without B-frames', () => {
    const args = argsFor('video/VP8')
    expect(valueOf(args, '-c:v')).toBe('libx264')
    expect(valueOf(args, '-profile:v')).toBe('main')
    expect(valueOf(args, '-pix_fmt')).toBe('yuv420p')
    expect(valueOf(args, '-bf')).toBe('0')
    expect(args).not.toContain('zerolatency')
    expect(args[args.length - 1]).toBe('rtsp://localhost/f')
  })
})
