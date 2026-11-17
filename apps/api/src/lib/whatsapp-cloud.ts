import type { OutboundMessage, WhatsappProvider } from './whatsapp-worker';

export type TemplateConfig = { name: string; language: string; params: string[] };
export type CloudConfig = { token: string; phoneNumberId: string; templates: Record<string, TemplateConfig>; apiVersion?: string; fetchImpl?: typeof fetch };

// Adapter for the official WhatsApp Business Cloud API. Templates must be created and approved in Meta Business Manager;
// `params` lists the payload keys that fill the template body variables, in order.
export class WhatsappCloudProvider implements WhatsappProvider {
  constructor(private readonly config: CloudConfig) {}

  async send(message: OutboundMessage): Promise<{ providerRef: string }> {
    const template = this.config.templates[message.template];
    if (!template) throw new Error(`No WhatsApp template configured for "${message.template}"`);
    const payload = (message.payload && typeof message.payload === 'object' ? message.payload : {}) as Record<string, unknown>;
    const parameters = template.params.map(key => ({ type: 'text', text: String(payload[key] ?? '') }));
    const response = await (this.config.fetchImpl ?? fetch)(`https://graph.facebook.com/${this.config.apiVersion ?? 'v21.0'}/${this.config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: message.toPhone,
        type: 'template',
        template: { name: template.name, language: { code: template.language }, ...(parameters.length ? { components: [{ type: 'body', parameters }] } : {}) },
      }),
    });
    const body = await response.json().catch(() => ({})) as { messages?: Array<{ id: string }>; error?: { message?: string } };
    if (!response.ok || !body.messages?.[0]?.id) throw new Error(`WhatsApp API error ${response.status}: ${body.error?.message ?? 'no message id returned'}`);
    return { providerRef: body.messages[0].id };
  }
}

export function whatsappProviderFromEnv(env: NodeJS.ProcessEnv = process.env): WhatsappProvider | null {
  const { WHATSAPP_TOKEN: token, WHATSAPP_PHONE_NUMBER_ID: phoneNumberId, WHATSAPP_TEMPLATES: templatesJson } = env;
  if (!token || !phoneNumberId || !templatesJson) return null;
  let templates: Record<string, TemplateConfig>;
  try { templates = JSON.parse(templatesJson); } catch { throw new Error('WHATSAPP_TEMPLATES must be valid JSON'); }
  return new WhatsappCloudProvider({ token, phoneNumberId, templates });
}
