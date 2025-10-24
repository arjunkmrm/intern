import { runAgentQuery, type AgentSession } from './agent';

// In-memory state (persists as long as container is alive)
const state: Record<string, any> = {};

// Agent sessions stored in memory
const agentSessions: Map<string, AgentSession> = new Map();

// Helper to parse JSON body
async function getBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// Helper to create JSON response
function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const server = Bun.serve({
  port: 8080,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // GET / - Health check
    if (path === '/' && method === 'GET') {
      const instanceId = process.env.CLOUDFLARE_DURABLE_OBJECT_ID || 'unknown';
      return jsonResponse({
        status: 'ok',
        instanceId,
        endpoints: {
          agent: '/agent',
          state: '/state',
        },
      });
    }

    // POST /state - Set a value
    if (path === '/state' && method === 'POST') {
      const body = await getBody(req);
      const { key, value } = body || {};

      if (!key) {
        return jsonResponse({ error: 'Missing key' }, 400);
      }

      state[key] = value;
      return jsonResponse({ message: 'State updated', key, value });
    }

    // GET /state - Get all state
    if (path === '/state' && method === 'GET') {
      return jsonResponse(state);
    }

    // GET /state/:key - Get a value
    if (path.startsWith('/state/') && method === 'GET') {
      const key = path.slice(7); // Remove '/state/'

      if (!(key in state)) {
        return jsonResponse({ error: 'Key not found' }, 404);
      }

      return jsonResponse({ key, value: state[key] });
    }

    // DELETE /state/:key - Delete a value
    if (path.startsWith('/state/') && method === 'DELETE') {
      const key = path.slice(7); // Remove '/state/'

      if (!(key in state)) {
        return jsonResponse({ error: 'Key not found' }, 404);
      }

      delete state[key];
      return jsonResponse({ message: 'State deleted', key });
    }

    // AGENT ENDPOINTS - Claude Messages API Integration

    // POST /agent/create - Create a new agent session
    if (path === '/agent/create' && method === 'POST') {
      const body = await getBody(req);
      const { sessionId, systemPrompt, model, webSearch, webSearchConfig } = body || {};

      if (!sessionId) {
        return jsonResponse({ error: 'Missing sessionId' }, 400);
      }

      if (agentSessions.has(sessionId)) {
        return jsonResponse({ error: 'Session already exists' }, 409);
      }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return jsonResponse({ error: 'ANTHROPIC_API_KEY not set' }, 500);
      }

      agentSessions.set(sessionId, {
        messages: [],
        systemPrompt: systemPrompt || 'You are a helpful AI assistant.',
        model: model || 'claude-sonnet-4-5',
        webSearch: webSearch || false,
        webSearchConfig: webSearchConfig,
        createdAt: new Date(),
      });

      return jsonResponse({
        message: 'Agent session created',
        sessionId,
        model: model || 'claude-sonnet-4-5',
        webSearch: webSearch || false,
      });
    }

    // POST /agent/:sessionId/query - Send a query to an agent
    if (path.startsWith('/agent/') && path.endsWith('/query') && method === 'POST') {
      const sessionId = path.split('/')[2];
      const body = await getBody(req);
      const { prompt, stream = false } = body || {};

      if (!prompt) {
        return jsonResponse({ error: 'Missing prompt' }, 400);
      }

      const session = agentSessions.get(sessionId);
      if (!session) {
        return jsonResponse({ error: 'Session not found' }, 404);
      }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return jsonResponse({ error: 'ANTHROPIC_API_KEY not set' }, 500);
      }

      try {
        const result = await runAgentQuery(session, prompt, apiKey, stream);

        if (result.type === 'stream') {
          return new Response(result.stream, {
            headers: {
              'Content-Type': 'application/x-ndjson',
              'Transfer-Encoding': 'chunked',
            },
          });
        } else {
          return jsonResponse({
            sessionId,
            message: result.message,
            totalMessages: session.messages.length,
          });
        }
      } catch (error) {
        return jsonResponse({
          error: 'Query failed',
          details: error instanceof Error ? error.message : String(error),
        }, 500);
      }
    }

    // GET /agent/:sessionId - Get agent session info
    if (path.startsWith('/agent/') && path.split('/').length === 3 && method === 'GET') {
      const sessionId = path.split('/')[2];
      
      const session = agentSessions.get(sessionId);
      if (!session) {
        return jsonResponse({ error: 'Session not found' }, 404);
      }

      return jsonResponse({
        sessionId,
        messageCount: session.messages.length,
        model: session.model,
        systemPrompt: session.systemPrompt,
        createdAt: session.createdAt,
      });
    }

    // GET /agent/:sessionId/messages - Get conversation history
    if (path.startsWith('/agent/') && path.endsWith('/messages') && method === 'GET') {
      const sessionId = path.split('/')[2];
      
      const session = agentSessions.get(sessionId);
      if (!session) {
        return jsonResponse({ error: 'Session not found' }, 404);
      }

      return jsonResponse({
        sessionId,
        messages: session.messages,
        count: session.messages.length,
      });
    }

    // GET /agent - List all agent sessions
    if (path === '/agent' && method === 'GET') {
      const sessions = Array.from(agentSessions.entries()).map(([sessionId, session]) => ({
        sessionId,
        messageCount: session.messages.length,
        model: session.model,
        createdAt: session.createdAt,
      }));

      return jsonResponse({ sessions, count: sessions.length });
    }

    // DELETE /agent/:sessionId - Delete an agent session
    if (path.startsWith('/agent/') && path.split('/').length === 3 && method === 'DELETE') {
      const sessionId = path.split('/')[2];
      
      if (!agentSessions.has(sessionId)) {
        return jsonResponse({ error: 'Session not found' }, 404);
      }

      agentSessions.delete(sessionId);
      return jsonResponse({ message: 'Session deleted', sessionId });
    }

    // 404 Not Found
    return jsonResponse({ error: 'Not found' }, 404);
  },
});

console.log(`Bun server listening on port ${server.port}`);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  server.stop();
  process.exit(0);
});

