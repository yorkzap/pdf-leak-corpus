// verify.mjs
/**
 * Check what a tool left in the file.
 *
 *   node verify.mjs                 every results/<tool>/
 *   node verify.mjs results/pdf24   one directory
 *   node verify.mjs corpus          the untouched corpus (everything should fail)
 *
 * Three checks run against each file, because each one alone has a blind spot
 * that lets a leaking file pass:
 *
 *   structural  walk the object graph and look for the fields themselves.
 *               Misses anything unlinked but not deleted.
 *
 *   raw bytes   search the file for the planted strings.
 *               Misses anything inside a Flate-compressed object stream.
 *
 *   decoded     serialize every parsed indirect object, orphans included, and
 *               search that. This is the one that catches unlinked-but-present
 *               objects — which are invisible to the byte scan when compressed,
 *               and invisible to `qpdf --qdf` because qpdf garbage-collects
 *               unreferenced objects while rewriting. Both of the obvious ways
 *               of checking your work can report a leaking file as clean.
 *
 * Exits 1 if anything planted is still present.
 */

import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream } from 'pdf-lib'
import { readJpegMetadata } from './lib/jpeg.mjs'
import { MARKERS, CONTENT_CLASS } from './lib/planted.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const CLASSES = ['doc', 'image', 'annot', 'attach', 'js']
const LABEL = { doc: 'doc props', image: 'image GPS', annot: 'annot author', attach: 'attachment', js: 'javascript' }

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  amber: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

/** Everything in the file, decompressed — see the header note. */
function decodedText(doc) {
  const parts = []
  try {
    for (const [, o] of doc.context.enumerateIndirectObjects()) {
      try {
        parts.push(o instanceof PDFRawStream ? o.dict.toString() : o.toString())
      } catch {
        /* an object that will not serialize contributes nothing */
      }
    }
  } catch {
    /* fall back to the raw scan alone */
  }
  return parts.join('\n')
}

function findMarkers(bytes, decoded) {
  const hay = Buffer.from(bytes).toString('latin1') + '\n' + decoded
  const hits = []
  for (const [cls, label, needle] of MARKERS) {
    if (!needle) continue
    // PDF strings may be stored as UTF-16BE, literally, or hex-encoded.
    const utf16 = Buffer.from(needle, 'utf16le').swap16().toString('latin1')
    const hex = Buffer.from(needle, 'utf16le').swap16().toString('hex')
    if (hay.includes(needle) || hay.includes(utf16) || hay.toLowerCase().includes(hex.toLowerCase())) {
      hits.push({ cls, label })
    }
  }
  return hits
}

async function inspect(bytes) {
  const out = {
    unreadable: false,
    infoFields: [],
    xmp: false,
    trailerId: false,
    images: 0,
    imagesWithMetadata: 0,
    imageSegments: new Set(),
    annots: 0,
    annotAuthors: 0,
    annotDates: 0,
    attachments: false,
    scriptObjects: 0,
    openAction: false,
    decoded: '',
  }

  let doc
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  } catch {
    out.unreadable = true
    return out
  }
  const ctx = doc.context
  out.decoded = decodedText(doc)

  try {
    const ref = ctx.trailerInfo?.Info
    const info = ref ? ctx.lookupMaybe(ref, PDFDict) : null
    if (info) for (const [k] of info.entries()) out.infoFields.push(String(k).replace(/^\//, ''))
    out.trailerId = !!ctx.trailerInfo?.ID
  } catch { /* leave defaults */ }

  try {
    out.xmp = !!doc.catalog?.get(PDFName.of('Metadata'))
    out.openAction = !!doc.catalog?.get(PDFName.of('OpenAction'))
    const names = ctx.lookupMaybe(doc.catalog?.get(PDFName.of('Names')), PDFDict)
    if (names) out.attachments = !!names.get(PDFName.of('EmbeddedFiles'))
  } catch { /* leave defaults */ }

  try {
    for (const [, o] of ctx.enumerateIndirectObjects()) {
      if (o instanceof PDFDict) {
        if (String(o.get(PDFName.of('S'))) === '/JavaScript' || o.has(PDFName.of('JS'))) {
          out.scriptObjects += 1
        }
        continue
      }
      if (!(o instanceof PDFRawStream)) continue
      if (String(o.dict.get(PDFName.of('Subtype'))) !== '/Image') continue
      out.images += 1
      const probe = readJpegMetadata(o.contents)
      if (probe && probe.found.length) {
        out.imagesWithMetadata += 1
        probe.found.forEach((s) => out.imageSegments.add(s))
      }
    }
  } catch { /* leave defaults */ }

  try {
    for (const page of doc.getPages()) {
      const a = typeof page.node.Annots === 'function' ? page.node.Annots() : undefined
      if (!(a instanceof PDFArray)) continue
      for (let i = 0; i < a.size(); i++) {
        const an = ctx.lookupMaybe(a.get(i), PDFDict)
        if (!an) continue
        out.annots += 1
        if (an.get(PDFName.of('T'))) out.annotAuthors += 1
        if (an.get(PDFName.of('M')) || an.get(PDFName.of('CreationDate'))) out.annotDates += 1
      }
    }
  } catch { /* leave defaults */ }

  return out
}

function classify(x, hits) {
  const has = (cls) => hits.some((h) => h.cls === cls)
  return {
    doc: x.infoFields.length > 0 || x.xmp || has('doc'),
    image: x.imagesWithMetadata > 0 || has('image'),
    annot: x.annotAuthors > 0 || has('annot'),
    attach: x.attachments || has('attach'),
    js: x.scriptObjects > 0 || x.openAction || has('js'),
  }
}

async function checkDir(dir) {
  const name = path.basename(dir)
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort()
  const rows = []
  for (const f of files) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(dir, f)))
    const x = await inspect(bytes)
    const hits = findMarkers(bytes, x.decoded)
    rows.push({
      file: f,
      x,
      hits,
      leaks: classify(x, hits),
      isControl: f.startsWith('control-'),
    })
  }
  return { name, rows }
}

