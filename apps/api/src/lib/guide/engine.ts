import { UserRole } from '@prisma/client';
import { ALL_TENANT_ROLES, CASH_ROLES, DELIVERY_ROLES, FINANCE_ROLES, MANAGEMENT_ROLES, PRODUCTION_ROLES, SALES_ROLES } from '../permissions';
import screensIndex from './screens.generated.json';
import { PROCEDURES } from './procedures';
import { ROLE_LABELS, type Procedure, type RoleGroups, type RoleSet } from './types';

export type Screen = { href: string; menu: { label: string; group: string; href: string }[]; module: string | null; title: string | null; subtitle: string | null; tabs: string[]; fields: { label: string; hint?: string }[]; buttons: string[] };
export const SCREENS = screensIndex.screens as Screen[];
export const SCREEN_BY_HREF = new Map(SCREENS.map(screen => [screen.href, screen]));
export const ROLE_GROUPS: RoleGroups = { ALL: ALL_TENANT_ROLES, SALES: SALES_ROLES, CASH: CASH_ROLES, FINANCE: FINANCE_ROLES, MANAGEMENT: MANAGEMENT_ROLES, DELIVERY: DELIVERY_ROLES, PRODUCTION: PRODUCTION_ROLES, ADMIN: [UserRole.ADMIN] };

export const normalize = (text: string) => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['a', 'o', 'as', 'os', 'um', 'uma', 'de', 'do', 'da', 'dos', 'das', 'e', 'em', 'no', 'na', 'nos', 'nas', 'para', 'por', 'com', 'que', 'se', 'meu', 'minha', 'meus', 'minhas', 'eu', 'como', 'qual', 'quais', 'onde', 'faco', 'fazer', 'posso', 'preciso', 'quero', 'ao', 'sistema', 'rm', 'restaurant']);
// Light stemming so "configuro"/"configurar" and "produto"/"produtos" meet.
const stem = (word: string) => (word.length >= 6 ? word.slice(0, 5) : word.length === 5 && word.endsWith('s') ? word.slice(0, -1) : word);
const tokens = (text: string) => normalize(text).split(' ').filter(word => word.length > 1 && !STOP.has(word)).map(stem);

// Action verbs that make "como …" a how-to question about the system (and not a question about the business numbers).
const HOW_TO = /\b(como|onde|qual (o )?(menu|tela|caminho)|passo a passo|ensin\w*|me (explica|ajuda)|ajuda)\b.*\b(cadastr\w*|configur\w*|emit\w*|abr\w*|fech\w*|faz\w*|cri\w*|liber\w*|lanc\w*|registr\w*|us\w*|acess\w*|encontr\w*|imprim\w*|ativ\w*|vincul\w*|adicion\w*|alter\w*|edit\w*|exclu\w*|cancel\w*|import\w*|export\w*|consult\w*|conect\w*|receb\w*|pag\w*|baix\w*|conferir|conferencia|incluir|ajust\w*|montar|operar|funciona\w*|form\w*|calcul\w*|atend\w*|reserv\w*|particip\w*|control\w*)\b|\b(passo a passo|ensin\w*)\b/;
const FIELD_QUESTION = /\b(o que (e|significa|quer dizer)|para que serve|qual a diferenca|o que preencho|o que coloco|como preencho)\b/;
const SCREEN_QUESTION = /\b(expli[cq]\w* (esta|essa|a) tela|o que (e|faz) (esta|essa) tela|para que serve (esta|essa) tela|ajuda (desta|dessa) tela|como (usar|uso|funciona) (esta|essa) tela|onde estou)\b/;

export type GuideAccess = { viewRoles: string[]; editRoles: string[]; canView: boolean; canEdit: boolean; module: string | null; moduleAvailable: boolean | null };
export type GuideResponse = {
  matched: boolean; kind: 'procedure' | 'screen' | 'field' | 'fallback' | 'none'; confidence: 'high' | 'medium' | 'low';
  answer: string;
  topic?: { id: string; title: string; href: string; menuPath: string; tab: string | null };
  summary?: string; steps?: string[]; fields?: { label: string; help: string }[]; buttons?: string[]; verify?: string[]; mistakes?: string[];
  access?: GuideAccess; related: { id: string; title: string }[];
  notice: string;
};
const NOTICE = 'Este guia só ensina: ele não altera cadastros, valores fiscais ou financeiros. Qualquer alteração é feita por você, na tela.';

