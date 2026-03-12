/**
 * Color palette and utilities for the logic analyzer renderer.
 * Matches the C# AnalyzerColors class exactly.
 */

/**
 * 64-color palette for channel waveforms.
 * Channels are assigned colors via CHANNEL_PALETTE[channelNumber % 64].
 * Copied verbatim from AnalyzerColors.cs.
 */
export const CHANNEL_PALETTE = [
  '#FF7333', '#33FF57', '#3357FF', '#FF33A1',
  '#FFBD33', '#33FFF6', '#BD33FF', '#57FF33',
  '#5733FF', '#33FFBD', '#FF33BD', '#FF5733',
  '#BDFF33', '#33FF57', '#FF33F6', '#F6FF33',
  '#33FF73', '#FF5733', '#FF33C1', '#33FF85',
  '#33C1FF', '#C1FF33', '#7333FF', '#FF3385',
  '#3385FF', '#85FF33', '#33FF99', '#9933FF',
  '#99FF33', '#FF3399', '#FF9C33', '#FF33E7',
  '#E733FF', '#33E7FF', '#FF33C7', '#C733FF',
  '#FF338E', '#338EFF', '#8EFF33', '#FF338E',
  '#33FF9C', '#FF9C33', '#339CFF', '#FF339C',
  '#9C33FF', '#FF8E33', '#33E733', '#339CFF',
  '#9CFF33', '#FF339C', '#FF9C33', '#33FF9C',
  '#FF33E7', '#E7FF33', '#33FFC7', '#C7FF33',
  '#33F6FF', '#FF5733', '#FF33F6', '#F6FF33',
  '#5733FF', '#33BDFF', '#BD33FF', '#33FFBD',
]

/** Alternating channel background colors (dark theme). */
export const BG_CHANNEL_COLORS = ['rgb(36,36,36)', 'rgb(28,28,28)']

/** System colors used throughout the renderer. */
export const COLORS = {
  background: 'rgb(28,28,28)',
  text: '#ffffff',
  textDim: 'rgba(255,255,255,0.6)',
  gridLine: 'rgb(60,60,60)',
  gridDash: 'rgba(60,60,60,0.24)',
  triggerLine: '#ffffff',
  userMarker: '#00ffff',
  burstLine: '#f0f8ff',
  burstPen: 'rgb(224,175,29)',
  burstFill: 'rgba(224,175,29,0.5)',
  selectionFill: 'rgba(255,255,255,0.5)',
  dataLossFill: 'rgba(140, 30, 30, 0.35)',
  timelineBackground: 'rgb(28,28,28)',
  timelineTick: 'rgba(255,255,255,0.7)',
}

/**
 * Get the display color for a channel.
 * Uses channelColor if explicitly set, otherwise falls back to palette.
 * @param {{ channelNumber: number, channelColor?: string }} channel
 * @returns {string} hex color
 */
export function getChannelColor(channel) {
  return channel.channelColor || CHANNEL_PALETTE[channel.channelNumber % CHANNEL_PALETTE.length]
}

/**
 * Parse a hex color string (#RRGGBB or RRGGBB) to {r, g, b} components (0-255).
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number }}
 */
export function parseHex(hex) {
  if (hex.startsWith('#')) hex = hex.slice(1)
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  }
}

/**
 * Get a contrasting text color (black or white) for a given background hex color.
 * Uses the YIQ formula matching the C# ColorExtensions.FindContrast().
 * @param {string} hexColor
 * @returns {string}
 */
export function contrastColor(hexColor) {
  const { r, g, b } = parseHex(hexColor)
  const yiq = (r * 299 + g * 587 + b * 114) / 1000
  return yiq >= 128 ? '#000000' : '#ffffff'
}

/**
 * Create an rgba() CSS string from a hex color and alpha (0-1).
 * @param {string} hexColor
 * @param {number} alpha
 * @returns {string}
 */
export function withAlpha(hexColor, alpha) {
  const { r, g, b } = parseHex(hexColor)
  return `rgba(${r},${g},${b},${alpha})`
}
