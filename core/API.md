# Container API Specification

## Base URL

Local development: `http://localhost:8787/singleton`
Production: `https://your-worker.workers.dev/singleton`

## Endpoints

### Health Check

**GET /**

Check if the container is running.

**Response:**
```json
{
  "status": "ok",
  "instanceId": "container-id",
  "endpoints": {
    "agent": "/agent",
    "state": "/state"
  }
}
```

---

## Agent Endpoints

### Create Agent Session

**POST /agent/create**

Create a new agent session with web search enabled by default.

**Request Body:**
```json
{
  "sessionId": "my-agent"          // Required: Unique session identifier
}
```

**Optional Parameters:**
```json
{
  "sessionId": "my-agent",         // Required
  "systemPrompt": "Custom prompt", // Optional: Default is "You are a helpful AI assistant with access to web search."
  "model": "claude-opus-4"         // Optional: Default is "claude-sonnet-4-5"
}
```

**Response:**
```json
{
  "message": "Agent session created",
  "sessionId": "my-agent"
}
```

**Default Configuration:**
- Web search: Enabled
- Max web searches per query: 5
- Model: Claude Sonnet 4.5
- System prompt: Includes web search capability

---

### Query Agent

**POST /agent/:sessionId/query**

Send a query to an agent session and get a text response.

**Request Body:**
```json
{
  "prompt": "What is the weather in NYC today?",  // Required
  "stream": false                                  // Optional: Default is false
}
```

**Response (non-streaming):**
```json
{
  "text": "Based on my search, the weather in NYC today is sunny with a high of 75°F..."
}
```

**Response (streaming):**
```
Content-Type: text/plain
Transfer-Encoding: chunked

Based on my search, the weather in NYC today is sunny...
```

**Features:**
- Stateful conversation (remembers previous messages in the session)
- Automatic web search when needed
- Clean text-only output
- Citations and metadata tracked internally but not returned

---

### Get Session Info

**GET /agent/:sessionId**

Get information about an agent session.

**Response:**
```json
{
  "sessionId": "my-agent",
  "messageCount": 4,
  "model": "claude-sonnet-4-5",
  "systemPrompt": "You are a helpful AI assistant with access to web search.",
  "createdAt": "2025-10-24T12:00:00.000Z"
}
```

---

### Get Conversation History

**GET /agent/:sessionId/messages**

Get all messages in a session.

**Response:**
```json
{
  "sessionId": "my-agent",
  "messages": [
    {
      "role": "user",
      "content": "What is the weather in NYC?"
    },
    {
      "role": "assistant",
      "content": "Based on my search..."
    }
  ],
  "count": 2
}
```

---

### List All Sessions

**GET /agent**

List all active agent sessions.

**Response:**
```json
{
  "sessions": [
    {
      "sessionId": "my-agent",
      "messageCount": 4,
      "model": "claude-sonnet-4-5",
      "createdAt": "2025-10-24T12:00:00.000Z"
    }
  ],
  "count": 1
}
```

---

### Delete Session

**DELETE /agent/:sessionId**

Delete an agent session and its conversation history.

**Response:**
```json
{
  "message": "Session deleted",
  "sessionId": "my-agent"
}
```

---

## State Management Endpoints

### Set State

**POST /state**

Store a key-value pair in container state.

**Request Body:**
```json
{
  "key": "counter",
  "value": 42
}
```

**Response:**
```json
{
  "message": "State updated",
  "key": "counter",
  "value": 42
}
```

---

### Get All State

**GET /state**

Get all state values.

**Response:**
```json
{
  "counter": 42,
  "name": "Alice"
}
```

---

### Get State Value

**GET /state/:key**

Get a specific state value.

**Response:**
```json
{
  "key": "counter",
  "value": 42
}
```

---

### Delete State Value

**DELETE /state/:key**

Delete a state value.

**Response:**
```json
{
  "message": "State deleted",
  "key": "counter"
}
```

---

## Usage Examples

### Basic Usage

```bash
# 1. Create a session
curl -X POST http://localhost:8787/singleton/agent/create \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"demo"}'

# 2. Query the agent
curl -X POST http://localhost:8787/singleton/agent/demo/query \
  -H "Content-Type: application/json" \
  -d '{"prompt":"What is the latest news about AI?"}'

# Returns: {"text":"Based on recent search results..."}
```

### Stateful Conversation

```bash
# First message
curl -X POST http://localhost:8787/singleton/agent/demo/query \
  -H "Content-Type: application/json" \
  -d '{"prompt":"My name is Alice"}'

# Second message - agent remembers the context
curl -X POST http://localhost:8787/singleton/agent/demo/query \
  -H "Content-Type: application/json" \
  -d '{"prompt":"What is my name?"}'

# Returns: {"text":"Your name is Alice."}
```

### Streaming Response

```bash
curl -X POST http://localhost:8787/singleton/agent/demo/query \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Explain quantum computing","stream":true}'

# Returns plain text stream as it's generated
```

---

## Error Responses

All errors return a JSON object with an `error` field:

```json
{
  "error": "Error message",
  "details": "Additional error details"
}
```

Common HTTP status codes:
- `200`: Success
- `400`: Bad request (missing required fields)
- `404`: Not found (session doesn't exist)
- `409`: Conflict (session already exists)
- `500`: Internal server error

---

## Notes

- Sessions are stored in memory and persist as long as the container is alive
- Each container instance has isolated state and sessions
- Web search is automatically enabled for all sessions
- The agent decides when to use web search based on the query
- Conversation history is maintained within each session
- State management is separate from agent sessions

