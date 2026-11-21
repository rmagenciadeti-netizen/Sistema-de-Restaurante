import { normalizeText } from './whatsapp-text';

// Understanding what a customer wrote, without a model and without state: slang, abbreviations, typos, several subjects in one message.
// The bot (and anything else that must work when the AI is unavailable) builds on these pure functions.

const ABBREVIATIONS: Record<string, string> = {
  vc: 'voce', vcs: 'voces', vce: 'voce', pq: 'porque', pra: 'para', pro: 'para o', q: 'que', tb: 'tambem', tbm: 'tambem', hj: 'hoje', amh: 'amanha', amnh: 'amanha',
  blz: 'beleza', obg: 'obrigado', obgd: 'obrigado', obgda: 'obrigada', brigado: 'obrigado', brigada: 'obrigada', vlw: 'valeu', pfv: 'por favor', pf: 'por favor', pfvr: 'por favor',
  msm: 'mesmo', qro: 'quero', qria: 'queria', qr: 'quer', ngm: 'ninguem', hrs: 'horas', hr: 'hora', cmg: 'comigo', pdc: 'pode', fds: 'fim de semana', dnv: 'de novo',
  promossao: 'promocao', promosao: 'promocao', cardapo: 'cardapio', cardapioo: 'cardapio', orario: 'horario', endereso: 'endereco', enderco: 'endereco',
};

// Words customers misspell most. A token close to one of them (never to a shorter word) is read as that word.
const VOCABULARY = [
  'cardapio', 'reservar', 'reserva', 'atendente', 'horario', 'endereco', 'promocao', 'promocoes', 'entrega', 'entregam', 'pagamento', 'funcionamento', 'obrigado', 'obrigada', 'desconto',
  'cancelar', 'confirmar', 'continuar', 'retomar', 'localizacao', 'estacionamento', 'amanha', 'sabado', 'domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'gerente', 'reclamacao',
  'dinheiro', 'cartao', 'credito', 'debito', 'retirada', 'encomendar', 'delivery', 'aberto', 'pedido', 'status', 'horarios',
];
const KNOWN = new Set(VOCABULARY);

// Optimal string alignment distance: insertions, deletions, substitutions and swapped neighbours ("cardapoi") each cost one.
function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[a.length][b.length];
}

function correct(token: string): string {
  if (token.length < 5 || !/^[a-z]+$/.test(token) || KNOWN.has(token)) return token;
  let best: { word: string; cost: number } | null = null;
  for (const word of VOCABULARY) {
    if (word[0] !== token[0] || Math.abs(word.length - token.length) > 2) continue;
    const cost = distance(token, word);
    if (cost <= (word.length >= 8 ? 2 : 1) && (!best || cost < best.cost)) best = { word, cost };
  }
  return best?.word ?? token;
}

// Lower case, no accents or stray symbols, abbreviations spelled out, stretched letters squeezed ("oiii", "simmm") and common typos fixed.
export function canonical(text: string): string {
  const base = normalizeText(text).replace(/([a-z])\1{2,}/g, '$1').replace(/[.,]+(?=\s|$)/g, '');
  return base.split(' ').filter(Boolean).map(token => correct(ABBREVIATIONS[token] ?? token)).join(' ');
}

export type Topic = 'handoff' | 'thanks' | 'order_status' | 'reservation_status' | 'cancel_existing' | 'reserve' | 'order' | 'address' | 'hours' | 'delivery' | 'payment' | 'promo' | 'menu';
export type Detected = { topic: Topic; at: number; match: string };