export function menuPathOf(procedure: Pick<Procedure, 'menuHref' | 'href' | 'tab'>): string {
  const entry = SCREEN_BY_HREF.get(procedure.href)?.menu.find(item => item.href === procedure.menuHref);
  const base = entry ? (entry.group === 'Acesso rápido' ? `Barra superior › ${entry.label}` : `Menu lateral › ${entry.group} › ${entry.label}`) : procedure.menuHref;
  return procedure.tab ? `${base} › aba "${procedure.tab}"` : base;
}
const roleNames = (roles: UserRole[]) => roles.map(role => ROLE_LABELS[role] ?? role);

function accessOf(procedure: Procedure, role: UserRole | null, enabledModules: string[] | null | undefined): GuideAccess {
  const view = ROLE_GROUPS[procedure.view]; const edit = ROLE_GROUPS[procedure.edit];
  return {
    viewRoles: roleNames(view), editRoles: roleNames(edit), canView: role ? view.includes(role) : true, canEdit: role ? edit.includes(role) : true,
    module: procedure.module ?? null, moduleAvailable: procedure.module ? (enabledModules == null ? true : enabledModules.includes(procedure.module)) : null,
  };
}

function renderProcedure(procedure: Procedure, access: GuideAccess): string {
  const lines = [`${procedure.title}`, procedure.summary, '', `Onde: ${menuPathOf(procedure)}`];
  if (access.module && access.moduleAvailable === false) lines.push('⚠️ Esta área não está habilitada no plano da sua empresa. Fale com o suporte para contratar.');
  if (!access.canView) lines.push(`⚠️ Seu perfil não acessa esta tela. Quem acessa: ${access.viewRoles.join(', ')}.`);
  else if (!access.canEdit) lines.push(`⚠️ Seu perfil só consulta esta tela. Quem altera: ${access.editRoles.join(', ')}.`);
  lines.push('', 'Passo a passo:', ...procedure.steps.map((step, index) => `${index + 1}. ${step}`));
  if (procedure.fields.length) lines.push('', 'Campos:', ...procedure.fields.map(field => `• ${field.label}: ${field.help}`));
  if (procedure.verify.length) lines.push('', 'Como conferir:', ...procedure.verify.map(item => `✔ ${item}`));
  if (procedure.mistakes.length) lines.push('', 'Erros comuns:', ...procedure.mistakes.map(item => `⚠ ${item}`));
  return lines.join('\n');
}

const toResponse = (procedure: Procedure, access: GuideAccess, confidence: GuideResponse['confidence'], kind: GuideResponse['kind'] = 'procedure', answerOverride?: string): GuideResponse => ({
  matched: true, kind, confidence, answer: answerOverride ?? renderProcedure(procedure, access),
  topic: { id: procedure.id, title: procedure.title, href: procedure.menuHref, menuPath: menuPathOf(procedure), tab: procedure.tab ?? null },
  summary: procedure.summary, steps: procedure.steps, fields: procedure.fields.map(({ label, help }) => ({ label, help })), buttons: procedure.buttons, verify: procedure.verify, mistakes: procedure.mistakes, access,
  related: (procedure.related ?? []).flatMap(id => PROCEDURES.find(item => item.id === id) ?? []).map(item => ({ id: item.id, title: item.title })), notice: NOTICE,
});

// ---- scoring ----
const searchable = PROCEDURES.map(procedure => ({
  procedure,
  aliases: procedure.aliases.map(alias => normalize(alias)),
  titleTokens: new Set(tokens(procedure.title)),
  aliasTokens: new Set(procedure.aliases.flatMap(alias => tokens(alias))),
  labelTokens: new Set([...procedure.fields.map(field => field.label), ...(SCREEN_BY_HREF.get(procedure.href)?.tabs ?? []), ...(procedure.buttons ?? [])].flatMap(label => tokens(label))),
}));

