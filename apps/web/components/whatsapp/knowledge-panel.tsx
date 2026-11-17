'use client';

import { useRef, useState } from 'react';
import { api, formatDateTime, ListResponse } from '../../lib/api';
import type { KnowledgeEntry, KnowledgeInput, UnansweredQuestion } from '../../lib/types-whatsapp';
import { useAutoLoad } from '../../lib/use-auto-load';
import { Field, Notice, buttonClass, panelClass, secondaryButtonClass } from '../app-shell';
import { Badge, DataTable, EmptyState, Toggle, dangerButtonClass, textareaClass } from '../ui';
import { Flash, friendlyError } from './common';

type Draft = { title: string; keywords: string[]; answer: string; active: boolean };
const emptyDraft: Draft = { title: '', keywords: [], answer: '', active: true };
const stopWords = new Set(['para', 'com', 'que', 'uma', 'voces', 'vocês', 'tem', 'qual', 'quais', 'como', 'onde', 'quando', 'aqui', 'sobre', 'por', 'dos', 'das', 'nos', 'nas', 'meu', 'minha']);

function suggestKeywords(text: string): string[] {
  const words = text.toLowerCase().replace(/[^a-z0-9à-ÿ\s]/g, ' ').split(/\s+/).filter(word => word.length >= 4 && !stopWords.has(word));
  return Array.from(new Set(words)).slice(0, 5);
}

