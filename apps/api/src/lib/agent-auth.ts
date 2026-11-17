import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from './prisma';

export const hashAgentToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const generateAgentToken = () => `rmagt_${randomBytes(32).toString('base64url')}`;

export type AgentContext = { agentId: string; tenantId: string; unitId: string | null };
declare global { namespace Express { interface Request { agent?: AgentContext } } }

export async function requireAgent(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.match(/^Bearer\s+(rmagt_[\w-]+)$/)?.[1];
  if (!token) return res.status(401).json({ message: 'Agent token required' });
  try {
    const agent = await prisma.printAgent.findUnique({ where: { tokenHash: hashAgentToken(token) }, include: { tenant: { select: { status: true } } } });
    if (!agent || !agent.active || !['ACTIVE', 'TRIAL'].includes(agent.tenant.status)) return res.status(401).json({ message: 'Invalid agent token' });
    await prisma.printAgent.update({ where: { id: agent.id }, data: { lastSeenAt: new Date() } });
    req.agent = { agentId: agent.id, tenantId: agent.tenantId, unitId: agent.unitId };
    return next();
  } catch (error) { return next(error); }
}
