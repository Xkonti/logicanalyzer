/**
 * @typedef {Object} SampleRegion
 * @property {number} firstSample
 * @property {number} lastSample
 * @property {string} regionName
 * @property {{ r: number, g: number, b: number, a: number }} regionColor
 */

/**
 * Creates a SampleRegion with default color.
 * Default color matches C# Color.FromArgb(128, 255, 255, 255).
 *
 * @param {number} firstSample
 * @param {number} lastSample
 * @param {string} [name='']
 * @param {{ r: number, g: number, b: number, a: number }} [color]
 * @returns {SampleRegion}
 */
export function createRegion(
  firstSample,
  lastSample,
  name = '',
  color = { r: 255, g: 255, b: 255, a: 128 },
) {
  return {
    firstSample,
    lastSample,
    regionName: name,
    regionColor: { ...color },
  }
}