export function KnowledgePanel({ canEdit, onChanged }: { canEdit: boolean; onChanged: () => void }) {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [questions, setQuestions] = useState<UnansweredQuestion[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fromQuestion, setFromQuestion] = useState<string | null>(null);
  const [keywordInput, setKeywordInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);

  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [knowledge, unanswered] = await Promise.all([api<ListResponse<KnowledgeEntry>>('/whatsapp/knowledge'), api<ListResponse<UnansweredQuestion>>('/whatsapp/unanswered')]);
      setEntries(Array.isArray(knowledge?.items) ? knowledge.items : []);
      setQuestions(Array.isArray(unanswered?.items) ? unanswered.items : []);
    } catch (e) { setFlash({ text: friendlyError(e, 'Erro ao carregar a base de conhecimento'), kind: 'error' }); } finally { inFlight.current = false; setLoaded(true); }
  }
  useAutoLoad(load, 20000);

  function parseKeywords(raw: string): string[] {
    return raw.split(/[,;\n]/).map(word => word.trim()).filter(Boolean);
  }
  function addKeywords(raw: string, base = draft.keywords): string[] {
    const merged = [...base];
    for (const word of parseKeywords(raw)) if (!merged.some(existing => existing.toLowerCase() === word.toLowerCase())) merged.push(word);
    return merged;
  }
  function commitKeywords() {
    if (!keywordInput.trim()) return draft.keywords;
    const next = addKeywords(keywordInput);
    setDraft(current => ({ ...current, keywords: next })); setKeywordInput('');
    return next;
  }
  function focusForm() { setTimeout(() => { form.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); titleInput.current?.focus(); }, 0); }
  function resetForm() { setDraft(emptyDraft); setEditingId(null); setFromQuestion(null); setKeywordInput(''); setFormError(null); }

  function edit(entry: KnowledgeEntry) {
    setDraft({ title: entry.title, keywords: entry.keywords, answer: entry.answer, active: entry.active });
    setEditingId(entry.id); setFromQuestion(null); setKeywordInput(''); setFormError(null); focusForm();
  }
  function teach(question: UnansweredQuestion) {
    setDraft({ title: question.text.slice(0, 100), keywords: suggestKeywords(question.text), answer: '', active: true });
    setEditingId(null); setFromQuestion(question.id); setKeywordInput(''); setFormError(null); focusForm();
  }

  async function submit() {
    const keywords = commitKeywords();
    const payload: KnowledgeInput = { title: draft.title.trim(), keywords, answer: draft.answer.trim(), active: draft.active };
    if (payload.title.length < 2 || payload.title.length > 100) { setFormError('O título deve ter de 2 a 100 caracteres.'); return; }
    if (keywords.length < 1 || keywords.length > 20) { setFormError('Informe de 1 a 20 palavras-chave.'); return; }
    if (keywords.some(word => word.length > 40)) { setFormError('Cada palavra-chave pode ter no máximo 40 caracteres.'); return; }
    if (payload.answer.length < 1 || payload.answer.length > 1500) { setFormError('A resposta deve ter de 1 a 1500 caracteres.'); return; }
    setFormError(null); setBusy(true); setFlash(null);
    try {
      if (editingId) await api(`/whatsapp/knowledge/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else await api('/whatsapp/knowledge', { method: 'POST', body: JSON.stringify(payload) });
      let note = editingId ? 'Resposta atualizada.' : 'Resposta cadastrada na base de conhecimento.';
      if (fromQuestion) {
        try { await api(`/whatsapp/unanswered/${fromQuestion}`, { method: 'DELETE' }); } catch { note += ' Não foi possível remover a pergunta da lista; descarte-a manualmente.'; }
      }
      resetForm(); setFlash({ text: note, kind: 'success' }); onChanged(); await load();
    } catch (e) { setFormError(friendlyError(e, 'Erro ao salvar a resposta')); } finally { setBusy(false); }
  }

  async function toggleActive(entry: KnowledgeEntry) {
    setFlash(null);
    try { await api(`/whatsapp/knowledge/${entry.id}`, { method: 'PATCH', body: JSON.stringify({ active: !entry.active }) }); await load(); } catch (e) { setFlash({ text: friendlyError(e, 'Erro ao atualizar a resposta'), kind: 'error' }); }
  }
  async function remove(entry: KnowledgeEntry) {
    if (!window.confirm(`Excluir a resposta “${entry.title}”?`)) return;
    setFlash(null);
    try { await api(`/whatsapp/knowledge/${entry.id}`, { method: 'DELETE' }); if (editingId === entry.id) resetForm(); await load(); } catch (e) { setFlash({ text: friendlyError(e, 'Erro ao excluir a resposta'), kind: 'error' }); }
  }
  async function discard(question: UnansweredQuestion) {
    setFlash(null);
    try { await api(`/whatsapp/unanswered/${question.id}`, { method: 'DELETE' }); if (fromQuestion === question.id) setFromQuestion(null); onChanged(); await load(); } catch (e) { setFlash({ text: friendlyError(e, 'Erro ao descartar a pergunta'), kind: 'error' }); }
  }

  return <div className="grid gap-4">
    {flash && <Notice message={flash.text} kind={flash.kind} />}

    <section className={panelClass}>
      <h2 className="text-lg font-semibold text-slate-900">Perguntas que o robô não soube responder{questions.length > 0 ? ` (${questions.length})` : ''}</h2>
      <p className="mt-1 text-sm text-slate-600">Ensine uma resposta para que o robô acerte da próxima vez, ou descarte perguntas irrelevantes.</p>
      <ul className="mt-3 grid gap-2">
        {questions.map(question => <li key={question.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3">
          <div className="min-w-0"><p className="break-words font-medium text-slate-900">{question.text}</p><p className="text-xs text-slate-500">{question.count}× · última vez em {formatDateTime(question.lastAskedAt)}</p></div>
          {canEdit && <div className="flex gap-2"><button type="button" className={`${buttonClass} min-h-10`} onClick={() => teach(question)}>Ensinar resposta</button><button type="button" className={`${secondaryButtonClass} min-h-10`} onClick={() => void discard(question)}>Descartar</button></div>}
        </li>)}
      </ul>
      {loaded && questions.length === 0 && <p className="mt-3 text-sm text-slate-500">Nenhuma pergunta pendente. 🎉</p>}
    </section>

    <section className={panelClass}>
      <h2 className="text-lg font-semibold text-slate-900">Base de conhecimento</h2>
      <p className="mt-1 text-sm text-slate-600">Respostas prontas do restaurante. Quando a mensagem do cliente contém alguma das palavras-chave, o robô envia a resposta.</p>
      <div className="mt-3">
        <DataTable columns={[{ label: 'Pergunta / título' }, { label: 'Palavras-chave' }, { label: 'Usos', className: 'text-right' }, { label: 'Ativa' }, { label: 'Ações', className: 'text-right' }]}>
          {entries.map(entry => <tr key={entry.id}>
            <td className="font-medium text-slate-900">{entry.title}<p className="mt-0.5 line-clamp-2 text-xs font-normal text-slate-500">{entry.answer}</p></td>
            <td><div className="flex flex-wrap gap-1">{entry.keywords.map(word => <Badge key={word} tone="gold">{word}</Badge>)}</div></td>
            <td className="text-right tabular-nums">{entry.hits}</td>
            <td><button type="button" role="switch" aria-checked={entry.active} disabled={!canEdit} onClick={() => void toggleActive(entry)} className="outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60" aria-label={`${entry.active ? 'Desativar' : 'Ativar'} “${entry.title}”`}><Badge tone={entry.active ? 'green' : 'neutral'}>{entry.active ? 'Ativa' : 'Inativa'}</Badge></button></td>
            <td className="text-right">{canEdit && <div className="flex justify-end gap-2"><button type="button" className={`${secondaryButtonClass} min-h-9`} onClick={() => edit(entry)}>Editar</button><button type="button" className={`${dangerButtonClass} min-h-9`} onClick={() => void remove(entry)}>Excluir</button></div>}</td>
          </tr>)}
        </DataTable>
        {loaded && entries.length === 0 && <div className="mt-3"><EmptyState icon="📚" title="Nenhuma resposta cadastrada" hint="Cadastre respostas para perguntas frequentes, como estacionamento, wi-fi, aniversários ou opções sem glúten." /></div>}
      </div>
    </section>

    {canEdit && <section className={panelClass}>
      <h2 className="text-lg font-semibold text-slate-900">{editingId ? 'Editar resposta' : fromQuestion ? 'Ensinar resposta' : 'Nova resposta'}</h2>
      <form ref={form} className="mt-3 grid gap-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label className="block text-sm font-medium text-slate-700">Título (a pergunta)
          <input ref={titleInput} maxLength={100} value={draft.title} placeholder="Ex.: Vocês têm estacionamento?" className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15" onChange={event => setDraft({ ...draft, title: event.target.value })} />
        </label>
        <div>
          <Field label="Palavras-chave (Enter ou vírgula para adicionar)" value={keywordInput} maxLength={40} placeholder="estacionamento, vaga, manobrista" onChange={event => { const value = event.target.value; if (/[,;]/.test(value)) { setDraft(current => ({ ...current, keywords: addKeywords(value, current.keywords) })); setKeywordInput(''); } else setKeywordInput(value); }} onBlur={commitKeywords} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitKeywords(); } }} />
          <div className="mt-2 flex flex-wrap gap-1.5">{draft.keywords.map(word => <span key={word} className="inline-flex items-center gap-1 rounded-full bg-brand-100 py-0.5 pl-3 pr-1 text-xs font-semibold text-brand-700">{word}<button type="button" aria-label={`Remover palavra-chave ${word}`} className="grid h-5 w-5 place-items-center rounded-full outline-none hover:bg-brand-200 focus-visible:ring-2 focus-visible:ring-brand-500" onClick={() => setDraft({ ...draft, keywords: draft.keywords.filter(item => item !== word) })}>×</button></span>)}</div>
        </div>
        <label className="block text-sm font-medium text-slate-700">Resposta do robô
          <textarea rows={4} maxLength={1500} value={draft.answer} className={textareaClass} placeholder="Texto que o cliente receberá" onChange={event => setDraft({ ...draft, answer: event.target.value })} />
        </label>
        <p className="-mt-2 text-right text-xs text-slate-400">{draft.answer.length}/1500</p>
        <Toggle label="Resposta ativa" checked={draft.active} onChange={active => setDraft({ ...draft, active })} />
        {formError && <p role="alert" className="text-sm text-red-700">{formError}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy} className={`${buttonClass} min-h-11`}>{editingId ? 'Salvar alterações' : 'Cadastrar resposta'}</button>
          {(editingId || fromQuestion || draft.title || draft.answer || draft.keywords.length > 0) && <button type="button" className={`${secondaryButtonClass} min-h-11`} onClick={resetForm}>Cancelar</button>}
        </div>
      </form>
    </section>}
  </div>;
}
