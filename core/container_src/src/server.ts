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
      const { sessionId, systemPrompt, model } = body || {};

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

      // Web search enabled by default with sensible defaults
      const defaultSystemPrompt = `You are a smart, helpful intern assistant with access to web search.

Your role is to help with email responses and general tasks. When responding:
- Be concise and to the point
- Use web search to find up-to-date information when needed
- Maintain a professional but friendly tone
- Get straight to the answer without unnecessary preamble
- If asked to draft an email, keep it brief and action-oriented

You have access to real-time web search to answer questions with current information.`;

      agentSessions.set(sessionId, {
        messages: [],
        systemPrompt: systemPrompt || defaultSystemPrompt,
        model: model || 'claude-sonnet-4-5',
        webSearch: true,
        webSearchConfig: {
          maxUses: 5,
        },
        createdAt: new Date(),
      });

      return jsonResponse({
        message: 'Agent session created',
        sessionId,
      });
    }

    // POST /agent/:sessionId/query - Send a query to an agent
    if (path.startsWith('/agent/') && path.endsWith('/query') && method === 'POST') {
      const sessionId = path.split('/')[2];
      const body = await getBody(req);
      const { prompt, stream = false, to, subject } = body || {};

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
          // For streaming, return text-only stream
          const textStream = new ReadableStream({
            async start(controller) {
              const reader = result.stream!.getReader();
              const decoder = new TextDecoder();
              
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  
                  const chunk = decoder.decode(value, { stream: true });
                  const lines = chunk.split('\n').filter(line => line.trim());
                  
                  for (const line of lines) {
                    try {
                      const event = JSON.parse(line);
                      // Only send text content
                      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                        controller.enqueue(new TextEncoder().encode(event.delta.text));
                      }
                    } catch {}
                  }
                }
                controller.close();
              } catch (error) {
                controller.error(error);
              }
            }
          });

          return new Response(textStream, {
            headers: {
              'Content-Type': 'text/plain',
              'Transfer-Encoding': 'chunked',
            },
          });
        } else {
          // Extract just the text content
          const message = result.message;
          let textContent = '';
          
          if (message && message.content) {
            for (const block of message.content) {
              if (block.type === 'text') {
                textContent += block.text;
              }
            }
          }

          // Send email by default to hardcoded address
          if (textContent) {
            try {
              const emailPayload = {
                to: to || 'ri.kwmachinelearning@gmail.com',
                subject: subject || 'Intern Assistant Response',
                htmlBody: textContent,
              };

              await fetch('https://script.google.com/macros/s/AKfycby3OdX6lgv3otIxf2M4TRJKvhLgXe30bLKPJmu28xrpCpprHRQClXyElcXog6a7yL_0ew/exec', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(emailPayload),
              });

              return jsonResponse({
                text: textContent,
                emailSent: true,
                to: emailPayload.to,
                subject: emailPayload.subject,
              });
            } catch (emailError) {
              return jsonResponse({
                text: textContent,
                emailSent: false,
                emailError: emailError instanceof Error ? emailError.message : 'Failed to send email',
              });
            }
          }

          return jsonResponse({
            text: textContent,
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

