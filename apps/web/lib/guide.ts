import { api } from './api';

// RM Assistente — teaching mode (API: /guide). Read-only: it explains screens and procedures and never changes anything.
export type GuideResult = {
  matched: boolean; kind: 'procedure' | 'screen' | 'field' | 'fallback' | 'none'; confidence: 'high' | 'medium' | 'low'; answer: string;
  topic?: { id: string; title: string; href: string; menuPath: string; tab: string | null };
  related: { id: string; title: string }[]; notice: string;
};

// Returns the guide's answer when the question is about how to use the system; null lets the caller use the data assistant instead.
export async function askGuide(question: string, page?: string): Promise<GuideResult | null> {
  try {
    const result = await api<GuideResult>('/guide/ask', { method: 'POST', body: JSON.stringify({ question, ...(page ? { page } : {}) }) });
    return result.matched ? result : null;
  } catch { return null; }
}
export const guideTopic = (id: string) => api<GuideResult>(`/guide/topics/${encodeURIComponent(id)}`);
export const explainPage = (page: string) => api<GuideResult>(`/guide/screen?page=${encodeURIComponent(page)}`);
