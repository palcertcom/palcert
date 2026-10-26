import { createHash } from 'node:crypto';
import { buildZip, contentTypesXml, ROOT_RELS } from './fixtures';

/**
 * The real-world case: PhD_Template_00.docx, the thesis template that was
 * refused with FILE_EMBEDDED_OBJECT_UNSUPPORTED.
 *
 * Kept here as its exact equation — not the whole template, which belongs to
 * the institution — so the classifier is tested against what MathType
 * actually wrote rather than against a structure PalCert invented:
 *
 * - `word/embeddings/oleObject1.bin`, byte for byte (3584 bytes, SHA-256
 *   604f48107fffd5032f8daf527ed8e718b97bb3bb472f9666a06fa25bdaa9b96b):
 *   root CLSID {0002CE03-0000-0000-C000-000000000046}, streams
 *   `\1Ole`, `\1CompObj`, `\3ObjInfo`, `Equation Native` (MTEF, 465 bytes
 *   after a 28-byte header), CompObj "MathType 6.0 Equation" / "Equation.DSMT4";
 * - its preview, `word/media/image5.wmf`, byte for byte;
 * - the paragraph that holds it, verbatim from `word/document.xml`, with the
 *   document root's namespace declarations and the real relationship ids
 *   (rId14 image, rId15 oleObject);
 * - the real content-type defaults for `.bin` and `.wmf`.
 *
 * Base64 rather than a binary file, and checked against its digest on load,
 * so a changed byte is a failing test, not a silently different fixture.
 */

export const REAL_OLE_OBJECT_SHA256 =
  '604f48107fffd5032f8daf527ed8e718b97bb3bb472f9666a06fa25bdaa9b96b';

const REAL_OLE_OBJECT_BASE64 =
  '0M8R4KGxGuEAAAAAAAAAAAAAAAAAAAAAPgADAP7/CQAGAAAAAAAAAAAAAAABAAAAAQAAAAAAAAAAEAAAAgAAAAEAAAD+////' +
  'AAAAAAAAAAD/////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '///////////9////BAAAAP7///8FAAAA/v////7/////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '/////////////////////1IAbwBvAHQAIABFAG4AdAByAHkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAWAAUA//////////8CAAAAA84CAAAAAADAAAAAAAAARgAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAADAAAAAAAA' +
  'AQBPAGwAZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoAAgH/////' +
  '//////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAAAAAAAAABAEMAbwBtAHAATwBiAGoA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEgACAQEAAAADAAAA/////wAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAABpAAAAAAAAAAMATwBiAGoASQBuAGYAbwAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASAAIB/////wQAAAD/////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAwAAAAYAAAAAAAAA/v///wIAAAD+/////v///wUAAAAGAAAABwAAAAgAAAAJAAAACgAAAAsAAAD+////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////////////////////////////////////////////////' +
  '//////////////////////////////////////////8BAAACCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQD+/wMKAAD/////A84CAAAAAADAAAAAAAAARhYAAABNYXRoVHlwZSA2LjAgRXF1' +
  'YXRpb24ADAAAAE1hdGhUeXBlIEVGAA8AAABFcXVhdGlvbi5EU01UNAD0ObJxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAMAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'HAAAAAIANcLRAQAAnAA0AKg5VAAAAAAADAA0AAUBAAYGRFNNVDYAARNXaW5BbGxCYXNpY0NvZGVQYWdlcwARBVRpbWVzIE5l' +
  'dyBSb21hbgARA1N5bWJvbAARBUNvdXJpZXIgTmV3ABEETVQgRXh0cmEAEgAIIS9Fj0QvQVD0EA9HX0FQ8h8eQVD0FQ9BAPRF' +
  '9CX0j0JfQQD0EA9DX0EA9I9F9CpfSPSPQQD0EA9A9I9Bf0j0EA9BKl9EX0X0X0X0X0EPDAEAAQABAgICAgACAAEBAQADAAEA' +
  'BAAACgEAAwAXEAABAAICgnMAAgCCdQACAIJwAAALAQADAAEDAAEAAkUAcQB1AGEAdABpAG8AbgAgAE4AYQB0AGkAdgBlAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAIA////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAABAAAAO0BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAD///////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAP///////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////////////////' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIN4AAIAgiwAAgCDeQAAAgCWKAACAJYp' +
  'AAACAJgI7wIAmAjvAgSGCCLOAgCYCO8IAQECAH9SAAMAHAAADAEBAQACAIgyAAAAAAsBAQAKAwAEAwABAAIAg0UAAgCDZgAD' +
  'ABsAAAsBAAIAg24AAAEBAAoDAAEDAAEAAgCDeAACAIIsAAIAg3kAAAIAligAAgCWKQAAAgSGEiItAgCDZgADAAEDAAEAAgCD' +
  'eAACAIIsAAIAg3kAAAIAligAAgCWKQAAAAIAlgfsAgCWCOwAAgSGPQA9AgCDbwACAIIoAAIAiDEAAgCCKQACAIIuAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const REAL_PREVIEW_WMF_SHA256 = 'a3e51d5bf2b5c9f6ec1f8db22b63f70577098f229ed05e47b8e556c948c3fe14';

const REAL_PREVIEW_WMF_BASE64 =
  '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' +
  'BAAAAC0BAwAEAAAA8AECAAMAAAAAAA==';

function verified(base64: string, sha256: string): Buffer {
  const bytes = Buffer.from(base64, 'base64');
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) throw new Error(`real-template fixture changed: ${actual}`);
  return bytes;
}

/** The exact embedded object from the real template. */
export function realPhdOleObject(): Buffer {
  return verified(REAL_OLE_OBJECT_BASE64, REAL_OLE_OBJECT_SHA256);
}

