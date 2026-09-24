import {describe, it, expect} from 'vitest'
import {collectTargetLangs, normalizeLang, TranslationCache} from '../TranslationTargets'

describe('normalizeLang', () => {
  it('reduces a tag to its primary subtag', () => {
    expect(normalizeLang('en-US')).toBe('en')
    expect(normalizeLang('ja_JP')).toBe('ja')
    expect(normalizeLang('EN')).toBe('en')
  })
  it('treats auto/empty as "not stated"', () => {
    expect(normalizeLang('auto')).toBe('')
    expect(normalizeLang('')).toBe('')
    expect(normalizeLang(undefined)).toBe('')
  })
})

describe('collectTargetLangs', () => {
  it('is empty for a single-language room, so nothing is translated', () => {
    expect(collectTargetLangs(['ja', 'ja', 'ja'], 'ja')).toEqual([])
  })
  it('excludes the spoken language and de-duplicates the rest', () => {
    expect(collectTargetLangs(['en', 'ja', 'en-GB', 'ko'], 'ja')).toEqual(['en', 'ko'])
  })
  it('ignores participants who never announced a language', () => {
    expect(collectTargetLangs([undefined, '', 'auto', 'en'], 'ja')).toEqual(['en'])
  })
  it('is empty when the source language itself is unknown', () => {
    expect(collectTargetLangs(['en'], 'auto')).toEqual([])
  })
})

describe('TranslationCache', () => {
  it('returns what was stored for the same (src, dst, text)', () => {
    const cache = new TranslationCache()
    cache.set('ja', 'en', 'こんにちは', 'hello')
    expect(cache.get('ja', 'en', 'こんにちは')).toBe('hello')
    expect(cache.get('ja', 'ko', 'こんにちは')).toBeUndefined()
    expect(cache.get('ja', 'en', 'さようなら')).toBeUndefined()
  })

  it('evicts the oldest entry past its limit', () => {
    const cache = new TranslationCache(2)
    cache.set('ja', 'en', 'a', '1')
    cache.set('ja', 'en', 'b', '2')
    cache.set('ja', 'en', 'c', '3')
    expect(cache.size).toBe(2)
    expect(cache.get('ja', 'en', 'a')).toBeUndefined()
    expect(cache.get('ja', 'en', 'c')).toBe('3')
  })

  it('keeps an entry that is still being used', () => {
    const cache = new TranslationCache(2)
    cache.set('ja', 'en', 'a', '1')
    cache.set('ja', 'en', 'b', '2')
    cache.get('ja', 'en', 'a')             //  'a' is the most recently used now
    cache.set('ja', 'en', 'c', '3')
    expect(cache.get('ja', 'en', 'a')).toBe('1')
    expect(cache.get('ja', 'en', 'b')).toBeUndefined()
  })
})
