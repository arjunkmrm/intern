# Example Query Flow

This document walks through a complete query flow in the Intern system, from initial request to final response.

## Architecture Overview

```
User Request → Cloudflare Worker → Container (Bun Server) → Claude API → Response
              (index.ts)           (server.ts)            (agent.ts)
```

## Components

1. **Cloudflare Worker** (`core/src/index.ts`) - Entry point, routes requests to containers
2. **Container Server** (`core/container_src/src/server.ts`) - Bun server handling agent sessions and state
3. **Agent Logic** (`core/container_src/src/agent.ts`) - Claude API integration with web search

---

## Complete Example: Weather Query

### Scenario
User asks: "What's the weather in San Francisco today?"

### Step 1: Create Agent Session

**Request:**
```bash
POST https://your-worker.workers.dev/singleton/agent/create
Content-Type: application/json

{
  "sessionId": "weather-session"
}
```

**Flow:**
1. Cloudflare Worker receives request at `/singleton/agent/create`
2. Worker extracts path `/agent/create` and forwards to container
3. Container creates new session in memory with default configuration:
   - Web search: Enabled
   - Max searches: 5
   - Model: claude-sonnet-4-5
   - System prompt: Default assistant prompt

**Response:**
```json
{
  "message": "Agent session created",
  "sessionId": "weather-session"
}
```

**Code Path:**
- `index.ts` lines 98-107: Routes POST to singleton container
- `server.ts` lines 90-134: Creates session and stores in `agentSessions` Map

---

### Step 2: Send Query to Agent

**Request:**
```bash
POST https://your-worker.workers.dev/singleton/agent/weather-session/query
Content-Type: application/json

{
  "prompt": "What's the weather in San Francisco today?"
}
```

**Flow:**

#### 2.1 Worker Routing
- Worker receives POST at `/singleton/agent/weather-session/query`
- Extracts path: `/agent/weather-session/query`
- Gets singleton container using `getContainer(c.env.MY_CONTAINER)`
- Forwards request to container's port 8080

#### 2.2 Container Processing
- Container parses path to extract `sessionId = "weather-session"`
- Retrieves session from `agentSessions` Map
- Validates API key exists
- Calls `runAgentQuery(session, prompt, apiKey, stream=false)`

#### 2.3 Agent Query Execution
Inside `agent.ts`:

1. **Build Conversation** (lines 40-44):
   - Creates user message object
   - Appends to existing conversation history
   ```typescript
   const userMessage = {
     role: 'user',
     content: 'What\'s the weather in San Francisco today?'
   }
   const conversationMessages = [...session.messages, userMessage]
   ```

2. **Configure Tools** (lines 46-72):
   - Adds web search tool to tools array
   - Configures with session settings (maxUses: 5)
   ```typescript
   tools = [{
     type: 'web_search_20250305',
     name: 'web_search',
     max_uses: 5
   }]
   ```

3. **Call Claude API** (lines 125-131):
   - Sends request to Anthropic Messages API
   - Includes conversation history, system prompt, and tools
   ```typescript
   const message = await anthropic.messages.create({
     model: 'claude-sonnet-4-5',
     max_tokens: 4096,
     system: session.systemPrompt,
     messages: conversationMessages,
     tools: tools
   })
   ```

4. **Claude Processing**:
   - Claude analyzes the query
   - Decides to use web search tool (weather requires current data)
   - Executes web search server-side
   - Generates response based on search results

5. **Save to Session** (lines 153-158):
   - Stores user message and assistant response
   - Updates session's message history
   ```typescript
   session.messages.push(userMessage)
   session.messages.push({
     role: 'assistant',
     content: message.content
   })
   ```

#### 2.4 Response Processing
Back in `server.ts` (lines 198-244):

1. **Extract Text Content**:
   - Iterates through response content blocks
   - Extracts only text content (filters out tool_use blocks)
   ```typescript
   let textContent = ''
   for (const block of message.content) {
     if (block.type === 'text') {
       textContent += block.text
     }
   }
   ```

2. **Send Email** (lines 211-225):
   - Automatically sends response via Google Apps Script webhook
   - Default recipient: best.intern.in.sg@gmail.com
   - Subject: "Intern Assistant Response"

3. **Return JSON**:
   ```json
   {
     "text": "Based on current weather data, San Francisco is experiencing...",
     "emailSent": true,
     "to": "best.intern.in.sg@gmail.com",
     "subject": "Intern Assistant Response"
   }
   ```

---

### Step 3: Follow-up Query (Stateful)

**Request:**
```bash
POST https://your-worker.workers.dev/singleton/agent/weather-session/query
Content-Type: application/json

{
  "prompt": "What about tomorrow?"
}
```

**Flow:**
- Same routing as Step 2
- Session contains previous conversation history
- Claude understands context ("tomorrow" refers to San Francisco weather)
- Can perform another web search if needed
- Responds appropriately with context awareness