export function realPhdPreviewWmf(): Buffer {
  return verified(REAL_PREVIEW_WMF_BASE64, REAL_PREVIEW_WMF_SHA256);
}

/** `<w:document …>` exactly as the real template opens it. */
export const REAL_DOCUMENT_ROOT =
  '<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex" xmlns:cx2="http://schemas.microsoft.com/office/drawing/2015/10/21/chartex" xmlns:cx3="http://schemas.microsoft.com/office/drawing/2016/5/9/chartex" xmlns:cx4="http://schemas.microsoft.com/office/drawing/2016/5/10/chartex" xmlns:cx5="http://schemas.microsoft.com/office/drawing/2016/5/11/chartex" xmlns:cx6="http://schemas.microsoft.com/office/drawing/2016/5/12/chartex" xmlns:cx7="http://schemas.microsoft.com/office/drawing/2016/5/13/chartex" xmlns:cx8="http://schemas.microsoft.com/office/drawing/2016/5/14/chartex" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:aink="http://schemas.microsoft.com/office/drawing/2016/ink" xmlns:am3d="http://schemas.microsoft.com/office/drawing/2017/model3d" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:oel="http://schemas.microsoft.com/office/2019/extlst" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml" xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du" xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash" xmlns:w16sdtfl="http://schemas.microsoft.com/office/word/2024/wordml/sdtformatlock" xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 w15 w16se w16cid w16 w16cex w16sdtdh w16sdtfl w16du wp14">';

/** The paragraph holding equation (3.1), verbatim. */
export const REAL_EQUATION_PARAGRAPH =
  '<w:p w14:paraId="7550D232" w14:textId="77777777" w:rsidR="007C1E25" w:rsidRDefault="007C1E25" w:rsidP="005B10AD"><w:pPr><w:pStyle w:val="BodyFirst"/><w:spacing w:before="100" w:beforeAutospacing="1" w:after="100" w:afterAutospacing="1"/><w:ind w:left="113" w:firstLine="289"/><w:jc w:val="both"/></w:pPr><w:r w:rsidRPr="00CC5F6D"><w:t xml:space="preserve"> </w:t></w:r><w:r w:rsidRPr="004739E8"><w:t xml:space="preserve">   </w:t></w:r><w:r w:rsidRPr="004739E8"><w:object w:dxaOrig="3500" w:dyaOrig="580" w14:anchorId="55FDA17F"><v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" o:preferrelative="t" path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f"><v:stroke joinstyle="miter"/><v:formulas><v:f eqn="if lineDrawn pixelLineWidth 0"/><v:f eqn="sum @0 1 0"/><v:f eqn="sum 0 0 @1"/><v:f eqn="prod @2 1 2"/><v:f eqn="prod @3 21600 pixelWidth"/><v:f eqn="prod @3 21600 pixelHeight"/><v:f eqn="sum @0 0 1"/><v:f eqn="prod @6 1 2"/><v:f eqn="prod @7 21600 pixelWidth"/><v:f eqn="sum @8 21600 0"/><v:f eqn="prod @7 21600 pixelHeight"/><v:f eqn="sum @10 21600 0"/></v:formulas><v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/><o:lock v:ext="edit" aspectratio="t"/></v:shapetype><v:shape id="_x0000_i1025" type="#_x0000_t75" style="width:147pt;height:30pt" o:ole=""><v:imagedata r:id="rId14" o:title=""/></v:shape><o:OLEObject Type="Embed" ProgID="Equation.DSMT4" ShapeID="_x0000_i1025" DrawAspect="Content" ObjectID="_1851923692" r:id="rId15"/></w:object></w:r><w:r w:rsidRPr="004739E8"><w:t xml:space="preserve">                              </w:t></w:r><w:r w:rsidRPr="004739E8"><w:rPr><w:rtl/></w:rPr><w:t xml:space="preserve">  </w:t></w:r><w:r w:rsidRPr="004739E8"><w:t>(3.1)</w:t></w:r></w:p>';

/**
 * A package carrying the real equation exactly as the template does: same
 * root, same paragraph, same relationship ids and targets, same content-type
 * defaults, same object and preview bytes. `overrides` swaps one piece, for
 * the tests that prove a change to any of them is refused.
 */
export function realPhdEquationDocx(
  overrides: { readonly oleObject?: Buffer; readonly paragraph?: string } = {},
): Buffer {
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    REAL_DOCUMENT_ROOT +
    '<w:body><w:p><w:r><w:t>3.3 Equations:</w:t></w:r></w:p>' +
    (overrides.paragraph ?? REAL_EQUATION_PARAGRAPH) +
    '</w:body></w:document>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId14" Type="${REL}/image" Target="media/image5.wmf"/>` +
    `<Relationship Id="rId15" Type="${REL}/oleObject" Target="embeddings/oleObject1.bin"/>` +
    '</Relationships>';
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: contentTypesXml(
        undefined,
        '<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>' +
          '<Default Extension="wmf" ContentType="image/x-wmf"/>',
      ),
    },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: rels },
    { name: 'word/embeddings/oleObject1.bin', data: overrides.oleObject ?? realPhdOleObject() },
    { name: 'word/media/image5.wmf', data: realPhdPreviewWmf() },
  ]);
}

/**
 * The whole template, when a copy is available locally
 * (`PALCERT_REAL_TEMPLATE=/path/PhD_Template_00.docx`). It is used unmodified.
 */
export const REAL_TEMPLATE_SHA256 =
  '9dc513105b8f6a3b7db7050956e5488fb19671ea69c7363b372eb2707d5b77fb';
