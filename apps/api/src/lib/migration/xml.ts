// Tiny, non-validating XML reader. DTDs/entities are refused outright (no external entity or expansion attacks) and nothing is ever executed.

export type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string };

export class XmlError extends Error {}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export const decodeEntities = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
  if (entity[0] === '#') {
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  }
  return NAMED[entity.toLowerCase()] ?? whole;
});

const MAX_DEPTH = 64;

export function parseXml(source: string): XmlNode {
  if (/<!DOCTYPE/i.test(source) && /<!ENTITY/i.test(source)) throw new XmlError('XML com declaração de entidades (DTD) não é aceito por segurança.');
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0; let match: RegExpExecArray | null;
  const addText = (text: string) => { stack[stack.length - 1].text += text; };
  while ((match = tag.exec(source))) {
    addText(decodeEntities(source.slice(last, match.index))); last = tag.lastIndex;
    if (match[1] !== undefined) { addText(match[1]); continue; }
    if (match[2] !== undefined) {
      if (stack.length > 1 && stack[stack.length - 1].name === match[2]) stack.pop();
      else throw new XmlError(`Tag de fechamento inesperada </${match[2]}>.`);
      continue;
    }
    if (match[3] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const attr of match[4].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[attr[1]] = decodeEntities(attr[2] ?? attr[3] ?? '');
      const node: XmlNode = { name: match[3], attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!match[5]) { stack.push(node); if (stack.length > MAX_DEPTH) throw new XmlError('XML com aninhamento excessivo.'); }
    }
  }
  if (stack.length > 1) throw new XmlError('XML incompleto: há tags sem fechamento (arquivo truncado?).');
  return root;
}

export const localName = (name: string) => name.slice(name.indexOf(':') + 1);
export function childrenNamed(node: XmlNode, name: string): XmlNode[] { return node.children.filter(child => localName(child.name) === name); }
export function textOf(node: XmlNode): string { return node.text + node.children.map(textOf).join(''); }
