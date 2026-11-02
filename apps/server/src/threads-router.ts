import express, { Router } from 'express';
import { db as client } from '@peep/agent/server';
import { AuthenticationRouter } from '@peep/agent/server';

export const threadsRouter: Router = express.Router();

const authService = new AuthenticationRouter();

const requireAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    // Header only: a session token in the URL (?token=) lands in access logs and browser history.
    const token = (req.headers['authorization'] || '').replace('Bearer ', '') || (req.headers['session'] as string);
    if (!token) {
      res.status(401).json({ error: 'Unauthorized: Missing session token' });
      return;
    }
    const session = await authService.validateSession(token);
    (req as any).user = session;
    next();
  } catch (err: any) {
    res.status(401).json({ error: 'Unauthorized: ' + (err.message || 'Invalid session') });
  }
};

// List Threads
threadsRouter.get('/', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const dbClient = await client.connect();
    try {
      await dbClient.query('BEGIN');
      await dbClient.query('SET LOCAL ROLE api_user');
      await dbClient.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
      
      const result = await dbClient.query(`
        SELECT id, title, created_at, updated_at
        FROM chat_threads
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT 100
      `, [userId]);
      
      await dbClient.query('COMMIT');
      res.json({ threads: result.rows });
    } catch (e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }
  } catch (err) {
    console.error('[GET /v1/threads]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get Thread by ID
threadsRouter.get('/:id', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const threadId = req.params.id;

    const dbClient = await client.connect();
    try {
      await dbClient.query('BEGIN');
      await dbClient.query('SET LOCAL ROLE api_user');
      await dbClient.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
      
      const threadResult = await dbClient.query(`
        SELECT id, title, created_at, updated_at
        FROM chat_threads
        WHERE id = $1 AND user_id = $2
      `, [threadId, userId]);
      
      if (threadResult.rows.length === 0) {
        await dbClient.query('COMMIT');
        res.status(404).json({ error: 'Thread not found' });
        return;
      }

      const messagesResult = await dbClient.query(`
        SELECT id, role, content, tool_calls, created_at
        FROM chat_messages
        WHERE thread_id = $1
        ORDER BY created_at ASC
      `, [threadId]);

      const runsResult = await dbClient.query(`
        SELECT run_id, started_at, completed_at, status, timeline_activities, updated_at
        FROM chat_runs
        WHERE thread_id = $1
        ORDER BY started_at ASC
      `, [threadId]);

      await dbClient.query('COMMIT');
      
      res.json({
        ...threadResult.rows[0],
        messages: messagesResult.rows,
        runs: runsResult.rows
      });
    } catch (e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }
  } catch (err) {
    console.error('[GET /v1/threads/:id]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Upsert Thread
threadsRouter.post('/:id', requireAuth, express.json(), async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const threadId = req.params.id;
    const { messages = [], title = 'New Chat', runs = [] } = req.body;

    const dbClient = await client.connect();
    try {
      await dbClient.query('BEGIN');
      await dbClient.query('SET LOCAL ROLE api_user');
      await dbClient.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
      
      // Upsert Thread
      await dbClient.query(`
        INSERT INTO chat_threads (id, user_id, title, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (id) DO UPDATE SET 
          title = EXCLUDED.title,
          updated_at = EXCLUDED.updated_at
        WHERE chat_threads.user_id = $2
      `, [threadId, userId, title]);

      // Wipe old messages and runs for this thread (safe due to transaction + RLS)
      await dbClient.query('DELETE FROM chat_messages WHERE thread_id = $1', [threadId]);
      await dbClient.query('DELETE FROM chat_runs WHERE thread_id = $1', [threadId]);

      // Insert Messages
      for (const msg of messages) {
        await dbClient.query(`
          INSERT INTO chat_messages (id, thread_id, role, content, tool_calls, created_at)
          VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()))
        `, [
          (!msg.id || msg.id === 'welcome') ? require('crypto').randomUUID() : msg.id,
          threadId,
          msg.role,
          msg.content || '',
          msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
          msg.created_at || null
        ]);
      }

      // Insert Runs
      for (const run of runs) {
        await dbClient.query(`
          INSERT INTO chat_runs (run_id, thread_id, started_at, completed_at, status, timeline_activities, updated_at)
          VALUES ($1, $2, COALESCE($3, NOW()), $4, $5, $6, COALESCE($7, NOW()))
        `, [
          run.run_id || require('crypto').randomUUID(),
          threadId,
          run.started_at || null,
          run.completed_at || null,
          run.status || 'completed',
          run.timeline_activities ? JSON.stringify(run.timeline_activities) : '[]',
          run.updated_at || null
        ]);
      }

      await dbClient.query('COMMIT');
      res.json({ success: true, id: threadId });
    } catch (e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }
  } catch (err) {
    console.error('[POST /v1/threads/:id]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Delete Thread
threadsRouter.delete('/:id', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const threadId = req.params.id;

    const dbClient = await client.connect();
    try {
      await dbClient.query('BEGIN');
      await dbClient.query('SET LOCAL ROLE api_user');
      await dbClient.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
      
      await dbClient.query(`
        DELETE FROM chat_threads
        WHERE id = $1 AND user_id = $2
      `, [threadId, userId]);
      
      await dbClient.query('COMMIT');
      res.json({ success: true });
    } catch (e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }
  } catch (err) {
    console.error('[DELETE /v1/threads/:id]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
