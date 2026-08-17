// lib/planted.mjs
/**
 * The values written into the corpus, and the EXIF block that carries them.
 *
 * Every string here is globally unique so that finding one in an output file
 * identifies which leak class it came from. An earlier version reused a name
 * across the image and the document and reported image leaks on files that
 * contained no image at all.
 */

export const PLANTED = {
  // Inside the embedded photograph
  gps: { latDeg: 37, latMin: 26, latSec: 30.84, lonDeg: 122, lonMin: 8, lonSec: 34.8 },
  make: 'TestCam',
  model: 'LeakModel-9000',
  artist: 'Priya Raman',
  comment: 'pdf-leak-corpus-comment-marker',

  // Document properties
  docTitle: 'Confidential Merger Memo',
  docAuthor: 'Jane Doe',
  docProducer: 'SecretWriter 4.2',
  docSubject: 'Project Nightingale',

  // Annotation
  annotAuthor: 'Reviewer Bob Smith',
  annotBody: 'internal note: do not send to counterparty',
  annotDate: "D:20260501120000-04'00'",

  // Attachment and script
  attachmentName: 'salary-band.csv',
  // Deliberately NOT docAuthor. It used to be, and "Jane Doe,L7" contains
  // "Jane Doe" — so every tool that removed the document properties but left
  // the attachment was reported as leaking document properties, from a string
  // that was only ever inside the attachment.
  attachmentBody: 'name,band\nR. Halloway,L7\n',
  javascript: 'app.alert("pdf-leak-corpus-js-marker");',

  // XFA. The author is metadata and must go; the template and the typed-in
  // value are content and must survive. A tool that takes them has emptied the
  // form rather than cleaned it.
  xfaAuthor: 'Aisha Okonkwo',
  xfaTemplate: 'pdf-leak-corpus-xfa-template-marker',
  xfaValue: 'pdf-leak-corpus-xfa-value-marker',
}

/** Every planted string, labelled by the leak class it belongs to. */
export const MARKERS = [
  ['image', 'camera model', PLANTED.model],
  ['image', 'camera make', PLANTED.make],
  ['image', 'photographer name', PLANTED.artist],
  ['image', 'image comment', PLANTED.comment],
  ['doc', 'document author', PLANTED.docAuthor],
  ['doc', 'document title', PLANTED.docTitle],
  ['doc', 'producer', PLANTED.docProducer],
  ['doc', 'subject', PLANTED.docSubject],
  ['annot', 'annotation author', PLANTED.annotAuthor],
  ['content', 'annotation body', PLANTED.annotBody],
  ['attach', 'attachment name', PLANTED.attachmentName],
  ['attach', 'attachment contents', 'R. Halloway,L7'],
  ['js', 'javascript', 'pdf-leak-corpus-js-marker'],
  ['doc', 'xfa author', PLANTED.xfaAuthor],
  ['content', 'xfa template', PLANTED.xfaTemplate],
  ['content', 'xfa value', PLANTED.xfaValue],
]

/*
 * The other direction: strings that must still be PRESENT in the named file.
 *
 * Everything in MARKERS is something a cleaner should remove. These are things
 * it must not. A tool that empties an XFA form scores a perfect row on leaks
 * while destroying the document, and counting leaks cannot see that — so it is
 * checked separately.
 */
export const MUST_SURVIVE = [
  ['xfa-form-xmp.pdf', 'xfa template', PLANTED.xfaTemplate],
  ['xfa-form-xmp.pdf', 'xfa value', PLANTED.xfaValue],
]

/*
 * An annotation's /Contents is the comment text a reader sees in any viewer
 * that renders comments. It is page content, not metadata, so a tool that
 * leaves it is not failing — it is doing what it says. Reported separately
 * rather than silently dropped, because someone sanitizing a reviewed document
 * usually has not thought about the review notes travelling with it.
 */
export const CONTENT_CLASS = 'content'

/* -------------------------------------------------------------------------- */
/* EXIF                                                                       */
/* -------------------------------------------------------------------------- */

const ASCII = 2
const LONG = 4
const RATIONAL = 5

