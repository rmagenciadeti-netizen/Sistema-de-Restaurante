import { Prisma, PrismaClient } from '@prisma/client';

const MAX_RETRIES = 5;

// Serializable transactions can lose a write conflict (P2034) when two requests of the same restaurant touch the same row at once
// (for example the first order of a company creating its settings row). The loser is retried after a short random pause instead of failing with a 500.
export async function serializable<T>(client: PrismaClient, operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034' || attempt >= MAX_RETRIES) throw error;
      await new Promise(resolve => setTimeout(resolve, 15 + Math.random() * 35 * (attempt + 1)));
    }
  }
}
