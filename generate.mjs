// generate.mjs
/**
 * Build the corpus.
 *
 *   node generate.mjs        →  corpus/*.pdf
 *
 * Each file carries something identifying that a document-properties clean
 * leaves behind, planted at known values so "did the tool remove it" has an
 * exact answer instead of an impression.
 */

import { PDFDocument, PDFName, PDFString, PDFHexString, PDFArray } from 'pdf-lib'
import { PLANTED, buildExifApp1, buildComSegment } from './lib/planted.mjs'
import { readJpegMetadata } from './lib/jpeg.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(ROOT, 'corpus')
const FIXTURE = path.join(ROOT, 'fixtures', 'photo.jpg')

function plantMetadata(cleanJpeg) {
  return Buffer.concat([
    Buffer.from(cleanJpeg.subarray(0, 2)),
    buildExifApp1(),
    buildComSegment(PLANTED.comment),
    Buffer.from(cleanJpeg.subarray(2)),
  ])
}

function applyDocumentMetadata(doc) {
  doc.setTitle(PLANTED.docTitle)
  doc.setAuthor(PLANTED.docAuthor)
  doc.setProducer(PLANTED.docProducer)
  doc.setSubject(PLANTED.docSubject)
  doc.setCreator('CorpusBuilder')
  doc.setKeywords(['confidential', 'internal'])
}

async function addImagePage(doc, jpeg) {
  const image = await doc.embedJpg(jpeg)
  const page = doc.addPage([320, 320])
  page.drawImage(image, { x: 30, y: 60, width: 260, height: 200 })
  return page
}

function addReviewAnnotation(doc, page) {
  const annot = doc.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Text'),
    Rect: doc.context.obj([12, 12, 36, 36]),
    T: PDFString.of(PLANTED.annotAuthor),
    Contents: PDFString.of(PLANTED.annotBody),
    M: PDFString.of(PLANTED.annotDate),
    CreationDate: PDFString.of(PLANTED.annotDate),
    RC: PDFHexString.fromText(`<p>${PLANTED.annotAuthor}: ${PLANTED.annotBody}</p>`),
  })
  const existing = page.node.Annots()
  if (existing instanceof PDFArray) existing.push(doc.context.register(annot))
  else page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]))
}

function addOpenActionJavaScript(doc) {
  const action = doc.context.obj({
    S: PDFName.of('JavaScript'),
    JS: PDFString.of(PLANTED.javascript),
  })
  doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(action))
}

const CASES = {
  'doc-metadata-only': async () => {
    const doc = await PDFDocument.create()
    applyDocumentMetadata(doc)
    doc.addPage([320, 320]).drawText('Document metadata only', { x: 40, y: 160, size: 12 })
    return doc
  },

  'image-exif-gps': async (jpeg) => {
    const doc = await PDFDocument.create()
    applyDocumentMetadata(doc)
    await addImagePage(doc, jpeg)
    return doc
  },

  'annotation-authorship': async () => {
    const doc = await PDFDocument.create()
    applyDocumentMetadata(doc)
    const page = doc.addPage([320, 320])
    page.drawText('Reviewed document', { x: 40, y: 160, size: 12 })
    addReviewAnnotation(doc, page)
    return doc
  },

  'embedded-attachment': async () => {
    const doc = await PDFDocument.create()
    applyDocumentMetadata(doc)
    doc.addPage([320, 320]).drawText('Has an attachment', { x: 40, y: 160, size: 12 })
    await doc.attach(Buffer.from(PLANTED.attachmentBody, 'utf8'), PLANTED.attachmentName, {
      mimeType: 'text/csv',
      description: 'internal compensation bands',
    })
    return doc
  },

  'javascript-openaction': async () => {
    const doc = await PDFDocument.create()
    applyDocumentMetadata(doc)
    doc.addPage([320, 320]).drawText('Runs script on open', { x: 40, y: 160, size: 12 })
    addOpenActionJavaScript(doc)
    return doc
  },

  everything: async (jpeg) => {
    const doc = await PDFDocument.create()
    applyDocumentMetadata(doc)
    const page = await addImagePage(doc, jpeg)
    addReviewAnnotation(doc, page)
    addOpenActionJavaScript(doc)
    await doc.attach(Buffer.from(PLANTED.attachmentBody, 'utf8'), PLANTED.attachmentName, {
      mimeType: 'text/csv',
      description: 'internal compensation bands',
    })
    return doc
  },

  /*
   * Control. The JPEG is Flate-wrapped on top of DCTDecode, so the bytes on
   * disk are not a JPEG. A tool should refuse this and say so; one that reports
   * it as cleaned is guessing.
   */
  'control-flate-wrapped-jpeg': async (jpeg) => {
    const doc = await PDFDocument.create()
    applyDocumentMetadata(doc)
    await addImagePage(doc, jpeg)

    // embedJpg only queues the embedding — without this the image XObject does
    // not exist yet and the control is silently identical to the plain case.
    await doc.flush()

    const zlib = await import('node:zlib')
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      const dict = obj?.dict
      if (!dict || typeof dict.get !== 'function') continue
      if (String(dict.get(PDFName.of('Subtype'))) !== '/Image') continue
      obj.contents = new Uint8Array(zlib.deflateSync(Buffer.from(obj.contents)))
      dict.set(
        PDFName.of('Filter'),
        doc.context.obj([PDFName.of('FlateDecode'), PDFName.of('DCTDecode')]),
      )
    }
    return doc
  },
}

async function main() {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`Missing fixtures/photo.jpg — see README.`)
    process.exit(2)
  }

  const raw = new Uint8Array(fs.readFileSync(FIXTURE))
  const cleaned = readJpegMetadata(raw)
  if (!cleaned) {
    console.error('fixtures/photo.jpg could not be parsed as a JPEG.')
    process.exit(2)
  }

  // Strip whatever the source photo arrived with, so the only metadata in the
  // corpus is the metadata we put there.
  const jpeg = plantMetadata(Buffer.from(cleaned.stripped))

  fs.mkdirSync(OUT, { recursive: true })
  for (const [name, build] of Object.entries(CASES)) {
    const doc = await build(jpeg)
    // Object streams off so the corpus is greppable by hand — anyone checking
    // our published claims should not have to trust our verifier to do it.
    const bytes = await doc.save({ useObjectStreams: false })
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), bytes)
    console.log(`  ${name}.pdf  (${bytes.length.toLocaleString()} bytes)`)
  }

  console.log(`\n${Object.keys(CASES).length} files in corpus/`)
  console.log('Next: run each through a tool, save output to results/<tool>/, then `node verify.mjs`')
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