function render(sets) {
  const w = Math.max(26, ...sets.flatMap((s) => s.rows.map((r) => r.file.length + 2)))
  let failures = 0

  for (const { name, rows } of sets) {
    console.log(`\n${C.bold(name)}`)
    console.log(`  ${'file'.padEnd(w)}${CLASSES.map((c) => LABEL[c].padEnd(15)).join('')}`)
    console.log(`  ${'─'.repeat(w + CLASSES.length * 15)}`)

    for (const r of rows) {
      const cells = CLASSES.map((c) => {
        if (r.x.unreadable) return '?'.padEnd(15)
        if (r.isControl && c === 'image') return C.amber('skip'.padEnd(15))
        return r.leaks[c] ? C.red('LEFT IN'.padEnd(15)) : C.green('removed'.padEnd(15))
      })
      console.log(`  ${r.file.padEnd(w)}${cells.join('')}`)

      const real = CLASSES.filter((c) => r.leaks[c] && !(r.isControl && c === 'image'))
      if (real.length) {
        failures += 1
        const hard = r.hits.filter((h) => h.cls !== CONTENT_CLASS).map((h) => h.label)
        if (hard.length) console.log(`  ${' '.repeat(w)}${C.dim('found: ' + hard.join(', '))}`)
        if (r.x.imageSegments.size) {
          console.log(`  ${' '.repeat(w)}${C.dim('image segments: ' + [...r.x.imageSegments].join(', '))}`)
        }
        if (r.x.infoFields.length) {
          console.log(`  ${' '.repeat(w)}${C.dim('info fields: ' + r.x.infoFields.join(', '))}`)
        }
        if (r.x.scriptObjects) {
          console.log(`  ${' '.repeat(w)}${C.dim(r.x.scriptObjects + ' script object(s) still registered')}`)
        }
      }

      const retained = r.hits.filter((h) => h.cls === CONTENT_CLASS).map((h) => h.label)
      if (retained.length) {
        console.log(`  ${' '.repeat(w)}${C.dim('retained by design (page content): ' + retained.join(', '))}`)
      }
      if (r.x.unreadable) console.log(`  ${' '.repeat(w)}${C.dim('could not be parsed as a PDF')}`)
    }
  }

  console.log()
  console.log(failures ? C.red(`${failures} file(s) still carry planted data.`) : C.green('Nothing planted was found.'))
  return failures
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  let dirs

  if (args.length) {
    dirs = args.map((d) => path.resolve(ROOT, d))
  } else {
    const results = path.join(ROOT, 'results')
    dirs = fs.existsSync(results)
      ? fs.readdirSync(results).map((d) => path.join(results, d)).filter((d) => fs.statSync(d).isDirectory())
      : []
  }

  if (!dirs.length) {
    console.error('Nothing to check. Put tool output in results/<tool>/, or pass a directory.')
    process.exit(2)
  }

  const sets = []
  for (const d of dirs) sets.push(await checkDir(d))
  process.exit(render(sets) ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
