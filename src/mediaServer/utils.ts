import { MediaKind, RtpParameters } from 'mediasoup/node/lib/RtpParameters';
import { Readable } from 'stream'
import * as mediasoup from 'mediasoup'

// Converts a string (SDP) to a stream so it can be piped into the FFmpeg process
export function convertStringToStream(stringToConvert: string){
  const stream = new Readable();
  stream._read = () => {};
  stream.push(stringToConvert);
  stream.push(null);

  return stream;
};

// Gets codec information from rtpParameters
export function getCodecInfoFromRtpParameters(kind: MediaKind, rtpParameters:mediasoup.types.RtpParameters){
  return {
    payloadType: rtpParameters.codecs[0].payloadType,
    codecName: rtpParameters.codecs[0].mimeType.replace(`${kind}/`, ''),
    clockRate: rtpParameters.codecs[0].clockRate,
    channels: kind === 'audio' ? rtpParameters.codecs[0].channels : undefined
  };
};
