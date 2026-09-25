//  Injects recognition results, which arrive from a media worker, into the room's data channel as
//  ordinary messages attributed to the speaker. Clients cannot tell them apart from any other
//  participant message, so receiving, recording and playback all work through the paths that
//  already exist. Design: the bm workspace doc `stt-translation#ingest`.
//
//  The peer id in an MSSttResultMessage is also the DataServer participant id: Conference.enter()
//  passes the peer returned by the mediasoup connect straight into dataConnection.connect(). If
//  either side ever stops sharing that id, this lookup is where it breaks.
import {MSSttResultMessage} from '../MediaServer/MediaMessages'
import {MessageType, SpeechInterim, SpeechText, SpeechTranslation} from './DataMessageType'
import {BMMessage} from './DataMessage'
import {rooms, RoomStore} from './Stores'
import {translateUtterance} from './translation'
import {consoleDebug} from '../MainServer/utils'

//  Unlike instantMessageHandler(), the speaker is included: recognition happens on the server, so
//  the speaker has no local copy of their own subtitle, and their subtitle language may differ
//  from the language they speak.
function broadcast(room: RoomStore, msg: BMMessage){
  room.participants.forEach(p => p.pushOrUpdateMessage({...msg}))
}

export function ingestSttResult(result: MSSttResultMessage){
  const room = rooms.rooms.get(result.room)
  if (!room){
    consoleDebug(`stt: result for unknown room ${result.room}`)

    return
  }
  if (!room.participantsMap.has(result.peer)){
    //  The speaker left between saying it and the transcription coming back.
    return
  }
  const text = result.text.trim()
  if (!text){ return }

  if (!result.final){
    const payload: SpeechInterim = {sid: result.sid, text, lang: result.lang}
    broadcast(room, {t: MessageType.SPEECH_INTERIM, p: result.peer, v: JSON.stringify(payload)})

    return
  }

  //  The worker's timestamp for when the speech ended, not the moment recognition finished:
  //  clients use it to tell continuous speech from a pause.
  const payload: SpeechText = {sid: result.sid, text, lang: result.lang,
    ts: result.ts || Date.now(), durationMs: result.durationMs}
  broadcast(room, {t: MessageType.SPEECH_TEXT, p: result.peer, v: JSON.stringify(payload)})

  //  Sent separately and later, so a slow or dead translation backend never delays the
  //  original-language subtitle.
  translateUtterance(room, result.sid, result.peer, text, result.lang, (translation: SpeechTranslation) => {
    broadcast(room, {t: MessageType.SPEECH_TRANSLATION, p: result.peer, v: JSON.stringify(translation)})
  })
}
