import { z } from 'zod';

// Custom KDS stages: the restaurant names its own production flow, but every stage belongs to one of the four item phases
// (OrderItemStatus). Order rules, stock, printing and reports keep using the phase; the stage is only the label/step shown in the KDS.
export const KDS_PHASES = ['PENDING', 'PREPARING', 'READY', 'DELIVERED'] as const;
export type KdsPhase = typeof KDS_PHASES[number];
export type KdsStage = { key: string; label: string; phase: KdsPhase; color: string };

export const DEFAULT_KDS_STAGES: KdsStage[] = [
  { key: 'RECEIVED', label: 'Recebido', phase: 'PENDING', color: '#b45309' },
  { key: 'IN_PREPARATION', label: 'Em preparação', phase: 'PREPARING', color: '#0369a1' },
  { key: 'READY', label: 'Pronto', phase: 'READY', color: '#047857' },
  { key: 'DELIVERED', label: 'Entregue', phase: 'DELIVERED', color: '#475569' },
];

const stageSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]{1,29}$/, 'Use letras maiúsculas, números e _ (2 a 30)'),
  label: z.string().trim().min(1).max(40),
  phase: z.enum(KDS_PHASES),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#475569'),
});

export const kdsStagesSection = z.object({ stages: z.array(stageSchema).min(4).max(12).default(DEFAULT_KDS_STAGES) }).superRefine((value, ctx) => {
  const keys = new Set<string>();
  let last = -1;
  for (const [index, stage] of value.stages.entries()) {
    if (keys.has(stage.key)) ctx.addIssue({ code: 'custom', path: ['stages', index, 'key'], message: 'Chave de estado repetida' });
    keys.add(stage.key);
    const position = KDS_PHASES.indexOf(stage.phase);
    if (position < last) ctx.addIssue({ code: 'custom', path: ['stages', index, 'phase'], message: 'Os estados devem seguir a ordem do fluxo: pendente, preparo, pronto, entregue' });
    last = Math.max(last, position);
  }
  for (const phase of KDS_PHASES) if (!value.stages.some(stage => stage.phase === phase)) ctx.addIssue({ code: 'custom', path: ['stages'], message: `Falta ao menos um estado na fase ${phase}` });
});

export function firstStageOf(stages: KdsStage[], phase: KdsPhase): KdsStage {
  return stages.find(stage => stage.phase === phase) ?? DEFAULT_KDS_STAGES[KDS_PHASES.indexOf(phase)];
}

// The stage shown for an item: the stored one only while it still exists and still matches the item's real status; otherwise the first stage of that status.
export function stageOfItem(stages: KdsStage[], item: { status: string; kdsStage?: string | null }): KdsStage {
  const stored = item.kdsStage ? stages.find(stage => stage.key === item.kdsStage) : undefined;
  return stored && stored.phase === item.status ? stored : firstStageOf(stages, item.status as KdsPhase);
}
