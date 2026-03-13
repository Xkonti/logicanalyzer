import { describe, it, expect } from 'vitest'
import {
  CHANNEL_PALETTE,
  BG_CHANNEL_COLORS,
  COLORS,
  getChannelColor,
  parseHex,
  contrastColor,
  withAlpha,
} from './colors.js'

describe('CHANNEL_PALETTE', () => {
  it('has exactly 64 colors', () => {
    expect(CHANNEL_PALETTE).toHaveLength(64)
  })

  it('all entries are valid hex color strings', () => {
    for (const color of CHANNEL_PALETTE) {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })

  it('first four match C# source', () => {
    expect(CHANNEL_PALETTE[0]).toBe('#FF7333')
    expect(CHANNEL_PALETTE[1]).toBe('#33FF57')
    expect(CHANNEL_PALETTE[2]).toBe('#3357FF')
    expect(CHANNEL_PALETTE[3]).toBe('#FF33A1')
  })
})

describe('BG_CHANNEL_COLORS', () => {
  it('has exactly 2 alternating colors', () => {
    expect(BG_CHANNEL_COLORS).toHaveLength(2)
  })
})

describe('COLORS', () => {
  it('has all required system colors', () => {
    expect(COLORS).toHaveProperty('background')
    expect(COLORS).toHaveProperty('text')
    expect(COLORS).toHaveProperty('gridLine')
    expect(COLORS).toHaveProperty('triggerLine')
    expect(COLORS).toHaveProperty('userMarker')
  })
})

describe('getChannelColor', () => {
  it('returns palette color by channel number', () => {
    expect(getChannelColor({ channelNumber: 0 })).toBe(CHANNEL_PALETTE[0])
    expect(getChannelColor({ channelNumber: 1 })).toBe(CHANNEL_PALETTE[1])
    expect(getChannelColor({ channelNumber: 63 })).toBe(CHANNEL_PALETTE[63])
  })

  it('wraps around for channel numbers >= 64', () => {
    expect(getChannelColor({ channelNumber: 64 })).toBe(CHANNEL_PALETTE[0])
    expect(getChannelColor({ channelNumber: 65 })).toBe(CHANNEL_PALETTE[1])
    expect(getChannelColor({ channelNumber: 128 })).toBe(CHANNEL_PALETTE[0])
  })

  it('uses explicit channelColor when set', () => {
    const channel = { channelNumber: 0, channelColor: '#FF0000' }
    expect(getChannelColor(channel)).toBe('#FF0000')
  })

  it('falls back to palette when channelColor is falsy', () => {
    expect(getChannelColor({ channelNumber: 5, channelColor: null })).toBe(CHANNEL_PALETTE[5])
    expect(getChannelColor({ channelNumber: 5, channelColor: '' })).toBe(CHANNEL_PALETTE[5])
    expect(getChannelColor({ channelNumber: 5, channelColor: undefined })).toBe(CHANNEL_PALETTE[5])
  })
})

describe('parseHex', () => {
  it('parses 6-digit hex with hash', () => {
    expect(parseHex('#FF0000')).toEqual({ r: 255, g: 0, b: 0 })
    expect(parseHex('#00FF00')).toEqual({ r: 0, g: 255, b: 0 })
    expect(parseHex('#0000FF')).toEqual({ r: 0, g: 0, b: 255 })
  })

  it('parses 6-digit hex without hash', () => {
    expect(parseHex('FF7333')).toEqual({ r: 255, g: 115, b: 51 })
  })

  it('parses black and white', () => {
    expect(parseHex('#000000')).toEqual({ r: 0, g: 0, b: 0 })
    expect(parseHex('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('handles lowercase hex', () => {
    expect(parseHex('#ff7333')).toEqual({ r: 255, g: 115, b: 51 })
  })
})

describe('contrastColor', () => {
  it('returns black for light backgrounds', () => {
    expect(contrastColor('#FFFFFF')).toBe('#000000')
    expect(contrastColor('#FFFF00')).toBe('#000000')
    expect(contrastColor('#00FF00')).toBe('#000000')
  })

  it('returns white for dark backgrounds', () => {
    expect(contrastColor('#000000')).toBe('#ffffff')
    expect(contrastColor('#0000FF')).toBe('#ffffff')
    expect(contrastColor('#800000')).toBe('#ffffff')
  })

  it('uses YIQ formula consistent with C# FindContrast', () => {
    // YIQ of #808080: (128*299 + 128*587 + 128*114)/1000 = 128
    // At exactly 128, the C# code returns Black
    expect(contrastColor('#808080')).toBe('#000000')
  })
})

describe('withAlpha', () => {
  it('creates rgba string from hex and alpha', () => {
    expect(withAlpha('#FF0000', 0.5)).toBe('rgba(255,0,0,0.5)')
    expect(withAlpha('#00FF00', 0.15)).toBe('rgba(0,255,0,0.15)')
  })

  it('handles full opacity', () => {
    expect(withAlpha('#0000FF', 1)).toBe('rgba(0,0,255,1)')
  })

  it('handles zero opacity', () => {
    expect(withAlpha('#FFFFFF', 0)).toBe('rgba(255,255,255,0)')
  })
})
