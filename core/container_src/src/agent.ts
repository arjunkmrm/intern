import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

export interface AgentSession {
  messages: MessageParam[];
  systemPrompt?: string;
  model?: string;
  webSearch?: boolean;
  webSearchConfig?: {
    maxUses?: number;
    allowedDomains?: string[];
    blockedDomains?: string[];
    userLocation?: {
      type: 'approximate';
      city?: string;
      region?: string;
      country?: string;
      timezone?: string;
    };
  };
  createdAt: Date;
}

export interface AgentQueryResult {
  type: 'stream' | 'message';
  stream?: ReadableStream;
  message?: any;
}

// Run agent query with agentic loop (supports tools in future)
export async function runAgentQuery(
  session: AgentSession,
  prompt: string,
  apiKey: string,
  stream: boolean = false
): Promise<AgentQueryResult> {
  const anthropic = new Anthropic({ apiKey });

  // Add user message to conversation
  const userMessage: MessageParam = {
    role: 'user',
    content: prompt,
  };
  const conversationMessages = [...session.messages, userMessage];

  // Build tools array
  const tools: any[] = [];
  
  // Add web search tool if enabled
  if (session.webSearch) {
    const webSearchTool: any = {
      type: 'web_search_20250305',
      name: 'web_search',
    };
    
    if (session.webSearchConfig) {
      if (session.webSearchConfig.maxUses) {
        webSearchTool.max_uses = session.webSearchConfig.maxUses;
      }
      if (session.webSearchConfig.allowedDomains) {
        webSearchTool.allowed_domains = session.webSearchConfig.allowedDomains;
      }
      if (session.webSearchConfig.blockedDomains) {
        webSearchTool.blocked_domains = session.webSearchConfig.blockedDomains;
      }
      if (session.webSearchConfig.userLocation) {
        webSearchTool.user_location = session.webSearchConfig.userLocation;
      }
    }
    
    tools.push(webSearchTool);
  }

  // Agentic loop - for now just one iteration, but structured for tool support
  let currentMessages = conversationMessages;
  let finalResponse = null;
  let iterations = 0;
  const maxIterations = 10; // Prevent infinite loops

  while (iterations < maxIterations) {
    iterations++;

    if (stream) {
      // Streaming response
      const messageStream = await anthropic.messages.create({
        model: session.model || 'claude-sonnet-4-5',
        max_tokens: 4096,
        system: session.systemPrompt,
        messages: currentMessages,
        stream: true,
        ...(tools.length > 0 && { tools }),
      });

      let fullContent = '';
      const streamResponse = new ReadableStream({
        async start(controller) {
          try {
            for await (const event of messageStream) {
              if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                fullContent += event.delta.text;
              }
              controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
            }

            // Save to session after streaming completes
            session.messages.push(userMessage);
            session.messages.push({
              role: 'assistant',
              content: fullContent,
            });

            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });

      return {
        type: 'stream',
        stream: streamResponse,
      };
    } else {
      // Non-streaming response
      const message = await anthropic.messages.create({
        model: session.model || 'claude-sonnet-4-5',
        max_tokens: 4096,
        system: session.systemPrompt,
        messages: currentMessages,
        ...(tools.length > 0 && { tools }),
      });

      // Check if we have tool calls
      const hasToolUse = message.content.some(
        (block) => block.type === 'tool_use'
      );

      if (hasToolUse) {
        // For web search, the tool is executed server-side by Anthropic
        // We just need to continue with the response
        // In the future, we could handle custom tools here
        
        // For now, just return the response with tool results
        session.messages.push(userMessage);
        session.messages.push({
          role: 'assistant',
          content: message.content,
        });

        finalResponse = message;
        break;
      } else {
        // Final response - save to session
        session.messages.push(userMessage);
        session.messages.push({
          role: 'assistant',
          content: message.content,
        });

        finalResponse = message;
        break;
      }
    }
  }

  if (iterations >= maxIterations) {
    throw new Error('Agent exceeded maximum iterations');
  }

  return {
    type: 'message',
    message: finalResponse,
  };
}

