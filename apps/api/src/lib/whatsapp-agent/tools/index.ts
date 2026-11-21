import { z } from 'zod';
import type { ToolSpec } from '../../ai/chat';
import type { AgentSettings, ToolDef } from '../types';
import { infoTools } from './info';
import { menuTools } from './menu';
import { orderTools } from './orders';
import { reservationTools } from './reservations';
import { supportTools } from './support';

const ALL: ToolDef[] = [...infoTools, ...menuTools, ...reservationTools, ...orderTools, ...supportTools];

// Only the tools the restaurant allows exist for the model; a switched-off capability is not merely discouraged in the prompt, it is absent.
export function toolsFor(agent: AgentSettings): ToolDef[] {
  return ALL.filter(tool => {
    if (tool.capability === 'reservations') return agent.allowReservations;
    if (tool.capability === 'orders') return agent.allowOrders;
    if (tool.capability === 'orderChanges') return agent.allowOrders && agent.allowOrderChanges;
    return true;
  });
}

// Plain JSON Schema that every provider accepts (OpenAI, Anthropic and the stricter OpenAI-compatible gateways such as Gemini's): no $schema, additionalProperties,
// defaults or exclusive bounds. The backend validates every argument again with the real zod schema, so nothing is lost.
function plain(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(plain);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$schema' || key === 'additionalProperties' || key === 'default') continue;
    if (key === 'exclusiveMinimum') { out.minimum = value; continue; }
    out[key] = plain(value);
  }
  return out;
}
export function toSpec(tool: ToolDef): ToolSpec {
  return { name: tool.name, description: tool.description, parameters: plain(z.toJSONSchema(tool.schema, { target: 'draft-7', io: 'input' })) as Record<string, unknown> };
}
