// Default texts of the automatic WhatsApp messages. Tenants override `body`/`enabled` in WhatsappAutoMessage.
export type AutoMessageKey = 'welcome' | 'out_of_hours' | 'fallback' | 'handoff' | 'order_received' | 'order_preparing' | 'order_ready' | 'order_out_for_delivery' | 'order_completed' | 'order_cancelled' | 'reservation_confirmed';

export type AutoMessageDef = { key: AutoMessageKey; title: string; description: string; variables: string[]; defaultBody: string; defaultEnabled: boolean; kind: 'bot' | 'order' };

export const AUTO_MESSAGES: AutoMessageDef[] = [
  { key: 'welcome', kind: 'bot', title: 'Boas-vindas', description: 'Primeira mensagem do cliente (e quando ele volta depois de um tempo).', variables: ['nome', 'restaurante', 'menu'], defaultEnabled: true,
    defaultBody: 'Olá, {{nome}}! 👋 Eu sou o assistente virtual do {{restaurante}}.\n\nComo posso ajudar?\n{{menu}}' },
  { key: 'out_of_hours', kind: 'bot', title: 'Fora do horário', description: 'Aviso extra quando o restaurante está fechado.', variables: ['restaurante', 'horario'], defaultEnabled: true,
    defaultBody: 'No momento o {{restaurante}} está fechado. 🕘\n{{horario}}\nVocê ainda pode ver o cardápio e deixar sua dúvida por aqui.' },
  { key: 'fallback', kind: 'bot', title: 'Resposta padrão', description: 'Quando o robô não entende a pergunta.', variables: ['nome', 'menu'], defaultEnabled: true,
    defaultBody: 'Não consegui entender sua pergunta, {{nome}}. 😅\nEscolha uma opção:\n{{menu}}\nOu digite *atendente* para falar com uma pessoa.' },
  { key: 'handoff', kind: 'bot', title: 'Passando para atendente', description: 'Quando o cliente pede para falar com uma pessoa.', variables: ['nome', 'restaurante'], defaultEnabled: true,
    defaultBody: 'Certo, {{nome}}! Vou chamar um atendente do {{restaurante}}. Aguarde só um instante. 🙋' },
  { key: 'order_received', kind: 'order', title: 'Pedido recebido', description: 'Enviada quando o pedido é registrado.', variables: ['nome', 'pedido', 'total', 'restaurante', 'agendado'], defaultEnabled: true,
    defaultBody: 'Olá, {{nome}}! Recebemos seu pedido *{{pedido}}* no valor de {{total}}.{{agendado}} Obrigado por escolher o {{restaurante}}! 🍽️' },
  { key: 'order_preparing', kind: 'order', title: 'Em preparo', description: 'Enviada quando a cozinha começa o preparo.', variables: ['nome', 'pedido', 'restaurante'], defaultEnabled: false,
    defaultBody: '{{nome}}, seu pedido *{{pedido}}* já está em preparo! 👨‍🍳' },
  { key: 'order_ready', kind: 'order', title: 'Pedido pronto', description: 'Enviada quando o pedido fica pronto.', variables: ['nome', 'pedido', 'restaurante'], defaultEnabled: true,
    defaultBody: '{{nome}}, seu pedido *{{pedido}}* está pronto! ✅' },
  { key: 'order_out_for_delivery', kind: 'order', title: 'Saiu para entrega', description: 'Enviada quando o entregador sai com o pedido.', variables: ['nome', 'pedido', 'entregador', 'restaurante'], defaultEnabled: true,
    defaultBody: '{{nome}}, seu pedido *{{pedido}}* saiu para entrega{{entregador}}. 🛵' },
  { key: 'order_completed', kind: 'order', title: 'Pedido finalizado', description: 'Enviada quando o pedido é concluído.', variables: ['nome', 'pedido', 'restaurante'], defaultEnabled: false,
    defaultBody: 'Pedido *{{pedido}}* finalizado. Obrigado, {{nome}}! Volte sempre ao {{restaurante}}. 💛' },
  { key: 'order_cancelled', kind: 'order', title: 'Pedido cancelado', description: 'Enviada quando o pedido é cancelado.', variables: ['nome', 'pedido', 'restaurante'], defaultEnabled: true,
    defaultBody: '{{nome}}, seu pedido *{{pedido}}* foi cancelado. Se precisar de ajuda, responda esta mensagem.' },
  { key: 'reservation_confirmed', kind: 'order', title: 'Reserva confirmada', description: 'Enviada quando a reserva é confirmada.', variables: ['nome', 'data', 'pessoas', 'restaurante'], defaultEnabled: true,
    defaultBody: '{{nome}}, sua reserva para {{pessoas}} pessoa(s) em {{data}} está confirmada no {{restaurante}}. 🪑' },
];

export const autoMessageDef = (key: string) => AUTO_MESSAGES.find(item => item.key === key);

// Replaces {{variable}} placeholders; unknown variables become empty so a bad template never leaks the raw token.
export function renderTemplate(body: string, values: Record<string, string | number | null | undefined>): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_match, name: string) => String(values[name] ?? '')).replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim();
}
