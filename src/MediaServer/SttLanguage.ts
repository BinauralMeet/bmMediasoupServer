//  Deciding what language a speaker is speaking, for the recognizer's hint and for translation.
//  Pure logic, no network or mediasoup import, so it is unit-testable on its own.
//
//  A single utterance is a bad witness: "はい" and "OK" look like several languages at once, and a
//  recognizer left to auto-detect will flip between them from one sentence to the next. Flipping
//  is not a cosmetic problem -- the translation target is derived from it, so half the utterances
//  get translated and half do not, which is what a listener actually notices.

//  Reads the script when the recognizer did not say. Counts characters rather than taking the
//  first match, so one English word inside a Japanese sentence does not decide the sentence.
export function guessLang(text: string){
  let ja = 0
  let ko = 0
  let han = 0
  let latin = 0
  for (const ch of text){
    const c = ch.codePointAt(0)!
    if (c >= 0x3040 && c <= 0x30ff){ ja += 1 }
    else if (c >= 0xac00 && c <= 0xd7af){ ko += 1 }
    else if (c >= 0x4e00 && c <= 0x9fff){ han += 1 }
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)){ latin += 1 }
  }
  //  Kana settles it outright: no other language uses it.
  if (ja > 0){ return 'ja' }
  if (ko > 0){ return 'ko' }
  //  Han characters with no kana: Japanese here, since that is what this deployment translates.
  if (han > latin){ return 'ja' }
  if (latin > 0){ return 'en' }

  return ''
}

//  Weight a witness by how much was said: a long sentence is far better evidence than a grunt.
//  Not by raw character count though -- a Japanese character carries far more than a latin one,
//  so counting characters makes any English sentence look like the weightier witness.
const LATIN_WEIGHT = 0.4
const MIN_EVIDENCE = 15      //  ~15 Japanese characters, or ~37 of English
const MIN_UTTERANCES = 2     //  never let one misheard sentence lock the whole session
const LEAD_SHARE = 0.6

export function evidenceWeight(text: string){
  let weight = 0
  for (const ch of text){
    const c = ch.codePointAt(0)!
    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x4e00 && c <= 0x9fff) ||
        (c >= 0xac00 && c <= 0xd7af)){
      weight += 1
    }else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)){
      weight += LATIN_WEIGHT
    }
  }

  return weight
}

export class LanguageTally{
  private chars = new Map<string, number>()
  private heard = 0
  private decided = ''

  //  `lang` is what the recognizer reported (or the script suggested) for this utterance.
  add(lang: string, text: string){
    if (!lang || !text){ return }
    this.chars.set(lang, (this.chars.get(lang) || 0) + evidenceWeight(text))
    this.heard += 1
    this.decide()
  }

  private decide(){
    let total = 0
    let leader = ''
    let best = 0
    this.chars.forEach((count, lang) => {
      total += count
      if (count > best){ best = count; leader = lang }
    })
    //  Enough has been said, and one language clearly leads: stop asking and commit. Committing
    //  also makes recognition better, since the recognizer gets told the language from then on.
    if (this.heard >= MIN_UTTERANCES && total >= MIN_EVIDENCE && best / total >= LEAD_SHARE){
      this.decided = leader
    }
  }

  //  '' until there is enough evidence. Never changes back once decided: a speaker switching
  //  language mid-meeting is rarer than a recognizer being wrong about one sentence, and the
  //  flapping that re-deciding causes is worse than being wrong in one direction.
  get language(){ return this.decided }

  //  What to believe for one utterance: the settled language once there is one, otherwise
  //  whatever this utterance looked like.
  resolve(lang: string){ return this.decided || lang }
}
