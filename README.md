# pdf-leak-corpus

A test corpus for checking what PDF metadata removers actually remove.

You put a PDF through a metadata remover. You check it with ExifTool. ExifTool
reports nothing. The file is clean.

Except the photograph inside it still has GPS coordinates, because ExifTool run
against a PDF reports on the PDF, not on the images inside it. And if you check
with `qpdf --qdf` instead, qpdf garbage-collects unreferenced objects while
rewriting — so anything the tool unlinked but did not delete disappears from the
expanded output while remaining in the real file.

Both of the obvious ways of checking your work can report a leaking file as
clean. This repository is a way to find out for certain.

## What it does

`generate.mjs` writes seven PDFs with known values planted in known places: a
photograph carrying camera make, model, a photographer name and GPS coordinates
at a fixed latitude; a comment annotated with a reviewer's name and timestamp;
an embedded spreadsheet; a script set to run on open; and ordinary document
properties.

`verify.mjs` reads a PDF back and looks for exactly those values. Because the
values are fixed, "did the tool remove it" has an exact answer rather than an
impression — and a result from one tool is directly comparable to a result from
another.

## Usage

```bash
npm install
node generate.mjs          # writes corpus/*.pdf
```

Put each corpus file through the tool you want to test, save the output into
`results/<tool>/` under the same filename, then:

```bash
node verify.mjs            # checks every results/<tool>/
node verify.mjs results/pdf24
node verify.mjs corpus     # sanity check: the untouched corpus should fail everything
```

Exit code is 1 if anything planted is still present, so this works as a
regression test if you are building one of these tools.

Testing one file is enough for a quick answer — use `everything.pdf`, which
contains all five leak classes at once.

## The files

| File | Contains |
|---|---|
| `doc-metadata-only.pdf` | Ordinary document properties and nothing else |
| `image-exif-gps.pdf` | A photograph with EXIF, GPS and a comment segment |
| `annotation-authorship.pdf` | A review comment with an author name and timestamp |
| `embedded-attachment.pdf` | An attached CSV |
| `javascript-openaction.pdf` | A script set to run when the document opens |
| `everything.pdf` | All of the above in one file |
| `control-flate-wrapped-jpeg.pdf` | A JPEG wrapped in a second compression layer |

The control is the interesting one. Its image bytes are not a JPEG on disk, so a
tool cannot strip the EXIF without decompressing and re-compressing — which
changes how the picture looks. The correct behaviour is to refuse and say so. A
tool that reports this file as cleaned is guessing.

## How it checks

Three passes, because each one alone has a blind spot:

- **Structural** — walk the object graph and look for the fields themselves.
  Misses anything unlinked but not deleted.
- **Raw bytes** — search the file for the planted strings. Misses anything inside
  a Flate-compressed object stream.
- **Decoded** — serialize every parsed indirect object, orphans included, and
  search that. This is the pass that catches objects nothing points at, which are
  invisible to the byte scan when compressed and invisible to `qpdf --qdf`
  because qpdf collects them before you can look.

Annotation comment text is reported separately as *retained by design*. It is
page content, visible in any viewer that renders comments, and a tool that leaves
it is not failing. It is printed anyway, because someone sanitizing a reviewed
document usually has not thought about the review notes travelling with it.

## Results as of 14 August 2026

Each tool was given `everything.pdf` through its normal web interface and the
returned file inspected.

| Tool | Doc properties | Image GPS | Annotation author | Attachment | JavaScript |
|---|---|---|---|---|---|
| [Lyonite](https://lyonite.com/pdf/metadata/remove) | removed | removed | removed | removed | removed |
| [GroupDocs](https://products.groupdocs.app/metadata/remove-from-pdf) | partly | left in | left in | removed | left in |
| [IronSoftware](https://ironsoftware.com/free-tools/remove-pdf-metadata/) | removed | left in | left in | left in | left in |
| [PDF24](https://tools.pdf24.org/en/remove-pdf-metadata) | removed | left in | left in | left in | left in |
| [PDFYeah](https://www.pdfyeah.com/remove-pdf-metadata/) | removed | left in | left in | left in | left in |
| [Metadata2Go](https://www.metadata2go.com/delete-metadata) | left in | left in | left in | left in | left in |
| [PDF Candy](https://pdfcandy.com/remove-metadata.html) | left in | left in | left in | left in | left in |

Of the six free online tools: **none** removed the GPS from the photograph,
**none** removed the script, **one** removed the attachment, and **three** fully
removed the ordinary document properties.

### Do they do what they claim?

That is the fairer question, and the answer is more interesting than the table.

- **IronSoftware** describes its scope as "supported metadata fields", names
  them, and removes them. It is the least ambitious tool tested and the only one
  whose description of itself we could not fault.
- **PDF24** says it will "delete all metadata contained in PDF files". It left
  the GPS, the script, the attachment and the document ID.
- **Metadata2Go** explains that metadata "can include sensitive details like your
  location". Location is the specific harm it names. The coordinates came back
  untouched.
- **PDF Candy** lists the fields it removes, offers a "Delete all metadata"
  action, and returned those exact fields unchanged with the action applied.

So most of these tools are not broken. "Remove PDF metadata" just means something
much narrower to the people building them than it does to someone about to send
a document to a stranger — and where the wording promises more, it tends to
promise precisely what is not delivered.

## Disclosure

This corpus was built by [Lyonite](https://lyonite.com), which makes one of the
tools in the table, and which comes first in it.

Lyonite failed this same test until 13 August 2026. Writing the verifier also
turned up a second bug in our own fix: deleting the `/OpenAction` reference to a
script removed the reference and not the script, so the object stayed registered
and shipped in the output. It took the third check to see it.

That is the reason everything here is published rather than described. The claim
is not "trust us", it is "here is the file, run it yourself". If you test a tool
we have not, or get a different result on one we have, please open an issue — a
correction is more useful to us than the original result.

## Limits

One file, one run, one day, through each tool's normal web interface. A tool may
behave differently on a different document, and any of these may improve after
publication. Re-running takes one command, which is the point.

This tests metadata removal, not anonymity. A PDF can identify its author through
the writing itself, a signature image, a letterhead, the particular subset of
fonts an installation embeds, or text sitting under a black rectangle that was
drawn rather than applied as a redaction. If your safety depends on a document
not being traced to you, cleaning its metadata is one step in a longer process,
and the last step should not be an automated one.

## License

MIT. The fixture photograph is a macOS system wallpaper, included only as a
carrier for planted EXIF; its metadata is stripped before anything is planted.