const VOCABULARY = new Set(PROCEDURES.flatMap(procedure => [procedure.title, procedure.summary, ...procedure.aliases, ...procedure.steps, ...procedure.fields.map(field => `${field.label} ${field.help}`), ...procedure.verify, ...procedure.mistakes]).flatMap(text => tokens(text)));
for (const screen of SCREEN_BY_HREF.values()) for (const text of [screen.title ?? '', ...screen.tabs, ...screen.fields.map(field => field.label), ...screen.buttons]) for (const word of tokens(text)) VOCABULARY.add(word);
const unknownWords = (question: string) => tokens(question).filter(word => !VOCABULARY.has(word) && !/^\d+$/.test(word));

export function scoreProcedures(question: string, page?: string) {
  const normalized = ` ${normalize(question)} `; const words = new Set(tokens(question));
  return searchable.map(item => {
    let score = 0; let direct = false;
    for (const alias of item.aliases) if (alias && normalized.includes(` ${alias} `)) { score += 10 + alias.split(' ').length; direct = true; }
    for (const word of words) { if (item.aliasTokens.has(word)) score += 3; if (item.titleTokens.has(word)) score += 2; if (item.labelTokens.has(word)) score += 1; }
    if (page && item.procedure.href === page.split('?')[0]) score += 1;
    return { procedure: item.procedure, score, direct };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
}

function fieldMatches(question: string) {
  // Drop the question phrase itself ("o que é", "para que serve"…) and look at what is being asked about.
  const asked = tokens(normalize(question).replace(/\b(o que (e|significa|quer dizer)|para que serve|qual a diferenca( entre)?|o que (preencho|coloco)( em| no| na)?|como preencho)\b/g, ' '));
  if (asked.length === 0) return [];
  const found: { procedure: Procedure; field: { label: string; help: string }; size: number; exact: boolean }[] = [];
  for (const procedure of PROCEDURES) for (const field of procedure.fields) {
    const coreTokens = tokens(field.label.replace(/\(.*?\)/g, ' '));
    if (coreTokens.length === 0) continue;
    const exact = coreTokens.length === asked.length && coreTokens.every(token => asked.includes(token));
    if (exact || (asked.every(token => coreTokens.includes(token)) && asked.some(token => token.length >= 3))) found.push({ procedure, field, size: coreTokens.length, exact });
  }
  return found.sort((a, b) => Number(b.exact) - Number(a.exact) || a.size - b.size);
}

export function explainScreen(page: string, role: UserRole | null, enabledModules: string[] | null | undefined): GuideResponse {
  const path = page.split('?')[0].replace(/\/+$/, '') || '/dashboard';
  const screen = SCREEN_BY_HREF.get(path);
  if (!screen) return { matched: true, kind: 'fallback', confidence: 'low', answer: 'Não tenho a descrição desta tela no guia. Pergunte como fazer uma tarefa específica (ex.: "Como cadastro um produto?") ou abra o menu lateral e procure pelo nome da área.', related: [], notice: NOTICE };
  const entry = screen.menu[0];
  const where = entry ? (entry.group === 'Acesso rápido' ? `Barra superior › ${entry.label}` : `Menu lateral › ${entry.group} › ${entry.label}`) : 'Aberta a partir de outra tela';
  const tasks = PROCEDURES.filter(procedure => procedure.href === path);
  const lines = [`Tela: ${screen.title ?? entry?.label ?? path}`, `Onde: ${where}`];
  if (screen.subtitle) lines.push(screen.subtitle);
  if (screen.module && enabledModules != null && !enabledModules.includes(screen.module)) lines.push('⚠️ Esta área não está habilitada no plano da sua empresa.');
  if (screen.tabs.length) lines.push('', `Abas/seções: ${screen.tabs.join(' · ')}`);
  if (screen.fields.length) lines.push('', 'Campos desta tela:', ...screen.fields.slice(0, 40).map(field => `• ${field.label}${field.hint ? ` — ${field.hint}` : ''}`), ...(screen.fields.length > 40 ? [`… e mais ${screen.fields.length - 40} campos.`] : []));
  if (screen.buttons.length) lines.push('', `Botões: ${screen.buttons.slice(0, 20).join(' · ')}`);
  if (tasks.length) lines.push('', 'Passo a passo disponível para esta tela:', ...tasks.map(task => `• ${task.title}`));
  lines.push('', 'Os campos acima são os que existem na tela; só explico em detalhe o que está no passo a passo. Para os demais, pergunte "o que é <campo>?" e eu digo se tenho a informação.');
  const first = tasks[0];
  return {
    matched: true, kind: 'screen', confidence: 'high', answer: lines.join('\n'),
    topic: { id: first?.id ?? `screen:${path}`, title: screen.title ?? path, href: entry?.href ?? path, menuPath: where, tab: null },
    fields: screen.fields.map(field => ({ label: field.label, help: field.hint ?? '' })), buttons: screen.buttons,
    access: first ? accessOf(first, role, enabledModules) : undefined, related: tasks.map(task => ({ id: task.id, title: task.title })), notice: NOTICE,
  };
}

export function topicById(id: string, role: UserRole | null, enabledModules: string[] | null | undefined): GuideResponse | null {
  const procedure = PROCEDURES.find(item => item.id === id);
  return procedure ? toResponse(procedure, accessOf(procedure, role, enabledModules), 'high') : null;
}

export function answerGuide(question: string, options: { page?: string; role: UserRole | null; enabledModules?: string[] | null }): GuideResponse {
  const { page, role, enabledModules } = options;
  const normalized = normalize(question);
  if (SCREEN_QUESTION.test(normalized) && page) return explainScreen(page, role, enabledModules);

  const ranked = scoreProcedures(question, page);
  const best = ranked[0];
  const howTo = HOW_TO.test(normalized);
  const fieldQuestion = FIELD_QUESTION.test(normalized);

  if (fieldQuestion) {
    const hits = fieldMatches(question);
    if (hits.length) {
      const first = hits[0]; const access = accessOf(first.procedure, role, enabledModules);
      // An exact label answers alone; a shared term (e.g. "CST") lists every field that carries it.
      const group = first.exact ? [first] : hits.filter((hit, index) => hits.findIndex(other => other.field.label === hit.field.label) === index).slice(0, 5);
      const lines = group.length === 1
        ? [group[0].field.label, group[0].field.help, '', `Onde: ${menuPathOf(group[0].procedure)}`]
        : [`Este termo aparece em ${group.length} campos:`, ...group.map(hit => `• ${hit.field.label}: ${hit.field.help} (${menuPathOf(hit.procedure)})`)];
      const answer = [...lines, '', `Quer o passo a passo completo? Pergunte: "${first.procedure.title}".`].join('\n');
      return { ...toResponse(first.procedure, access, 'high', 'field', answer), fields: group.map(hit => hit.field) };
    }
  }
  if (best && (best.direct || (howTo && best.score >= 5 && unknownWords(question).length === 0))) {
    return toResponse(best.procedure, accessOf(best.procedure, role, enabledModules), best.direct && best.score >= 12 ? 'high' : 'medium');
  }
  if (howTo || fieldQuestion) {
    const closest = ranked.slice(0, 3).map(item => item.procedure);
    const groups = (screensIndex.groups as { title: string }[]).map(group => group.title).join(', ');
    return {
      matched: true, kind: 'fallback', confidence: 'low', related: closest.map(item => ({ id: item.id, title: item.title })), notice: NOTICE,
      answer: ['Não tenho certeza de qual procedimento você procura e prefiro não ensinar algo incorreto.', ...(closest.length ? ['', 'Talvez seja um destes:', ...closest.map(item => `• ${item.title}`)] : []), '', `Você também pode procurar no menu lateral, que se organiza em: ${groups}.`, 'Tente reformular citando a tela ou a tarefa (ex.: "como cadastro um fornecedor?").'].join('\n'),
    };
  }
  return { matched: false, kind: 'none', confidence: 'low', answer: '', related: [], notice: NOTICE };
}

export function listTopics() {
  return PROCEDURES.map(procedure => ({ id: procedure.id, title: procedure.title, menuPath: menuPathOf(procedure), module: procedure.module ?? null }));
}
export type { RoleSet };
