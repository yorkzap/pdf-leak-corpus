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

  /*
   * An attachment that never appears in the catalog's name tree.
   *
   * This is what Acrobat's "attach a file as a comment" produces: the file
   * specification hangs off a /FileAttachment annotation's /FS. A cleaner that
   * walks /Names -> /EmbeddedFiles and stops there hands the payload back
   * intact, with the viewer's attachments pane showing nothing.
   */
  'attachment-via-annotation': async () => {
    const doc = await PDFDocument.create()
    applyDocumentMetadata(doc)
    const page = doc.addPage([320, 320])
    page.drawText('Attachment hangs off an annotation', { x: 40, y: 160, size: 11 })

    const stream = doc.context.flateStream(Buffer.from(PLANTED.attachmentBody, 'utf8'))
    const spec = doc.context.obj({
      Type: PDFName.of('Filespec'),
      F: PDFString.of(PLANTED.attachmentName),
      UF: PDFString.of(PLANTED.attachmentName),
      EF: doc.context.obj({ F: doc.context.register(stream) }),
    })
    const annot = doc.context.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('FileAttachment'),
      Rect: doc.context.obj([12, 12, 36, 36]),
      FS: doc.context.register(spec),
    })
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]))
    return doc
  },

  /*
   * The same script, written inline instead of as its own object.
   *
   * Most producers emit actions this way. A sweep that enumerates indirect
   * objects looking for /S /JavaScript cannot see it: the action is a direct
   * value inside the annotation, never an object in its own right.
   */
  'javascript-inline-action': async () => {
    const doc = await PDFDocument.create()
    applyDocumentMetadata(doc)
    const page = doc.addPage([320, 320])
    page.drawText('Script inline on a link', { x: 40, y: 160, size: 11 })
    const annot = doc.context.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('Link'),
      Rect: doc.context.obj([40, 150, 240, 175]),
      A: doc.context.obj({ S: PDFName.of('JavaScript'), JS: PDFString.of(PLANTED.javascript) }),
    })
    page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]))
    return doc
  },

  /*
   * A dynamic XFA form.
   *
   * Its XML carries an XMP packet repeating the author from the Info
   * dictionary, inside a compressed stream hanging off /AcroForm — where
   * deleting document properties does not reach it and a text search of the
   * file cannot see it.
   *
   * This case scores in both directions. The author must go; the template and
   * the typed-in value must stay. See MUST_SURVIVE in lib/planted.mjs.
   */
  'xfa-form-xmp': async () => {
    const doc = await PDFDocument.create()
    applyDocumentMetadata(doc)
    doc.addPage([320, 320]).drawText('Dynamic XFA form', { x: 40, y: 160, size: 11 })

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">',
      '<template><subform name="form1"><field name="applicant"><ui><textEdit/></ui>',
      `<desc>${PLANTED.xfaTemplate}</desc></field></subform></template>`,
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
      ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">',
      `   <dc:creator><rdf:Seq><rdf:li>${PLANTED.xfaAuthor}</rdf:li></rdf:Seq></dc:creator>`,
      '  </rdf:Description>',
      ' </rdf:RDF>',
      '</x:xmpmeta>',
      '<?xpacket end="w"?>',
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/">',
      `<xfa:data><form1><applicant>${PLANTED.xfaValue}</applicant></form1></xfa:data>`,
      '</xfa:datasets>',
      '</xdp:xdp>',
    ].join('\n')

    const stream = doc.context.flateStream(Buffer.from(xml, 'utf8'))
    const acro = doc.context.obj({ Fields: doc.context.obj([]) })
    acro.set(PDFName.of('XFA'), doc.context.register(stream))
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(acro))
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