// Each pattern works on the canonical text. Subjects are not exclusive: "qual o horário e vocês aceitam pix?" is two questions, answered in the order asked.
const PATTERNS: { topic: Topic; re: RegExp }[] = [
  { topic: 'handoff', re: /\b(atendente|atendimento humano|humano|gerente|gerencia|responsavel|dono|proprietario|ouvidoria|reclamacao|reclamar|falar com (alguem|uma pessoa|pessoa|pessoas|o dono|a gerencia))\b/ },
  { topic: 'thanks', re: /\b(obrigad[oa]|valeu|agradeco|gratidao)\b/ },
  { topic: 'order_status', re: /\b(status|acompanhar|andamento|cade (o )?meu|onde (esta|ta) (o )?meu|ja saiu|saiu para (a )?entrega|quando chega|meu pedido|p-[a-z0-9]{4,}|pedido\s*#?\d+|chegou|atrasou|atrasado)\b|(?:^|\s)#\d+\b/ },
  { topic: 'reservation_status', re: /\b(minha reserva|sobre (a|minha) reserva|reserva (foi )?(confirmada|confirmou|aprovada)|confirmaram (a )?(minha )?reserva|(status|andamento) (da|de) (minha )?reserva|como esta (a|minha) reserva|cade (a )?(minha )?reserva)\b/ },
  { topic: 'cancel_existing', re: /\bcancel\w*\b.*\b(pedido|reserva)\b|\b(pedido|reserva)\b.*\bcancel\w*\b/ },
  { topic: 'reserve', re: /\b(reserva|reservas|reservar|reservei|agendar mesa|marcar mesa|quero uma mesa|uma mesa para|mesa para \w+|mesa de \w+)\b/ },
  { topic: 'order', re: /\b(fazer (um )?pedido|quero (pedir|comprar|fazer pedido)|pedir|pedido online|link|site|loja virtual|cardapio digital|encomendar|encomenda)\b/ },
  { topic: 'address', re: /\b(endereco|onde fica|onde (voces )?ficam|fica onde|ficam onde|localizacao|como chegar|mapa|onde (e|esta|fica) o restaurante|ponto de referencia)\b/ },
  { topic: 'hours', re: /\b(horario|horarios|abre|abrem|fecha|fecham|funcionamento|funciona|funcionam|aberto|aberta|abertos|abertas|ate que horas|que horas (abre|abrem|fecha|fecham)|ta aberto|ta aberta)\b/ },
  { topic: 'delivery', re: /\b(entrega|entregas|entregam|entregar|entregador|delivery|taxa|taxas|frete|retirada|retirar|retiro|buscar|motoboy|pedido minimo|tempo de entrega)\b/ },
  { topic: 'payment', re: /\b(pagamento|pagamentos|pagar|pix|cartao|cartoes|dinheiro|credito|debito|vale (refeicao|alimentacao)|ticket|troco|parcelar|parcela|maquininha|forma de pagamento|formas de pagamento)\b/ },
  { topic: 'promo', re: /\b(promocao|promocoes|promo|promos|desconto|descontos|oferta|ofertas|combo|combos|cupom|cupons|brinde)\b/ },
  { topic: 'menu', re: /\b(cardapio|cardapios|o que (voces )?(tem|servem|vendem)|que tem de|opcoes de comida|pratos|lanches|categorias|carta|ver (o )?menu|menu completo)\b/ },
];
// "aceitam?" alone is ambiguous (aceitam reserva? aceitam cartão?): it only means payment when nothing else was asked.
const WEAK_PAYMENT = /\b(aceita|aceitam)\b/;

export function detectTopics(c: string): Detected[] {
  const found: Detected[] = [];
  for (const { topic, re } of PATTERNS) {
    const hit = c.match(re);
    if (hit) found.push({ topic, at: hit.index ?? 0, match: hit[0].trim() });
  }
  // "demora" is about a placed order only when the customer talks about it ("meu pedido demora?"); otherwise it is the delivery time.
  if (/\bdemora\w*\b/.test(c) && /\b(pedido|meu)\b/.test(c) && !found.some(item => item.topic === 'order_status')) found.push({ topic: 'order_status', at: c.search(/\bdemora/), match: 'demora' });
  if (!found.some(item => item.topic === 'payment' || item.topic === 'reserve') && WEAK_PAYMENT.test(c)) found.push({ topic: 'payment', at: c.search(WEAK_PAYMENT), match: 'aceitam' });
  // A message that asks for the whole menu does not also need the "category" and "promotion" answers; a placed-order question is not a new order.
  let topics = found;
  if (topics.some(item => item.topic === 'order_status')) topics = topics.filter(item => item.topic !== 'order');
  if (topics.some(item => item.topic === 'reservation_status')) topics = topics.filter(item => item.topic !== 'reserve');
  if (topics.some(item => item.topic === 'cancel_existing')) topics = topics.filter(item => item.topic !== 'order_status' && item.topic !== 'reservation_status' && item.topic !== 'reserve' && item.topic !== 'order');
  if (topics.some(item => item.topic === 'handoff')) topics = topics.filter(item => item.topic === 'handoff');
  return topics.sort((a, b) => a.at - b.at);
}

export const WEEKDAY_WORDS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
export const weekdaysIn = (c: string): number[] => WEEKDAY_WORDS.flatMap((word, index) => (new RegExp(`\\b${word}`).test(c) ? [index] : []));

const GREETING_TOKENS = new Set(['oi', 'oii', 'ola', 'oie', 'oiee', 'eae', 'eai', 'e', 'hey', 'hi', 'hello', 'opa', 'salve', 'fala', 'alo', 'bom', 'boa', 'dia', 'tarde', 'noite', 'tudo', 'bem', 'td', 'beleza', 'menu', 'inicio', 'opcoes', 'ajuda', 'ai', 'ae', 'galera', 'pessoal', 'gente']);
const tokens = (c: string) => c.replace(/[#:/.,-]/g, ' ').split(' ').filter(Boolean);
// A greeting counts as "just a greeting" only when nothing else is asked, so "oi, qual o cardápio?" is answered as a question.
export const isGreetingOnly = (c: string) => { const list = tokens(c); return list.length > 0 && list.every(word => GREETING_TOKENS.has(word)); };
export const startsWithGreeting = (c: string) => /^(oi+|ola|oie+|eae|eai|opa|salve|fala|alo|hey|hello|bom dia|boa tarde|boa noite)\b/.test(c);

// Replies to a yes/no question. "sim, pode confirmar" is yes; "não, pra 6 pessoas" is a correction, which the caller tells apart by also looking for data.
const YES = /^(s|sim|ss|claro|certo|isso|ok|okay|pode|podemos|confirmo|confirmado|confirma|confirmar|fechado|combinado|beleza|perfeito|positivo|exato|aham|uhum|bora|com certeza|pode ser|pode sim|isso mesmo|tudo certo|esta certo|esta correto)\b/;
const YES_ANYWHERE = /\b(pode confirmar|pode reservar|pode marcar|confirmo|isso mesmo|fechou)\b/;
const NO = /^(n|nao|nn|nop|nope|negativo|nada|melhor nao|agora nao|depois|cancela|cancelar|cancelei|desisto|desistir|deixa (pra|para) la|deixa quieto|deixa isso|esquece|nao quero|nao precisa|nao obrigado)\b/;
export const isYes = (c: string) => YES.test(c) || YES_ANYWHERE.test(c);
export const isNo = (c: string) => NO.test(c) && !/^nao (sei|entendi|tenho|consigo|me lembro)\b/.test(c);
// "cancelar" also stops a booking in progress; "deixa pra lá", "esquece isso", "desisti" and "não quero mais" mean the same.
export const wantsToStop = (c: string) => /\b(cancela|cancelar|cancelei|desisto|desisti|desistir|deixa (pra|para) la|deixa quieto|deixa isso|esquece( isso)?|nao quero mais|melhor nao|para com isso)\b/.test(c);
export const wantsToResume = (c: string) => /\b(continuar|continuo|continua|retomar|retomo|prosseguir|seguir|voltar|voltando)\b/.test(c);

const NUMBER_WORDS: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20 };
const NUMBER = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;
const toNumber = (value: string) => (/^\d+$/.test(value) ? Number(value) : NUMBER_WORDS[value]);
// "4 pessoas", "somos 4", "mesa para quatro", "para 4", "grupo de 8", "eu e mais 3", "casal". With `bare`, a lone "4" or "quatro" is the answer to "para quantas pessoas?".
export function parsePeople(c: string, bare = false): number | null {
  const counted = c.match(new RegExp(`\\b${NUMBER}\\s+(?:pessoas?|pax|lugares?|cadeiras?|adultos?|convidados?|amigos?|criancas?)\\b`));
  if (counted) return toNumber(counted[1]) ?? null;
  const stated = c.match(new RegExp(`\\b(?:somos|seremos|eramos|serao|vamos ser|vai ser|vamos em|sou|mesa (?:de|para)|para|grupo de|com)(?:\\s+em)?\\s+${NUMBER}\\b(?!\\s*(?:h\\b|hs\\b|hrs?\\b|horas?\\b|:|/|\\d))`));
  if (stated) return toNumber(stated[1]) ?? null;
  const plusMe = c.match(new RegExp(`\\beu e mais\\s+${NUMBER}\\b`));
  if (plusMe) return (toNumber(plusMe[1]) ?? 0) + 1;
  if (/\beu e (minha|meu) (esposa|marido|namorada|namorado|mae|pai|filho|filha|amigo|amiga|irma|irmao)\b|\bcasal\b/.test(c)) return 2;
  if (/\b(sozinho|sozinha|so eu)\b/.test(c)) return 1;
  if (bare) { const lone = c.match(new RegExp(`^(?:somos |seremos )?${NUMBER}$`)); if (lone) return toNumber(lone[1]) ?? null; }
  return null;
}

// "1" to "8" answer the numbered options the bot shows.
export const MENU_CHOICES = ['menu', 'order', 'order_status', 'hours', 'delivery', 'payment', 'reserve', 'handoff'] as const;
export const menuChoice = (c: string): (typeof MENU_CHOICES)[number] | null => (/^[1-8]$/.test(c) ? MENU_CHOICES[Number(c) - 1] : null);
