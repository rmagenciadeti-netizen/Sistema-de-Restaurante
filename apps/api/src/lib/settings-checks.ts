import type { SettingsSectionName } from './settings';

type Slot = { start: string; end: string };
const badSlot = (slots: Slot[]) => slots.some(slot => slot.start >= slot.end);

// Cross-field rules that the per-field zod schemas cannot express. Returns human-readable messages (empty = valid).
export function settingsSectionIssues(section: SettingsSectionName, value: any): string[] {
  const issues: string[] = [];
  if (section === 'hours' && badSlot(value.weekly)) issues.push('hours.weekly: o início deve ser anterior ao fim');
  if (section === 'scheduling') {
    if (badSlot(value.slots)) issues.push('scheduling.slots: o início deve ser anterior ao fim');
    if ((value.blockedFrom === null) !== (value.blockedTo === null)) issues.push('scheduling: informe as duas datas do período de bloqueio');
    else if (value.blockedFrom && value.blockedTo && value.blockedFrom > value.blockedTo) issues.push('scheduling: blockedFrom deve ser anterior ou igual a blockedTo');
  }
  return issues;
}
