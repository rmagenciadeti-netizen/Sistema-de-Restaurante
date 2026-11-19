'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { buttonClass, Field, Notice, panelClass, secondaryButtonClass } from './app-shell';
import { Toggle } from './ui';

type Config = { enabled: boolean; rules: Record<string, boolean>; emailTo: string[]; summaryHour: number };
type Rule = { key: string; label: string; financial: boolean };

// Central de automações: which situations generate notifications (bell in the top bar) and optional e-mail copies.
export function AutomationsPanel() {
  const [config, setConfig] = useState<Config | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [emails, setEmails] = useState('');
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  useEffect(() => {
    Promise.all([api<{ settings: { automations: Config } }>('/settings'), api<{ items: Rule[] }>('/notifications/rules')])
      .then(([settings, list]) => { setConfig(settings.settings.automations); setEmails(settings.settings.automations.emailTo.join(', ')); setRules(list.items); })
      .catch(cause => setNotice({ text: errorMessage(cause, 'Falha ao carregar as automações'), kind: 'error' }));
  }, []);
  if (!config) return notice ? <Notice message={notice.text} /> : null;

  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!config) return;
    try {
      const body = { ...config, emailTo: emails.split(/[,;\s]+/).filter(Boolean) };
      await api('/settings/automations', { method: 'PUT', body: JSON.stringify(body) });
      setNotice({ text: 'Automações salvas.', kind: 'success' });
    } catch (cause) { setNotice({ text: errorMessage(cause, 'Falha ao salvar as automações'), kind: 'error' }); }
  }
  async function runNow() {
    try { const result = await api<{ created: number }>('/notifications/run', { method: 'POST', body: JSON.stringify({}) }); setNotice({ text: result.created ? `${result.created} nova(s) notificação(ões) criada(s).` : 'Nenhuma situação nova para notificar.', kind: 'success' }); } catch (cause) { setNotice({ text: errorMessage(cause, 'Falha ao executar as automações'), kind: 'error' }); }
  }

  return <form onSubmit={save} className={`${panelClass} mt-6 space-y-3`}>
    <h2 className="text-base font-bold">🔔 Central de automações e notificações</h2>
    <p className="text-xs text-slate-500">Cada situação gera no máximo uma notificação por dia (resumos e metas, uma por período), evitando excesso de avisos. Os alertas valem para o que estiver ativo nas preferências acima. O envio por e-mail depende de o servidor ter SMTP configurado.</p>
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <Toggle label="Automações ativas" checked={config.enabled} onChange={value => setConfig({ ...config, enabled: value })} />
    <div className="grid gap-2 sm:grid-cols-2">{rules.map(rule => <Toggle key={rule.key} label={rule.label} hint={rule.financial ? 'Visível apenas para perfis com acesso ao Financeiro' : undefined} checked={config.rules[rule.key] ?? false} disabled={!config.enabled} onChange={value => setConfig({ ...config, rules: { ...config.rules, [rule.key]: value } })} />)}</div>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Hora do resumo diário/semanal (0-23)" type="number" min={0} max={23} value={config.summaryHour} onChange={event => setConfig({ ...config, summaryHour: Number(event.target.value) })} />
      <Field label="Enviar cópia por e-mail para (até 5, separados por vírgula)" value={emails} onChange={event => setEmails(event.target.value)} />
    </div>
    <div className="flex flex-wrap gap-2"><button className={buttonClass}>Salvar automações</button><button type="button" className={secondaryButtonClass} onClick={() => void runNow()}>Verificar agora</button></div>
  </form>;
}
