import {describe, it, expect} from 'vitest'
import {guessLang, LanguageTally} from '../SttLanguage'

describe('guessLang', () => {
  it('reads the script when the recognizer did not say', () => {
    expect(guessLang('こんにちは')).toBe('ja')
    expect(guessLang('안녕하세요')).toBe('ko')
    expect(guessLang('Hello there')).toBe('en')
  })

  it('counts characters instead of taking the first match', () => {
    //  An English word inside a Japanese sentence does not make the sentence English.
    expect(guessLang('このアプリはMeetと言います')).toBe('ja')
    //  ...and the reverse.
    expect(guessLang('The kanji 漢字 appears here')).toBe('en')
  })

  it('stays unknown rather than guessing, so nothing is mistranslated', () => {
    expect(guessLang('')).toBe('')
    expect(guessLang('123 ...')).toBe('')
  })
})

describe('LanguageTally', () => {
  const long = (lang: string) => lang === 'ja' ? 'これは十分に長い日本語の文章です' : 'this is a long enough english sentence'

  it('says nothing until it has heard enough', () => {
    const tally = new LanguageTally()
    tally.add('ja', 'はい')
    expect(tally.language).toBe('')
    //  ...and an utterance is judged on its own until then.
    expect(tally.resolve('en')).toBe('en')
  })

  it('settles once one language clearly leads', () => {
    const tally = new LanguageTally()
    tally.add('ja', long('ja'))
    tally.add('ja', long('ja'))
    tally.add('ja', long('ja'))
    expect(tally.language).toBe('ja')
  })

  it('overrides a single misheard utterance once settled', () => {
    const tally = new LanguageTally()
    for (let i = 0; i < 3; i += 1){ tally.add('ja', long('ja')) }
    //  One sentence comes back as English -- the subtitle stays Japanese rather than flipping,
    //  which is what makes some utterances translate and others not.
    expect(tally.resolve('en')).toBe('ja')
  })

  it('needs a clear lead, not just a majority of one utterance', () => {
    const tally = new LanguageTally()
    tally.add('ja', long('ja'))
    tally.add('en', long('en'))
    expect(tally.language).toBe('')
  })

  it('ignores empty witnesses', () => {
    const tally = new LanguageTally()
    tally.add('', 'something')
    tally.add('ja', '')
    expect(tally.language).toBe('')
  })
})
