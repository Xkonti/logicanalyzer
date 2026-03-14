/**
 * Ports blocked by browsers (Chrome, Firefox, Safari).
 * Connections to these ports are silently rejected with no useful error message.
 * Source: WHATWG Fetch Standard + Chromium net/base/port_util.cc
 */
const BROWSER_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
])

/**
 * Check if a port number is valid and not blocked by browsers.
 * @param {number|string} port
 * @returns {true|string} true if valid, error message string if invalid
 */
export function portRule(port) {
  const n = Number(port)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Must be 1-65535'
  if (BROWSER_BLOCKED_PORTS.has(n)) return `Port ${n} is blocked by browsers`
  return true
}
