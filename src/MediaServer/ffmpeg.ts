// Class to handle child process used for running FFmpeg
import {ChildProcessWithoutNullStreams, spawn } from 'child_process';
import {RtpInfo, RtpInfos} from './streaming'
import {EventEmitter} from 'events';
import { createAudioSdpText, createSdpText } from './sdp';
import {convertStringToStream} from './utils'

const RECORD_FILE_LOCATION_PATH = process.env.RECORD_FILE_LOCATION_PATH || './files';

export class FFmpeg {
  _rtpParameters: RtpInfos
  _process?: ChildProcessWithoutNullStreams
  _observer: EventEmitter
  constructor (rtpParameters:RtpInfos) {
    this._rtpParameters = rtpParameters;
    this._process = undefined;
    this._observer = new EventEmitter();
    this._createProcess();
  }

  _createProcess () {
    const sdpString = createSdpText(this._rtpParameters);
    const sdpStream = convertStringToStream(sdpString);

    console.log('createProcess() [sdpString:%s]', sdpString);

    this._process = spawn('ffmpeg', this._commandArgs);

    if (this._process?.stderr) {
      this._process?.stderr.setEncoding('utf-8');

      this._process?.stderr.on('data', data =>
        console.log('ffmpeg::process::data [data:%o]', data)
      );
    }

    if (this._process?.stdout) {
      this._process.stdout.setEncoding('utf-8');

      this._process.stdout.on('data', data =>
        console.log('ffmpeg::process::data [data:%o]', data)
      );
    }

    this._process?.on('message', message =>
      console.log('ffmpeg::process::message [message:%o]', message)
    );

    this._process?.on('error', error =>
      console.error('ffmpeg::process::error [error:%o]', error)
    );

    this._process?.once('close', () => {
      console.log('ffmpeg::process::close');
      this._observer.emit('process-close');
    });

    sdpStream.on('error', error =>
      console.error('sdpStream::error [error:%o]', error)
    );

    // Pipe sdp stream to the ffmpeg process
    sdpStream.resume();
    sdpStream.pipe(this._process!.stdin);
  }

  kill () {
    console.log('kill() [pid:%d]', this._process?.pid);
    this._process?.kill('SIGINT');
  }

  get _commandArgs () {
    let commandArgs = [
      //'-re',
      //'-loglevel',
      //'debug',
      '-protocol_whitelist','pipe,udp,rtp,rtmp,rtsp',
      '-fflags',
      '+genpts',
      '-f',
      'sdp',
      '-i',
      'pipe:0'
    ];

    if (this._rtpParameters['video']){
      commandArgs = commandArgs.concat(this._videoArgs);
    }
    if (this._rtpParameters['audio']){
      commandArgs = commandArgs.concat(this._audioArgs);
    }

    commandArgs = commandArgs.concat([
      '-flags',
      '+global_header',
      //hase//  `${RECORD_FILE_LOCATION_PATH}/${this._rtpParameters.fileName}.webm`
//	'-c:v', 'libx264', '-x264-params', 'keyint=90:scenecut=0',
//	'-b:v', '1.3M',
//	'-c:a', 'aac',
//	'-maxrate', '1.3M',
//	'-bufsize', '0.2M',
//	'-vcodec', 'copy',
//	'-acodec', 'copy',
//        '-f', 'flv', `rtmp://localhost/${this._rtpParameters.fileName}`
      '-f', 'rtsp', `rtsp://localhost/${this._rtpParameters.fileName}`
    ]);

    console.log('commandArgs:%o', commandArgs);

    return commandArgs;
  }

  get _videoArgs () {
    return [
      '-map',
      '0:v:0',
      '-c:v',
      'copy'
    ];
  }

  get _audioArgs () {
    return [
      '-map',
      '0:a:0',
      '-strict', // libvorbis is experimental
      '-2',
      '-c:a',
//      'copy'
      'aac'
    ];
  }
}

//  Decodes one audio producer's RTP into raw 16kHz mono PCM on stdout, for stt.ts to segment and
//  recognize. Separate from FFmpeg above because that class exists to push RTSP: its command line,
//  its SDP (video-first) and its text-mode stdout handling are all wrong for this. What the two
//  share -- spawn, an EventEmitter for 'process-close', feeding the SDP through stdin -- is little
//  enough that mirroring it is clearer than parameterizing one class over two unrelated outputs.
export class SttFFmpeg {
  _process?: ChildProcessWithoutNullStreams
  _observer: EventEmitter
  private sampleRate: number

  constructor (audio: RtpInfo, sampleRate: number) {
    this.sampleRate = sampleRate
    this._observer = new EventEmitter()
    const sdpString = createAudioSdpText(audio)
    this._process = spawn('ffmpeg', this._commandArgs)

    //  No setEncoding here: stdout is PCM, and decoding it as utf-8 would corrupt every sample.
    this._process.stdout?.on('data', (chunk: Buffer) => this._observer.emit('pcm', chunk))
    this._process.stderr?.setEncoding('utf-8')
    this._process.stderr?.on('data', data => sttFFmpegDebug('sttFFmpeg::stderr %s', data))
    this._process.on('error', error => console.error('sttFFmpeg::error [error:%o]', error))
    this._process.once('close', () => { this._observer.emit('process-close') })

    const sdpStream = convertStringToStream(sdpString)
    sdpStream.on('error', error => console.error('sttFFmpeg::sdpStream::error [error:%o]', error))
    sdpStream.resume()
    sdpStream.pipe(this._process.stdin)
  }

  kill () {
    this._process?.kill('SIGINT')
  }

  get _commandArgs () {
    return [
      '-protocol_whitelist', 'pipe,udp,rtp',
      '-fflags', '+genpts',
      '-f', 'sdp',
      '-i', 'pipe:0',
      '-vn',
      '-ac', '1',
      '-ar', `${this.sampleRate}`,
      '-f', 's16le',
      'pipe:1',
    ]
  }
}

const STT_FFMPEG_DEBUG = false
const sttFFmpegDebug = STT_FFMPEG_DEBUG ? console.log : (..._: any[]) => {}
