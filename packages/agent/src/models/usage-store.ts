import { db } from './db';

export interface UsageRecord {
  userId: string;
  requestId: string;
  modelTier: string;
  resolvedModel: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  timestamp: number;
  status: 'success' | 'failed' | 'cancelled' | 'rejected';
  /** Defaults to 'chat'. */
  purpose?: 'chat' | 'completion';
}

export class ServerUsageStore {
  async recordUsage(record: Omit<UsageRecord, 'timestamp'>): Promise<void> {
    await db.query(
      `INSERT INTO usage_records (
        user_id, request_id, model_tier, resolved_model, 
        input_tokens, output_tokens, total_tokens, 
        estimated_cost, status, purpose, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (request_id) DO NOTHING`,
      [
        record.userId, record.requestId, record.modelTier, record.resolvedModel,
        record.inputTokens, record.outputTokens, record.totalTokens,
        record.estimatedCost, record.status, record.purpose ?? 'chat'
      ]
    );
  }

  async getRecordsForUser(userId: string): Promise<UsageRecord[]> {
    const res = await db.query(
      `SELECT * FROM usage_records WHERE user_id = $1 ORDER BY timestamp DESC`,
      [userId]
    );
    return res.rows.map(row => ({
      userId: row.user_id,
      requestId: row.request_id,
      modelTier: row.model_tier,
      resolvedModel: row.resolved_model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      estimatedCost: parseFloat(row.estimated_cost),
      timestamp: new Date(row.timestamp).getTime(),
      status: row.status as any
    }));
  }

  async getAccumulatedCost(userId: string): Promise<number> {
    const res = await db.query(
      `SELECT COALESCE(SUM(estimated_cost), 0) as total FROM usage_records WHERE user_id = $1 AND status = 'success'`,
      [userId]
    );
    return parseFloat(res.rows[0].total);
  }

  async clear(): Promise<void> {
    // Used in tests
    if (process.env.NODE_ENV === 'test') {
      await db.query('TRUNCATE TABLE usage_records CASCADE');
    }
  }
}
