import { createHash, createSign, createVerify, X509Certificate } from 'node:crypto';

// ---- Canonical XML builder: no whitespace, explicit end tags, escaped text, attributes in lexical order (already C14N form) ----
export const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';
const escText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
// Fiscal text fields: single spaces, no control characters, trimmed (SEFAZ rejects leading/trailing blanks).
export const clean = (value: string, max: number) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

type Child = string | null | undefined | false;
// Element with escaped text content. Returns '' for null/undefined/'' so optional tags simply disappear.
export function t(tag: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return `<${tag}>${escText(String(value))}</${tag}>`;
}
// Element whose children are already-built XML. xmlns (if any) must come first, the remaining attributes are sorted as C14N requires.
export function g(tag: string, children: Child[] | string, attrs: Record<string, string | undefined> = {}): string {
  const { xmlns, ...rest } = attrs;
  const attrText = (xmlns ? ` xmlns="${escAttr(xmlns)}"` : '') + Object.keys(rest).filter(key => rest[key] !== undefined).sort().map(key => ` ${key}="${escAttr(rest[key]!)}"`).join('');
  const body = Array.isArray(children) ? children.filter(Boolean).join('') : children;
  return `<${tag}${attrText}>${body}</${tag}>`;
}

// ---- Linear-time readers for SEFAZ answers (no regex backtracking on untrusted XML) ----
export function block(xml: string, tag: string, from = 0): string | null {
  const open = xml.indexOf(`<${tag}`, from); if (open < 0) return null;
  const after = xml[open + tag.length + 1];
  if (after !== '>' && after !== ' ' && after !== '/') return block(xml, tag, open + 1);
  const close = xml.indexOf(`</${tag}>`, open); if (close < 0) return null;
  return xml.slice(open, close + tag.length + 3);
}
export function value(xml: string | null, tag: string): string | null {
  if (!xml) return null;
  const node = block(xml, tag); if (!node) return null;
  const start = node.indexOf('>') + 1;
  return node.slice(start, node.length - tag.length - 3).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
// Removes the SOAP wrapper and namespace prefixes of the envelope so blocks can be read by local name.
export function soapBody(xml: string): string {
  const start = xml.search(/<(\w+:)?Body[\s>]/); if (start < 0) return xml;
  const content = xml.slice(xml.indexOf('>', start) + 1);
  const end = content.search(/<\/(\w+:)?Body>/);
  return end < 0 ? content : content.slice(0, end);
}

// ---- XMLDSig (enveloped, RSA-SHA1/SHA1, inclusive C14N) as required by the NF-e/NFC-e layouts ----
const canonicalWithNs = (element: string, tag: string, ns: string) => (element.startsWith(`<${tag} xmlns=`) ? element : element.replace(`<${tag}`, `<${tag} xmlns="${ns}"`));
function signedInfo(id: string, digest: string) {
  return g('SignedInfo', [
    g('CanonicalizationMethod', '', { Algorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315' }),
    g('SignatureMethod', '', { Algorithm: `${DSIG_NS}rsa-sha1` }),
    g('Reference', [
      g('Transforms', [g('Transform', '', { Algorithm: `${DSIG_NS}enveloped-signature` }), g('Transform', '', { Algorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315' })]),
      g('DigestMethod', '', { Algorithm: `${DSIG_NS}sha1` }), t('DigestValue', digest),
    ], { URI: `#${id}` }),
  ]);
}
const pemBody = (pem: string) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');

export type SignResult = { xml: string; digest: string; signature: string };
// Signs the element `tag` (identified by its Id attribute) and inserts the <Signature> right after it, inside the same parent.
export function signXml(xml: string, tag: string, keys: { keyPem: string; certPem: string }, ns = NFE_NS): SignResult {
  const element = block(xml, tag); if (!element) throw new Error(`Elemento ${tag} não encontrado para assinatura.`);
  const id = /\sId="([^"]+)"/.exec(element.slice(0, element.indexOf('>')))?.[1]; if (!id) throw new Error(`Elemento ${tag} sem atributo Id.`);
  const digest = createHash('sha1').update(canonicalWithNs(element, tag, ns), 'utf8').digest('base64');
  const info = signedInfo(id, digest);
  const signature = createSign('RSA-SHA1').update(canonicalWithNs(info, 'SignedInfo', DSIG_NS), 'utf8').sign(keys.keyPem, 'base64');
  const signatureXml = g('Signature', [info, t('SignatureValue', signature), g('KeyInfo', [g('X509Data', [t('X509Certificate', pemBody(keys.certPem))])])], { xmlns: DSIG_NS });
  const end = xml.indexOf(element) + element.length;
  return { xml: xml.slice(0, end) + signatureXml + xml.slice(end), digest, signature };
}

// Verifies a signature produced for `tag` (digest of the referenced element + RSA signature with the embedded certificate).
export function verifyXmlSignature(xml: string, tag: string, ns = NFE_NS): boolean {
  const element = block(xml, tag); const signature = block(xml, 'Signature'); if (!element || !signature) return false;
  const info = block(signature, 'SignedInfo')!; const certB64 = value(signature, 'X509Certificate'); const sigValue = value(signature, 'SignatureValue');
  if (!certB64 || !sigValue) return false;
  const digest = createHash('sha1').update(canonicalWithNs(element, tag, ns), 'utf8').digest('base64');
  if (digest !== value(info, 'DigestValue')) return false;
  const cert = new X509Certificate(Buffer.from(certB64, 'base64'));
  return createVerify('RSA-SHA1').update(canonicalWithNs(info, 'SignedInfo', DSIG_NS), 'utf8').verify(cert.publicKey, sigValue, 'base64');
}

// Plain RSA-SHA1 signature (QR Code v3 off-line).
export const rsaSha1 = (text: string, keyPem: string) => createSign('RSA-SHA1').update(text, 'utf8').sign(keyPem, 'base64');