function entry(tag, type, count, payload, chunks, dataStart) {
  const e = Buffer.alloc(12)
  e.writeUInt16BE(tag, 0)
  e.writeUInt16BE(type, 2)
  e.writeUInt32BE(count, 4)
  if (payload.length <= 4) {
    payload.copy(e, 8)
  } else {
    let off = dataStart
    for (const c of chunks) off += c.length
    e.writeUInt32BE(off, 8)
    chunks.push(payload)
    if (payload.length % 2 === 1) chunks.push(Buffer.alloc(1))
  }
  return e
}

const asciiVal = (v) => Buffer.from(`${v}\0`, 'latin1')

function rationals(deg, min, sec) {
  const b = Buffer.alloc(24)
  b.writeUInt32BE(deg, 0); b.writeUInt32BE(1, 4)
  b.writeUInt32BE(min, 8); b.writeUInt32BE(1, 12)
  b.writeUInt32BE(Math.round(sec * 100), 16); b.writeUInt32BE(100, 20)
  return b
}

/**
 * Build a complete APP1 EXIF segment carrying camera identity and GPS.
 *
 * Written by hand rather than shelled out to exiftool so that this repository
 * has no dependency beyond pdf-lib. exiftool parses the result as real GPS,
 * which is the only test that matters.
 */
export function buildExifApp1() {
  const ifd0n = 4
  const gpsn = 4
  const ifd0Size = 2 + 12 * ifd0n + 4
  const gpsSize = 2 + 12 * gpsn + 4
  const gpsOffset = 8 + ifd0Size
  const dataStart = 8 + ifd0Size + gpsSize
  const data = []

  const gpsPtr = Buffer.alloc(4)
  gpsPtr.writeUInt32BE(gpsOffset, 0)

  const ifd0 = [
    entry(0x010f, ASCII, PLANTED.make.length + 1, asciiVal(PLANTED.make), data, dataStart),
    entry(0x0110, ASCII, PLANTED.model.length + 1, asciiVal(PLANTED.model), data, dataStart),
    entry(0x013b, ASCII, PLANTED.artist.length + 1, asciiVal(PLANTED.artist), data, dataStart),
    entry(0x8825, LONG, 1, gpsPtr, data, dataStart),
  ]

  const g = PLANTED.gps
  const gps = [
    entry(0x0001, ASCII, 2, Buffer.from('N\0', 'latin1'), data, dataStart),
    entry(0x0002, RATIONAL, 3, rationals(g.latDeg, g.latMin, g.latSec), data, dataStart),
    entry(0x0003, ASCII, 2, Buffer.from('W\0', 'latin1'), data, dataStart),
    entry(0x0004, RATIONAL, 3, rationals(g.lonDeg, g.lonMin, g.lonSec), data, dataStart),
  ]

  const tiff = Buffer.alloc(8)
  tiff.write('MM', 0, 'latin1')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4)

  const c0 = Buffer.alloc(2); c0.writeUInt16BE(ifd0n, 0)
  const c1 = Buffer.alloc(2); c1.writeUInt16BE(gpsn, 0)
  const nextIfd = Buffer.alloc(4)

  const body = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    tiff, c0, ...ifd0, nextIfd, c1, ...gps, nextIfd, ...data,
  ])

  const seg = Buffer.alloc(4 + body.length)
  seg.writeUInt16BE(0xffe1, 0)
  seg.writeUInt16BE(body.length + 2, 2)
  body.copy(seg, 4)
  return seg
}

export function buildComSegment(text) {
  const body = Buffer.from(text, 'latin1')
  const seg = Buffer.alloc(4 + body.length)
  seg.writeUInt16BE(0xfffe, 0)
  seg.writeUInt16BE(body.length + 2, 2)
  body.copy(seg, 4)
  return seg
}

/*
 * Every planted string has to be findable without being findable inside
 * another one. If one marker is a substring of a second, a tool that removes
 * the first and leaves the second is reported as failing at both, and the
 * table blames it for something it did not do.
 *
 * This has gone wrong twice — an artist matching the document author, and an
 * attachment body containing it — so it is a check rather than a note.
 */
export function assertMarkersDistinct() {
  const strings = Object.entries(PLANTED).filter(([, v]) => typeof v === 'string' && v.length > 3)
  const problems = []
  for (const [aKey, a] of strings) {
    for (const [bKey, b] of strings) {
      if (aKey !== bKey && b.includes(a)) {
        problems.push(`PLANTED.${bKey} contains PLANTED.${aKey} ("${a}")`)
      }
    }
  }
  return problems
}
