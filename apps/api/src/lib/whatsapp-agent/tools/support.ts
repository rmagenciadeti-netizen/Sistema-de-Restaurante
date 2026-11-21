import { z } from 'zod';
import { normalizeText } from '../../whatsapp-text';
import { addAddress, rememberFact, touch } from '../memory';
import { defineTool, type ToolDef } from '../types';
import { ok } from './common';

export const requestHumanHandoff = defineTool({
  name: 'request_human_handoff', kind: 'WRITE',
  schema: z.object({ reason: z.string().trim().min(3).max(200).describe('por que a pessoa precisa assumir'), summary: z.string().trim().min(3).max(700).describe('resumo do que o cliente quer e do que já foi feito/dito, para o atendente continuar sem perguntar tudo de novo') }),
  description: 'Chama um atendente humano. Use quando o cliente pedir, quando houver reclamação séria, problema que você não consegue resolver, regra do sistema que exige pessoa (ex.: pedido acima do limite, pedido já em preparo) ou informação que não existe. Depois de chamar, avise o cliente que uma pessoa vai continuar.',
  async run(ctx, args) {
    ctx.memory.support.handoff = { reason: args.reason, summary: args.summary, at: touch(ctx.now) };
    if (!ctx.dryRun) {
      // Staff sees it in the notification bell; the same reason is shown on the conversation. Failing to notify never blocks the handoff itself.
      const label = (ctx.customer.name ?? ctx.customer.phone ?? 'Cliente').slice(0, 60);
      await ctx.db.notification.create({ data: { tenantId: ctx.tenantId, ruleKey: 'whatsappHandoff', dedupeKey: `handoff:${ctx.conversationId}:${ctx.messageId}`, severity: 'WARNING', title: `${label} pediu atendimento humano no WhatsApp`, body: `${args.reason}. ${args.summary}`.slice(0, 900), href: '/whatsapp?tab=conversations' } }).catch(() => undefined);
    }
    return ok({ handedOff: true, until: `${ctx.env.settings.whatsapp.handoffMinutes} minutos ou até a equipe devolver a conversa ao robô` }, 'Atendente humano acionado', { handoff: { reason: args.reason, summary: args.summary } });
  },
});

export const setMessagePreferences = defineTool({
  name: 'set_message_preferences', kind: 'WRITE',
  schema: z.object({ stopAutomaticMessages: z.boolean().describe('true = o cliente não quer mais receber avisos automáticos; false = quer voltar a receber') }),
  description: 'Registra a preferência do cliente sobre mensagens automáticas (avisos de pedido e reserva). Use quando ele pedir para parar de receber mensagens ou para voltar a receber.',
  async run(ctx, args) {
    return ok({ stopAutomaticMessages: args.stopAutomaticMessages }, args.stopAutomaticMessages ? 'Cliente não receberá mais avisos automáticos' : 'Cliente voltará a receber avisos automáticos', { optOut: args.stopAutomaticMessages });
  },
});

export const updateMemory = defineTool({
  name: 'update_memory', kind: 'MEMORY',
  schema: z.object({
    customerName: z.string().trim().max(60).optional().describe('nome como o cliente pediu para ser chamado'),
    address: z.string().trim().max(300).optional().describe('endereço que o cliente informou e quer reutilizar'),
    contactPhone: z.string().trim().max(20).optional().describe('telefone de contato informado pelo cliente (só quando o WhatsApp não revela o número)'),
    remember: z.array(z.string().trim().min(3).max(200)).max(5).optional().describe('fatos úteis para o futuro (preferências, restrições alimentares, aniversário...)'),
    forget: z.array(z.string().trim().min(3).max(200)).max(5).optional().describe('fatos que deixaram de valer'),
  }),
  description: 'Guarda na memória desta conversa informações que o cliente deu e que valem para depois (nome preferido, endereço, restrições, preferências). Não guarde dados sensíveis (saúde, religião, política) nem senhas, documentos ou dados de cartão.',
  async run(ctx, args) {
    if (args.customerName) ctx.memory.profile.name = args.customerName;
    if (args.address) addAddress(ctx.memory, args.address);
    if (args.contactPhone && args.contactPhone.replace(/\D/g, '').length >= 8) ctx.memory.profile.phone = args.contactPhone.replace(/\D/g, '').slice(0, 15);
    for (const fact of args.remember ?? []) rememberFact(ctx.memory, fact);
    for (const fact of args.forget ?? []) ctx.memory.facts = ctx.memory.facts.filter(item => normalizeText(item) !== normalizeText(fact));
    return ok({ saved: true, facts: ctx.memory.facts.length }, 'Memória atualizada');
  },
});

export const reportUnanswered = defineTool({
  name: 'report_unanswered', kind: 'WRITE',
  schema: z.object({ question: z.string().trim().min(3).max(200).describe('a pergunta do cliente, resumida, que você não conseguiu responder com os dados do restaurante') }),
  description: 'Registra uma pergunta que não pôde ser respondida com os dados reais do restaurante, para a equipe ensinar o robô depois. Use junto com a explicação honesta de que você não tem essa informação.',
  async run(ctx, args) {
    const key = normalizeText(args.question).slice(0, 200);
    if (!ctx.dryRun && key.length >= 3) await ctx.db.whatsappUnanswered.upsert({ where: { tenantId_text: { tenantId: ctx.tenantId, text: key } }, create: { tenantId: ctx.tenantId, text: key, lastAskedAt: ctx.now }, update: { count: { increment: 1 }, lastAskedAt: ctx.now } });
    return ok({ registered: true }, 'Pergunta registrada para a equipe');
  },
});

export const supportTools: ToolDef[] = [requestHumanHandoff, setMessagePreferences, updateMemory, reportUnanswered];
