// lib/jpeg.mjs
/**
 * Reading the metadata segments out of a JPEG, without decoding it.
 *
 * A JPEG is a sequence of marker segments. The ones that carry identity are
 * APP1 (EXIF, including GPS, and sometimes an XMP packet), APP13 (the Photoshop
 * block, which is where IPTC credit and author live) and COM (a free-text
 * comment, where producers put usernames and file paths).
 *
 * Everything from the start-of-scan marker to the end of the file is
 * entropy-coded image data with no segment structure, so it is never parsed —
 * only copied or skipped past.
 */

const APP1 = 0xe1
const APP13 = 0xed
const COM = 0xfe

const LABELS = {
  [APP1]: 'APP1 (EXIF/XMP)',
  [APP13]: 'APP13 (IPTC)',
  [COM]: 'COM (comment)',
}

const STRIP = new Set([APP1, APP13, COM])

/**
 * Walk a JPEG and return which metadata segments it carries, plus a copy with
 * those segments removed.
 *
 * Returns null when the input is not a JPEG this understands, which callers
 * must treat as "cannot answer" rather than as "carries nothing".
 */
export function readJpegMetadata(input) {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return null

  const keep = [[0, 2]]
  const found = []

  let i = 2
  while (i < input.length) {
    if (input[i] !== 0xff) return null

    let m = i
    while (m < input.length && input[m] === 0xff) m++
    if (m >= input.length) return null

    const marker = input[m]

    if (marker === 0xd9) {
      keep.push([i, input.length])
      break
    }

    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      keep.push([i, m + 1])
      i = m + 1
      continue
    }

    if (m + 2 >= input.length) return null
    const length = (input[m + 1] << 8) | input[m + 2]
    if (length < 2) return null

    const end = m + 1 + length
    if (end > input.length) return null

    if (marker === 0xda) {
      keep.push([i, input.length])
      break
    }

    if (STRIP.has(marker)) found.push(LABELS[marker] ?? `0x${marker.toString(16)}`)
    else keep.push([i, end])

    i = end
  }

  let total = 0
  for (const [a, b] of keep) total += b - a
  const out = new Uint8Array(total)
  let o = 0
  for (const [a, b] of keep) {
    out.set(input.subarray(a, b), o)
    o += b - a
  }

  return { found, stripped: out }
}