**Response:**
```json
{
  "text": "Tomorrow in San Francisco, the forecast shows...",
  "emailSent": true,
  "to": "best.intern.in.sg@gmail.com",
  "subject": "Intern Assistant Response"
}
```

---

## Alternative Flow: Streaming Response

**Request:**
```bash
POST https://your-worker.workers.dev/singleton/agent/weather-session/query
Content-Type: application/json

{
  "prompt": "Explain climate change",
  "stream": true
}
```

**Flow:**
1. Same routing through worker and container
2. `agent.ts` uses streaming API (lines 84-122)
3. Response streams as Server-Sent Events
4. `server.ts` transforms to plain text stream (lines 159-196)

**Response:**
```
Content-Type: text/plain
Transfer-Encoding: chunked

Climate change refers to...
[text streams in real-time]
```

---

## Session Management Examples

### Get Session Info
```bash
GET https://your-worker.workers.dev/singleton/agent/weather-session

# Response:
{
  "sessionId": "weather-session",
  "messageCount": 4,
  "model": "claude-sonnet-4-5",
  "systemPrompt": "You are a smart, helpful intern assistant...",
  "createdAt": "2025-10-24T12:00:00.000Z"
}
```

### Get Conversation History
```bash
GET https://your-worker.workers.dev/singleton/agent/weather-session/messages

# Response:
{
  "sessionId": "weather-session",
  "messages": [
    { "role": "user", "content": "What's the weather in San Francisco today?" },
    { "role": "assistant", "content": "Based on current weather data..." },
    { "role": "user", "content": "What about tomorrow?" },
    { "role": "assistant", "content": "Tomorrow in San Francisco..." }
  ],
  "count": 4
}
```

### Delete Session
```bash
DELETE https://your-worker.workers.dev/singleton/agent/weather-session

# Response:
{
  "message": "Session deleted",
  "sessionId": "weather-session"
}
```

---

## Key Features

### Web Search Integration
- Enabled by default for all sessions
- Claude automatically decides when to search
- Up to 5 searches per query
- Server-side execution by Anthropic

### Stateful Conversations
- Messages stored in `agentSessions` Map
- Persists for container lifetime
- Each query includes full conversation history
- Context awareness across multiple queries

### Email Integration
- Automatic email sending after each response
- Uses Google Apps Script webhook
- Configurable recipient and subject
- Falls back gracefully if email fails

### Container Lifecycle
- Containers auto-sleep after 2 minutes of inactivity
- State persists during container lifetime
- Wakes up automatically on new requests
- Singleton pattern ensures consistent state

---

## Error Handling

### Session Not Found
```json
{
  "error": "Session not found"
}
```
Status: 404

### Missing API Key
```json
{
  "error": "ANTHROPIC_API_KEY not set"
}
```
Status: 500

### Query Failed
```json
{
  "error": "Query failed",
  "details": "Rate limit exceeded"
}
```
Status: 500

---

## Data Flow Diagram

```
1. User Request
   |
   v
2. Cloudflare Worker (index.ts)
   - Routes to /singleton/*
   - Gets singleton container
   |
   v
3. Container Server (server.ts)
   - Parses path and method
   - Validates session exists
   - Extracts request body
   |
   v
4. Agent Logic (agent.ts)
   - Builds conversation history
   - Configures web search tool
   - Calls Claude API
   |
   v
5. Claude API (Anthropic)
   - Analyzes query
   - Executes web search if needed
   - Generates response
   |
   v
6. Response Processing (server.ts)
   - Extracts text content
   - Sends email notification
   - Returns JSON response
   |
   v
7. User receives response
```

---

## Performance Notes

- Container startup: ~1-2 seconds (cold start)
- Query latency: ~2-5 seconds (with web search)
- Streaming: Immediate first token, full response ~5-10 seconds
- Session storage: In-memory (fast access)
- Container sleep: After 2 minutes inactivity
- Auto-wake: Transparent to user

---

## Configuration Options

### Session Creation
```json
{
  "sessionId": "my-session",           // Required
  "systemPrompt": "Custom prompt...",  // Optional
  "model": "claude-opus-4"            // Optional (default: claude-sonnet-4-5)
}
```

### Query Options
```json
{
  "prompt": "Your question",           // Required
  "stream": false,                     // Optional (default: false)
  "to": "custom@email.com",           // Optional (default: best.intern.in.sg@gmail.com)
  "subject": "Custom Subject"         // Optional (default: "Intern Assistant Response")
}
```

---

## Future Enhancements

- Custom tool support (beyond web search)
- Multi-turn tool use in agentic loop
- Persistent storage (beyond container lifetime)
- Rate limiting and usage tracking
- Multiple container instances for load balancing
- Custom web search domain filtering

