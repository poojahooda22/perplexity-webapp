# MCP Protocol — Model Context Protocol Fundamentals & Integration

> Consolidated from mcp-developer, mcp-integration. Zero-value-loss.

---

## Source: mcp-developer / SKILL.md


# MCP Developer

Senior MCP (Model Context Protocol) developer with deep expertise in building servers and clients that connect AI systems with external tools and data sources.

## Core Workflow

1. **Analyze requirements** — Identify data sources, tools needed, and client apps
2. **Initialize project** — `npx @modelcontextprotocol/create-server my-server` (TypeScript) or `pip install mcp` + scaffold (Python)
3. **Design protocol** — Define resource URIs, tool schemas (Zod/Pydantic), and prompt templates
4. **Implement** — Register tools and resource handlers; configure transport (stdio/SSE/HTTP)
5. **Test** — Run `npx @modelcontextprotocol/inspector` to verify protocol compliance interactively; confirm tools appear, schemas accept valid inputs, and error responses are well-formed JSON-RPC 2.0. **Feedback loop:** if schema validation fails → inspect Zod/Pydantic error output → fix schema definition → re-run inspector. If a tool call returns a malformed response → check transport serialisation → fix handler → re-test.
6. **Deploy** — Package, add auth/rate-limiting, configure env vars, monitor

## Reference Guide

Load detailed guidance based on context:

| Topic | Reference | Load When |
|-------|-----------|-----------|
| Protocol | `references/protocol.md` | Message types, lifecycle, JSON-RPC 2.0 |
| TypeScript SDK | `references/typescript-sdk.md` | Building servers/clients in Node.js |
| Python SDK | `references/python-sdk.md` | Building servers/clients in Python |
| Tools | `references/tools.md` | Tool definitions, schemas, execution |
| Resources | `references/resources.md` | Resource providers, URIs, templates |

## Minimal Working Example

### TypeScript — Tool with Zod Validation

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "my-server", version: "1.1.0" });

// Register a tool with validated input schema
server.tool(
  "get_weather",
  "Fetch current weather for a location",
  {
    location: z.string().min(1).describe("City name or coordinates"),
    units: z.enum(["celsius", "fahrenheit"]).default("celsius"),
  },
  async ({ location, units }) => {
    // Implementation: call external API, transform response
    const data = await fetchWeather(location, units); // your fetch logic
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
    };
  }
);

// Register a resource provider
server.resource(
  "config://app",
  "Application configuration",
  async (uri) => ({
    contents: [{ uri: uri.href, text: JSON.stringify(getConfig()), mimeType: "application/json" }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Python — Tool with Pydantic Validation

```python
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field

mcp = FastMCP("my-server")

class WeatherInput(BaseModel):
    location: str = Field(..., min_length=1, description="City name or coordinates")
    units: str = Field("celsius", pattern="^(celsius|fahrenheit)$")

@mcp.tool()
async def get_weather(location: str, units: str = "celsius") -> str:
    """Fetch current weather for a location."""
    data = await fetch_weather(location, units)  # your fetch logic
    return str(data)

@mcp.resource("config://app")
async def app_config() -> str:
    """Expose application configuration as a resource."""
    return json.dumps(get_config())

if __name__ == "__main__":
    mcp.run()  # defaults to stdio transport
```

**Expected tool call flow:**
```
Client → { "method": "tools/call", "params": { "name": "get_weather", "arguments": { "location": "Berlin" } } }
Server → { "result": { "content": [{ "type": "text", "text": "{\"temp\": 18, \"units\": \"celsius\"}" }] } }
```

## Constraints

### MUST DO
- Implement JSON-RPC 2.0 protocol correctly
- Validate all inputs with schemas (Zod/Pydantic)
- Use proper transport mechanisms (stdio/HTTP/SSE)
- Implement comprehensive error handling
- Add authentication and authorization
- Log protocol messages for debugging
- Test protocol compliance thoroughly
- Document server capabilities

### MUST NOT DO
- Skip input validation on tool inputs
- Expose sensitive data in resource content
- Ignore protocol version compatibility
- Mix synchronous code with async transports
- Hardcode credentials or secrets
- Return unstructured errors to clients
- Deploy without rate limiting
- Skip security controls

## Output Templates

When implementing MCP features, provide:
1. Server/client implementation file
2. Schema definitions (tools, resources, prompts)
3. Configuration file (transport, auth, etc.)
4. Brief explanation of design decisions

---

## Source: mcp-developer/references / protocol.md

# MCP Protocol Specification

## Protocol Overview

MCP is built on JSON-RPC 2.0 and enables bidirectional communication between clients (like Claude Desktop) and servers that provide resources, tools, and prompts.

## Message Types

### Request/Response

```typescript
// Request format
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}

// Success response
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "get_weather",
        "description": "Get weather for a location",
        "inputSchema": {
          "type": "object",
          "properties": {
            "location": { "type": "string" }
          },
          "required": ["location"]
        }
      }
    ]
  }
}

// Error response
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Invalid params",
    "data": { "details": "location is required" }
  }
}
```

### Notifications

```typescript
// Server sends notification (no response expected)
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": {
    "uri": "file:///project/data.json"
  }
}
```

## Connection Lifecycle

```
1. Client initiates connection (stdio/HTTP/SSE)
2. Client sends initialize request
   → Server responds with capabilities
3. Client sends initialized notification
4. Normal operation (requests/notifications)
5. Client/server can ping for keepalive
6. Client sends shutdown request
7. Connection closes
```

### Initialize Handshake

```typescript
// Client initialize request
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "roots": { "listChanged": true },
      "sampling": {}
    },
    "clientInfo": {
      "name": "claude-desktop",
      "version": "1.0.0"
    }
  }
}

// Server response
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "resources": { "subscribe": true, "listChanged": true },
      "tools": { "listChanged": true },
      "prompts": { "listChanged": true }
    },
    "serverInfo": {
      "name": "my-mcp-server",
      "version": "1.0.0"
    }
  }
}

// Client sends initialized notification
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

## Core Methods

### Resources

```typescript
// List available resources
resources/list → { resources: Resource[] }

// Read resource content
resources/read { uri: string } → { contents: ResourceContent[] }

// Subscribe to resource updates (if supported)
resources/subscribe { uri: string } → {}

// Unsubscribe
resources/unsubscribe { uri: string } → {}

// Server notifies of changes
notifications/resources/list_changed → {}
notifications/resources/updated { uri: string } → {}
```

### Tools

```typescript
// List available tools
tools/list → { tools: Tool[] }

// Execute tool
tools/call {
  name: string,
  arguments: object
} → { content: ToolResponse[] }

// Server notifies of tool changes
notifications/tools/list_changed → {}
```

### Prompts

```typescript
// List available prompts
prompts/list → { prompts: Prompt[] }

// Get prompt with arguments
prompts/get {
  name: string,
  arguments?: object
} → { messages: PromptMessage[] }

// Server notifies of prompt changes
notifications/prompts/list_changed → {}
```

## Error Codes

Standard JSON-RPC 2.0 codes plus MCP-specific:

```typescript
const ERROR_CODES = {
  // JSON-RPC 2.0 standard
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // MCP-specific (implementation defined)
  RESOURCE_NOT_FOUND: -32001,
  TOOL_EXECUTION_ERROR: -32002,
  UNAUTHORIZED: -32003,
  RATE_LIMIT_EXCEEDED: -32004
};
```

## Transport Mechanisms

### stdio (Standard Input/Output)

```typescript
// Server reads from stdin, writes to stdout
// Each message is newline-delimited JSON
// Used for local integration (Claude Desktop default)
```

### HTTP with SSE (Server-Sent Events)

```typescript
// Client POSTs JSON-RPC requests to endpoint
// Server streams responses and notifications via SSE
// Used for remote servers

POST /mcp HTTP/1.1
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list"}

// SSE response
GET /mcp/sse HTTP/1.1

event: message
data: {"jsonrpc":"2.0","id":1,"result":{...}}
```

## Protocol Versions

Current version: `2024-11-05`

Servers must declare supported version in initialize response. Clients should verify compatibility.

## Best Practices

1. **Validation**: Always validate params with JSON Schema
2. **Error handling**: Return structured errors with helpful messages
3. **Versioning**: Check protocol version in initialize
4. **Timeouts**: Implement request timeouts (30s recommended)
5. **Logging**: Log all protocol messages for debugging
6. **Stateless**: Design tools/resources to be stateless
7. **Idempotency**: Make tool calls idempotent when possible
8. **Notifications**: Use notifications for real-time updates

---

## Source: mcp-developer/references / python-sdk.md

# Python SDK Implementation

## Installation

```bash
pip install mcp pydantic
```

## Basic Server Setup

```python
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    Tool,
    TextContent,
    CallToolRequest,
    ListToolsRequest,
)
from pydantic import BaseModel, Field
import asyncio

# Create server instance
app = Server("example-server")

# Define tool input schema
class WeatherArgs(BaseModel):
    location: str = Field(..., description="City name or zip code")
    units: str = Field(default="celsius", pattern="^(celsius|fahrenheit)$")

# List available tools
@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="get_weather",
            description="Get current weather for a location",
            inputSchema=WeatherArgs.model_json_schema(),
        )
    ]

# Handle tool execution
@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "get_weather":
        # Validate arguments
        args = WeatherArgs(**arguments)

        # Execute tool logic
        weather_data = await fetch_weather(args.location, args.units)

        return [
            TextContent(
                type="text",
                text=f"Weather in {args.location}: {weather_data['temp']}°{
                    'C' if args.units == 'celsius' else 'F'
                }",
            )
        ]

    raise ValueError(f"Unknown tool: {name}")

# Run server
async def main():
    async with stdio_server() as (read_stream, write_stream):
        await app.run(
            read_stream,
            write_stream,
            app.create_initialization_options(),
        )

if __name__ == "__main__":
    asyncio.run(main())
```

## Resource Provider

```python
from mcp.types import (
    Resource,
    ResourceTemplate,
    TextResourceContents,
    ListResourcesRequest,
    ReadResourceRequest,
)
import json

@app.list_resources()
async def list_resources() -> list[Resource]:
    return [
        Resource(
            uri="file:///config/settings.json",
            name="Application Settings",
            description="Current application configuration",
            mimeType="application/json",
        ),
        Resource(
            uri="db://users/schema",
            name="User Schema",
            description="Database schema for users table",
            mimeType="text/plain",
        ),
    ]

@app.read_resource()
async def read_resource(uri: str) -> str:
    if uri == "file:///config/settings.json":
        settings = await load_settings()
        return json.dumps(settings, indent=2)

    if uri.startswith("db://users/"):
        schema = await get_database_schema("users")
        return schema

    raise ValueError(f"Resource not found: {uri}")
```

## Resource Templates (Dynamic URIs)

```python
@app.list_resource_templates()
async def list_resource_templates() -> list[ResourceTemplate]:
    return [
        ResourceTemplate(
            uriTemplate="user://{user_id}/profile",
            name="User Profile",
            description="Get user profile by ID",
            mimeType="application/json",
        )
    ]

@app.read_resource()
async def read_resource(uri: str) -> str:
    # Parse template URI
    if uri.startswith("user://"):
        user_id = uri.split("/")[2]
        profile = await get_user_profile(user_id)
        return json.dumps(profile, indent=2)

    raise ValueError(f"Unknown resource: {uri}")
```

## Prompt Templates

```python
from mcp.types import (
    Prompt,
    PromptArgument,
    PromptMessage,
    GetPromptRequest,
)

@app.list_prompts()
async def list_prompts() -> list[Prompt]:
    return [
        Prompt(
            name="code_review",
            description="Generate code review comments",
            arguments=[
                PromptArgument(
                    name="language",
                    description="Programming language",
                    required=True,
                ),
                PromptArgument(
                    name="code",
                    description="Code to review",
                    required=True,
                ),
            ],
        )
    ]

@app.get_prompt()
async def get_prompt(name: str, arguments: dict) -> list[PromptMessage]:
    if name == "code_review":
        language = arguments["language"]
        code = arguments["code"]

        return [
            PromptMessage(
                role="user",
                content=TextContent(
                    type="text",
                    text=f"Review this {language} code and provide feedback:\n\n{code}",
                ),
            )
        ]

    raise ValueError(f"Unknown prompt: {name}")
```

## Input Validation with Pydantic

```python
from pydantic import BaseModel, Field, field_validator
from typing import Literal

class WeatherArgs(BaseModel):
    location: str = Field(..., min_length=1, description="City name")
    units: Literal["celsius", "fahrenheit"] = Field(default="celsius")

    @field_validator("location")
    @classmethod
    def validate_location(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Location cannot be empty")
        return v.strip()

class DatabaseQueryArgs(BaseModel):
    table: str = Field(..., pattern="^[a-zA-Z_][a-zA-Z0-9_]*$")
    limit: int = Field(default=100, ge=1, le=1000)
    offset: int = Field(default=0, ge=0)

@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "query_database":
        # Pydantic validation happens here
        args = DatabaseQueryArgs(**arguments)

        results = await execute_query(args.table, args.limit, args.offset)
        return [TextContent(type="text", text=json.dumps(results))]

    raise ValueError(f"Unknown tool: {name}")
```

## Error Handling

```python
from mcp.types import McpError, INTERNAL_ERROR, INVALID_PARAMS

@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        if name == "get_weather":
            args = WeatherArgs(**arguments)
            result = await fetch_weather(args.location, args.units)
            return [TextContent(type="text", text=str(result))]

        raise ValueError(f"Unknown tool: {name}")

    except ValueError as e:
        # Validation or tool not found
        raise McpError(INVALID_PARAMS, str(e))

    except Exception as e:
        # Unexpected errors
        raise McpError(INTERNAL_ERROR, f"Tool execution failed: {e}")
```

## Logging

```python
import logging
import sys

# Configure logging to stderr (stdout is used for protocol)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    stream=sys.stderr,
)

logger = logging.getLogger("mcp-server")

@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    logger.info(f"Tool called: {name} with args: {arguments}")

    try:
        result = await execute_tool(name, arguments)
        logger.info(f"Tool {name} completed successfully")
        return result
    except Exception as e:
        logger.error(f"Tool {name} failed: {e}", exc_info=True)
        raise
```

## Context Managers and Cleanup

```python
from contextlib import asynccontextmanager

@asynccontextmanager
async def database_connection():
    """Manage database connection lifecycle"""
    db = await connect_to_database()
    try:
        yield db
    finally:
        await db.close()

@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "query_database":
        async with database_connection() as db:
            result = await db.execute(arguments["query"])
            return [TextContent(type="text", text=str(result))]

    raise ValueError(f"Unknown tool: {name}")
```

## Basic Client Setup

```python
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def run_client():
    server_params = StdioServerParameters(
        command="python",
        args=["server.py"],
    )

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            # Initialize connection
            await session.initialize()

            # List available tools
            tools = await session.list_tools()
            print(f"Available tools: {[t.name for t in tools.tools]}")

            # Call a tool
            result = await session.call_tool(
                "get_weather",
                arguments={"location": "San Francisco"},
            )
            print(f"Result: {result.content}")

if __name__ == "__main__":
    asyncio.run(run_client())
```

## Notifications

```python
from mcp.types import ResourceUpdatedNotification

@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "update_config":
        # Update configuration
        await save_config(arguments["config"])

        # Notify clients of resource update
        await app.request_context.session.send_resource_updated(
            uri="file:///config/settings.json"
        )

        return [TextContent(type="text", text="Configuration updated")]

    raise ValueError(f"Unknown tool: {name}")
```

## Best Practices

1. **Type Safety**: Use Pydantic for all schemas
2. **Async/Await**: All handlers must be async
3. **Validation**: Validate inputs early with Pydantic
4. **Logging**: Log to stderr, never stdout
5. **Error Handling**: Wrap errors in McpError
6. **Resource Cleanup**: Use context managers
7. **Testing**: Use pytest-asyncio for async tests
8. **Performance**: Cache expensive operations
9. **Security**: Sanitize all inputs and outputs
10. **Documentation**: Include docstrings and type hints

---

## Source: mcp-developer/references / resources.md

# MCP Resources Reference

## Resource Basics

Resources represent data or content that can be read by AI assistants. They use URI schemes to identify content.

```typescript
{
  "uri": "file:///path/to/resource",
  "name": "Human-readable name",
  "description": "What this resource contains",
  "mimeType": "application/json"
}
```

## Common URI Schemes

### File URIs

```typescript
{
  "uri": "file:///config/settings.json",
  "name": "Application Settings",
  "mimeType": "application/json"
}

{
  "uri": "file:///docs/README.md",
  "name": "README Documentation",
  "mimeType": "text/markdown"
}
```

### Custom Schemes

```typescript
// Database resources
{
  "uri": "db://users/schema",
  "name": "Users Table Schema",
  "mimeType": "text/plain"
}

// API resources
{
  "uri": "api://v1/status",
  "name": "API Status",
  "mimeType": "application/json"
}

// Git resources
{
  "uri": "git://main/commits",
  "name": "Recent Commits",
  "mimeType": "text/plain"
}
```

## Resource Templates

Templates allow dynamic URIs with parameters.

```typescript
// TypeScript
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return {
    resourceTemplates: [
      {
        uriTemplate: "user://{user_id}/profile",
        name: "User Profile",
        description: "Get user profile by ID",
        mimeType: "application/json",
      },
      {
        uriTemplate: "repo://{owner}/{repo}/issues",
        name: "GitHub Issues",
        description: "List issues for a repository",
        mimeType: "application/json",
      },
    ],
  };
});

// Handle templated URIs in read_resource
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  // Parse user profile URI
  const userMatch = uri.match(/^user:\/\/([^/]+)\/profile$/);
  if (userMatch) {
    const userId = userMatch[1];
    const profile = await getUserProfile(userId);
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(profile, null, 2),
        },
      ],
    };
  }

  // Parse GitHub issues URI
  const repoMatch = uri.match(/^repo:\/\/([^/]+)\/([^/]+)\/issues$/);
  if (repoMatch) {
    const [, owner, repo] = repoMatch;
    const issues = await fetchGitHubIssues(owner, repo);
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(issues, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});
```

```python
# Python
@app.list_resource_templates()
async def list_resource_templates() -> list[ResourceTemplate]:
    return [
        ResourceTemplate(
            uriTemplate="user://{user_id}/profile",
            name="User Profile",
            description="Get user profile by ID",
            mimeType="application/json",
        )
    ]

@app.read_resource()
async def read_resource(uri: str) -> str:
    # Parse template URI
    import re

    match = re.match(r'^user://([^/]+)/profile$', uri)
    if match:
        user_id = match.group(1)
        profile = await get_user_profile(user_id)
        return json.dumps(profile, indent=2)

    raise ValueError(f"Unknown resource: {uri}")
```

## Content Types

### Text Content

```typescript
{
  "uri": "file:///data.txt",
  "mimeType": "text/plain",
  "text": "The content of the file"
}
```

### JSON Content

```typescript
{
  "uri": "api://status",
  "mimeType": "application/json",
  "text": JSON.stringify({
    "status": "ok",
    "uptime": 12345
  }, null, 2)
}
```

### Binary Content (Base64)

```typescript
{
  "uri": "file:///image.png",
  "mimeType": "image/png",
  "blob": "base64-encoded-data-here"
}
```

### Markdown Content

```typescript
{
  "uri": "docs://api-reference",
  "mimeType": "text/markdown",
  "text": "# API Reference\n\n## Endpoints\n..."
}
```

## Implementation Patterns

### File System Resources

```typescript
import * as fs from "fs/promises";
import * as path from "path";

const ALLOWED_DIR = "/path/to/allowed/directory";

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const files = await fs.readdir(ALLOWED_DIR);

  return {
    resources: files.map((file) => ({
      uri: `file:///${file}`,
      name: file,
      description: `File: ${file}`,
      mimeType: getMimeType(file),
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  if (uri.startsWith("file:///")) {
    const filename = uri.slice(8); // Remove "file:///"
    const safePath = path.resolve(ALLOWED_DIR, filename);

    // Security: ensure path is within allowed directory
    if (!safePath.startsWith(ALLOWED_DIR)) {
      throw new McpError(ErrorCode.InvalidParams, "Access denied");
    }

    const content = await fs.readFile(safePath, "utf-8");

    return {
      contents: [
        {
          uri,
          mimeType: getMimeType(filename),
          text: content,
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});
```

### Database Resources

```python
@app.list_resources()
async def list_resources() -> list[Resource]:
    tables = await db.get_tables()

    return [
        Resource(
            uri=f"db://{table}/schema",
            name=f"{table} Schema",
            description=f"Schema for {table} table",
            mimeType="text/plain",
        )
        for table in tables
    ]

@app.read_resource()
async def read_resource(uri: str) -> str:
    if uri.startswith("db://"):
        parts = uri[5:].split("/")
        table = parts[0]
        resource_type = parts[1] if len(parts) > 1 else "data"

        if resource_type == "schema":
            schema = await db.get_schema(table)
            return schema

        if resource_type == "data":
            rows = await db.query(f"SELECT * FROM {table} LIMIT 100")
            return json.dumps(rows, indent=2)

    raise ValueError(f"Unknown resource: {uri}")
```

### API Resources

```typescript
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "api://v1/status",
        name: "API Status",
        mimeType: "application/json",
      },
      {
        uri: "api://v1/metrics",
        name: "API Metrics",
        mimeType: "application/json",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  if (uri === "api://v1/status") {
    const status = await checkApiStatus();
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  }

  if (uri === "api://v1/metrics") {
    const metrics = await collectMetrics();
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(metrics, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});
```

### Git Repository Resources

```python
import git

@app.list_resources()
async def list_resources() -> list[Resource]:
    return [
        Resource(
            uri="git://log",
            name="Git Log",
            description="Recent commits",
            mimeType="text/plain",
        ),
        Resource(
            uri="git://status",
            name="Git Status",
            description="Working tree status",
            mimeType="text/plain",
        ),
    ]

@app.read_resource()
async def read_resource(uri: str) -> str:
    repo = git.Repo(".")

    if uri == "git://log":
        log = repo.git.log("--oneline", "-n", "10")
        return log

    if uri == "git://status":
        status = repo.git.status()
        return status

    raise ValueError(f"Unknown resource: {uri}")
```

## Resource Subscriptions

Allow clients to subscribe to resource updates.

```typescript
// Declare subscription capability
const server = new Server(
  { name: "example", version: "1.0.0" },
  {
    capabilities: {
      resources: {
        subscribe: true,
        listChanged: true,
      },
    },
  }
);

// Track subscriptions
const subscriptions = new Set<string>();

server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  subscriptions.add(request.params.uri);
  return {};
});

server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  subscriptions.delete(request.params.uri);
  return {};
});

// Notify subscribers when resource changes
async function notifyResourceUpdate(uri: string) {
  if (subscriptions.has(uri)) {
    await server.notification({
      method: "notifications/resources/updated",
      params: { uri },
    });
  }
}

// Example: file watcher
const watcher = fs.watch(WATCHED_DIR, async (event, filename) => {
  if (event === "change") {
    const uri = `file:///${filename}`;
    await notifyResourceUpdate(uri);
  }
});
```

## Best Practices

### 1. URI Design

```typescript
// Good: Hierarchical and descriptive
"db://users/schema"
"db://users/data"
"api://v1/endpoints/users"
"file:///config/app.json"

// Bad: Flat and ambiguous
"db1"
"data"
"config"
```

### 2. MIME Types

```typescript
function getMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();

  const mimeTypes: Record<string, string> = {
    json: "application/json",
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    xml: "application/xml",
    csv: "text/csv",
    png: "image/png",
    jpg: "image/jpeg",
    pdf: "application/pdf",
  };

  return mimeTypes[ext || ""] || "application/octet-stream";
}
```

### 3. Security

```python
def is_safe_path(base_dir: str, path: str) -> bool:
    """Ensure path doesn't escape base directory"""
    base = os.path.abspath(base_dir)
    target = os.path.abspath(os.path.join(base_dir, path))
    return target.startswith(base)

@app.read_resource()
async def read_resource(uri: str) -> str:
    if uri.startswith("file:///"):
        path = uri[8:]
        if not is_safe_path(ALLOWED_DIR, path):
            raise ValueError("Access denied")

        full_path = os.path.join(ALLOWED_DIR, path)
        with open(full_path) as f:
            return f.read()
```

### 4. Caching

```typescript
const resourceCache = new Map<string, { content: string; timestamp: number }>();
const CACHE_TTL = 60000; // 1 minute

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const now = Date.now();

  // Check cache
  const cached = resourceCache.get(uri);
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return {
      contents: [{ uri, mimeType: "application/json", text: cached.content }],
    };
  }

  // Fetch and cache
  const content = await fetchResource(uri);
  resourceCache.set(uri, { content, timestamp: now });

  return {
    contents: [{ uri, mimeType: "application/json", text: content }],
  };
});
```

### 5. Large Resources

```python
@app.read_resource()
async def read_resource(uri: str) -> str:
    if uri == "db://logs/recent":
        # For large datasets, limit size
        logs = await db.query(
            "SELECT * FROM logs ORDER BY timestamp DESC LIMIT 1000"
        )
        return json.dumps(logs, indent=2)

    if uri == "file:///large.txt":
        # Read first 100KB only
        with open("/path/to/large.txt") as f:
            content = f.read(100 * 1024)
            if f.read(1):  # Check if there's more
                content += "\n\n[Content truncated...]"
            return content
```

### 6. Error Handling

```typescript
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
    const content = await fetchResource(request.params.uri);
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: content,
        },
      ],
    };
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${request.params.uri}`);
    }
    throw new McpError(ErrorCode.InternalError, `Failed to read resource: ${error.message}`);
  }
});
```

---

## Source: mcp-developer/references / tools.md

# MCP Tools Reference

## Tool Definition

Tools are functions that AI assistants can invoke to perform actions or retrieve data.

```typescript
{
  "name": "tool_name",
  "description": "Clear description of what the tool does",
  "inputSchema": {
    "type": "object",
    "properties": {
      "param1": {
        "type": "string",
        "description": "What this parameter is for"
      }
    },
    "required": ["param1"]
  }
}
```

## Input Schema Patterns

### Simple String Parameter

```typescript
{
  "name": "search_docs",
  "description": "Search documentation for a query",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Search query",
        "minLength": 1
      }
    },
    "required": ["query"]
  }
}
```

### Enum Values

```typescript
{
  "name": "get_weather",
  "description": "Get weather information",
  "inputSchema": {
    "type": "object",
    "properties": {
      "location": { "type": "string" },
      "units": {
        "type": "string",
        "enum": ["celsius", "fahrenheit"],
        "default": "celsius",
        "description": "Temperature units"
      }
    },
    "required": ["location"]
  }
}
```

### Nested Objects

```typescript
{
  "name": "create_task",
  "description": "Create a new task",
  "inputSchema": {
    "type": "object",
    "properties": {
      "title": { "type": "string", "minLength": 1 },
      "metadata": {
        "type": "object",
        "properties": {
          "priority": { "type": "string", "enum": ["low", "medium", "high"] },
          "tags": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "required": ["title"]
  }
}
```

### Array Parameters

```typescript
{
  "name": "batch_process",
  "description": "Process multiple items",
  "inputSchema": {
    "type": "object",
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": { "type": "string" },
            "action": { "type": "string", "enum": ["update", "delete"] }
          },
          "required": ["id", "action"]
        },
        "minItems": 1,
        "maxItems": 100
      }
    },
    "required": ["items"]
  }
}
```

### Union Types (anyOf)

```typescript
{
  "name": "search",
  "description": "Search by ID or query",
  "inputSchema": {
    "type": "object",
    "properties": {
      "search": {
        "anyOf": [
          { "type": "string", "description": "Search query" },
          { "type": "number", "description": "Item ID" }
        ]
      }
    },
    "required": ["search"]
  }
}
```

## Tool Response Formats

### Text Response

```typescript
{
  "content": [
    {
      "type": "text",
      "text": "Operation completed successfully"
    }
  ]
}
```

### Multiple Content Blocks

```typescript
{
  "content": [
    {
      "type": "text",
      "text": "Found 3 results:"
    },
    {
      "type": "text",
      "text": "1. First result\n2. Second result\n3. Third result"
    }
  ]
}
```

### Image Content

```typescript
{
  "content": [
    {
      "type": "image",
      "data": "base64-encoded-image-data",
      "mimeType": "image/png"
    }
  ]
}
```

### Resource Reference

```typescript
{
  "content": [
    {
      "type": "resource",
      "resource": {
        "uri": "file:///data/results.json",
        "mimeType": "application/json",
        "text": "{\"results\": [...]}"
      }
    }
  ]
}
```

## Tool Implementation Patterns

### Database Query Tool

```typescript
// TypeScript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "query_database") {
    const { table, filter, limit } = request.params.arguments as {
      table: string;
      filter?: Record<string, any>;
      limit?: number;
    };

    // Validate table name (prevent SQL injection)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid table name");
    }

    const results = await db.query(table, filter, limit || 10);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }
});
```

```python
# Python
@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "query_database":
        args = QueryArgs(**arguments)  # Pydantic validation

        # Validate table name
        if not re.match(r'^[a-zA-Z_][a-zA-Z0-9_]*$', args.table):
            raise ValueError("Invalid table name")

        results = await db.query(args.table, args.filter, args.limit)

        return [
            TextContent(type="text", text=json.dumps(results, indent=2))
        ]
```

### File System Tool

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "read_file") {
    const { path } = request.params.arguments as { path: string };

    // Security: validate path is within allowed directory
    const safePath = resolvePath(ALLOWED_DIR, path);
    if (!safePath.startsWith(ALLOWED_DIR)) {
      throw new McpError(ErrorCode.InvalidParams, "Access denied");
    }

    const content = await fs.readFile(safePath, "utf-8");

    return {
      content: [{ type: "text", text: content }],
    };
  }
});
```

### HTTP API Tool

```python
@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "fetch_api":
        args = FetchArgs(**arguments)

        async with httpx.AsyncClient() as client:
            try:
                response = await client.get(
                    args.url,
                    timeout=30.0,
                    headers={"User-Agent": "MCP Server"}
                )
                response.raise_for_status()

                return [
                    TextContent(
                        type="text",
                        text=response.text
                    )
                ]
            except httpx.HTTPError as e:
                raise McpError(INTERNAL_ERROR, f"HTTP request failed: {e}")
```

### Async Background Task

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "start_job") {
    const { jobType, params } = request.params.arguments as {
      jobType: string;
      params: Record<string, any>;
    };

    // Start job asynchronously
    const jobId = await jobQueue.enqueue(jobType, params);

    return {
      content: [
        {
          type: "text",
          text: `Job started with ID: ${jobId}`,
        },
      ],
    };
  }

  if (request.params.name === "check_job") {
    const { jobId } = request.params.arguments as { jobId: string };

    const status = await jobQueue.getStatus(jobId);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  }
});
```

## Best Practices

### 1. Descriptive Names and Descriptions

```typescript
// Good
{
  "name": "search_knowledge_base",
  "description": "Search the knowledge base using semantic search. Returns top 5 relevant documents with excerpts.",
  "inputSchema": { ... }
}

// Bad
{
  "name": "search",
  "description": "Search",
  "inputSchema": { ... }
}
```

### 2. Input Validation

```python
class SearchArgs(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)
    max_results: int = Field(default=5, ge=1, le=50)
    filters: dict[str, str] = Field(default_factory=dict)

    @field_validator("query")
    @classmethod
    def validate_query(cls, v: str) -> str:
        # Sanitize query
        return v.strip()
```

### 3. Error Handling

```typescript
try {
  const result = await executeOperation(params);
  return { content: [{ type: "text", text: result }] };
} catch (error) {
  if (error instanceof ValidationError) {
    throw new McpError(ErrorCode.InvalidParams, error.message);
  }
  if (error instanceof NotFoundError) {
    return {
      content: [{ type: "text", text: "Resource not found" }],
      isError: true,
    };
  }
  throw new McpError(ErrorCode.InternalError, `Operation failed: ${error.message}`);
}
```

### 4. Rate Limiting

```python
from asyncio import Lock
from datetime import datetime, timedelta

rate_limiter = {}
rate_limit_lock = Lock()

async def check_rate_limit(tool_name: str, limit: int = 10) -> None:
    async with rate_limit_lock:
        now = datetime.now()
        if tool_name not in rate_limiter:
            rate_limiter[tool_name] = []

        # Remove old entries
        rate_limiter[tool_name] = [
            t for t in rate_limiter[tool_name]
            if now - t < timedelta(minutes=1)
        ]

        if len(rate_limiter[tool_name]) >= limit:
            raise McpError(-32004, "Rate limit exceeded")

        rate_limiter[tool_name].append(now)
```

### 5. Idempotency

```typescript
// For operations that should be idempotent, use unique IDs
{
  "name": "create_record",
  "inputSchema": {
    "type": "object",
    "properties": {
      "idempotency_key": {
        "type": "string",
        "description": "Unique key to prevent duplicate operations"
      },
      "data": { "type": "object" }
    },
    "required": ["idempotency_key", "data"]
  }
}
```

### 6. Timeouts

```python
import asyncio

@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "long_operation":
        try:
            result = await asyncio.wait_for(
                execute_operation(arguments),
                timeout=30.0  # 30 second timeout
            )
            return [TextContent(type="text", text=str(result))]
        except asyncio.TimeoutError:
            raise McpError(INTERNAL_ERROR, "Operation timed out")
```

### 7. Logging

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const startTime = Date.now();
  console.error(`[${new Date().toISOString()}] Tool call: ${request.params.name}`);

  try {
    const result = await executeTool(request.params.name, request.params.arguments);
    const duration = Date.now() - startTime;
    console.error(`[${new Date().toISOString()}] Tool completed in ${duration}ms`);
    return result;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Tool failed:`, error);
    throw error;
  }
});
```

---

## Source: mcp-developer/references / typescript-sdk.md

# TypeScript SDK Implementation

## Installation

```bash
npm install @modelcontextprotocol/sdk zod
```

## Basic Server Setup

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Create server instance
const server = new Server(
  {
    name: "example-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
      prompts: {},
    },
  }
);

// Handle tools/list request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_weather",
        description: "Get current weather for a location",
        inputSchema: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description: "City name or zip code",
            },
            units: {
              type: "string",
              enum: ["celsius", "fahrenheit"],
              default: "celsius",
            },
          },
          required: ["location"],
        },
      },
    ],
  };
});

// Handle tools/call request
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "get_weather") {
    const location = String(request.params.arguments?.location);
    const units = String(request.params.arguments?.units ?? "celsius");

    // Your tool logic here
    const weatherData = await fetchWeather(location, units);

    return {
      content: [
        {
          type: "text",
          text: `Weather in ${location}: ${weatherData.temp}°${units === "celsius" ? "C" : "F"}`,
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

// Start server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Server running on stdio");
}

main().catch(console.error);
```

## Resource Provider

```typescript
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// List resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "file:///config/settings.json",
        name: "Application Settings",
        description: "Current application configuration",
        mimeType: "application/json",
      },
      {
        uri: "db://users/schema",
        name: "User Schema",
        description: "Database schema for users table",
        mimeType: "text/plain",
      },
    ],
  };
});

// Read resource content
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;

  if (uri === "file:///config/settings.json") {
    const settings = await loadSettings();
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(settings, null, 2),
        },
      ],
    };
  }

  if (uri.startsWith("db://users/")) {
    const schema = await getDatabaseSchema("users");
    return {
      contents: [
        {
          uri,
          mimeType: "text/plain",
          text: schema,
        },
      ],
    };
  }

  throw new Error(`Resource not found: ${uri}`);
});
```

## Prompt Templates

```typescript
import {
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "code_review",
        description: "Generate code review comments",
        arguments: [
          {
            name: "language",
            description: "Programming language",
            required: true,
          },
          {
            name: "code",
            description: "Code to review",
            required: true,
          },
        ],
      },
    ],
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name === "code_review") {
    const language = String(request.params.arguments?.language);
    const code = String(request.params.arguments?.code);

    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Review this ${language} code and provide feedback:\n\n${code}`,
          },
        },
      ],
    };
  }

  throw new Error(`Unknown prompt: ${request.params.name}`);
});
```

## Input Validation with Zod

```typescript
import { z } from "zod";

// Define schemas for validation
const WeatherArgsSchema = z.object({
  location: z.string().min(1),
  units: z.enum(["celsius", "fahrenheit"]).default("celsius"),
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "get_weather") {
    // Validate and parse arguments
    const args = WeatherArgsSchema.parse(request.params.arguments);

    const weatherData = await fetchWeather(args.location, args.units);

    return {
      content: [
        {
          type: "text",
          text: `Temperature: ${weatherData.temp}°${args.units === "celsius" ? "C" : "F"}`,
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});
```

## Error Handling

```typescript
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    // Validate input
    if (!request.params.arguments?.location) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "location parameter is required"
      );
    }

    const result = await executeTool(request.params.name, request.params.arguments);
    return { content: [{ type: "text", text: result }] };

  } catch (error) {
    if (error instanceof McpError) {
      throw error; // Re-throw MCP errors
    }

    // Wrap other errors
    throw new McpError(
      ErrorCode.InternalError,
      `Tool execution failed: ${error.message}`
    );
  }
});
```

## Basic Client Setup

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client(
  {
    name: "example-client",
    version: "1.0.0",
  },
  {
    capabilities: {},
  }
);

// Connect to server
const transport = new StdioClientTransport({
  command: "node",
  args: ["./server.js"],
});

await client.connect(transport);

// List available tools
const toolsResponse = await client.request(
  { method: "tools/list" },
  ListToolsResultSchema
);

console.log("Available tools:", toolsResponse.tools);

// Call a tool
const result = await client.request(
  {
    method: "tools/call",
    params: {
      name: "get_weather",
      arguments: { location: "San Francisco" },
    },
  },
  CallToolResultSchema
);

console.log("Result:", result.content);
```

## Notifications

```typescript
// Server sends notification
server.notification({
  method: "notifications/resources/updated",
  params: {
    uri: "file:///config/settings.json",
  },
});

// Client handles notifications
client.setNotificationHandler((notification) => {
  if (notification.method === "notifications/resources/updated") {
    console.log("Resource updated:", notification.params.uri);
  }
});
```

## Best Practices

1. **Type Safety**: Use Zod for runtime validation
2. **Error Handling**: Always wrap errors in McpError
3. **Async/Await**: Use async/await throughout
4. **Logging**: Log to stderr, not stdout (stdio transport)
5. **Cleanup**: Handle graceful shutdown
6. **Testing**: Use unit tests with mock transports
7. **Performance**: Cache expensive operations
8. **Security**: Validate all inputs, sanitize outputs

---

## Source: mcp-integration / SKILL.md


# MCP Integration for Claude Code Plugins

## Overview

Model Context Protocol (MCP) enables Claude Code plugins to integrate with external services and APIs by providing structured tool access. Use MCP integration to expose external service capabilities as tools within Claude Code.

**Key capabilities:**
- Connect to external services (databases, APIs, file systems)
- Provide 10+ related tools from a single service
- Handle OAuth and complex authentication flows
- Bundle MCP servers with plugins for automatic setup

## MCP Server Configuration Methods

Plugins can bundle MCP servers in two ways:

### Method 1: Dedicated .mcp.json (Recommended)

Create `.mcp.json` at plugin root:

```json
{
  "database-tools": {
    "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
    "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
    "env": {
      "DB_URL": "${DB_URL}"
    }
  }
}
```

**Benefits:**
- Clear separation of concerns
- Easier to maintain
- Better for multiple servers

### Method 2: Inline in plugin.json

Add `mcpServers` field to plugin.json:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "mcpServers": {
    "plugin-api": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/api-server",
      "args": ["--port", "8080"]
    }
  }
}
```

**Benefits:**
- Single configuration file
- Good for simple single-server plugins

## MCP Server Types

### stdio (Local Process)

Execute local MCP servers as child processes. Best for local tools and custom servers.

**Configuration:**
```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"],
    "env": {
      "LOG_LEVEL": "debug"
    }
  }
}
```

**Use cases:**
- File system access
- Local database connections
- Custom MCP servers
- NPM-packaged MCP servers

**Process management:**
- Claude Code spawns and manages the process
- Communicates via stdin/stdout
- Terminates when Claude Code exits

### SSE (Server-Sent Events)

Connect to hosted MCP servers with OAuth support. Best for cloud services.

**Configuration:**
```json
{
  "asana": {
    "type": "sse",
    "url": "https://mcp.asana.com/sse"
  }
}
```

**Use cases:**
- Official hosted MCP servers (Asana, GitHub, etc.)
- Cloud services with MCP endpoints
- OAuth-based authentication
- No local installation needed

**Authentication:**
- OAuth flows handled automatically
- User prompted on first use
- Tokens managed by Claude Code

### HTTP (REST API)

Connect to RESTful MCP servers with token authentication.

**Configuration:**
```json
{
  "api-service": {
    "type": "http",
    "url": "https://api.example.com/mcp",
    "headers": {
      "Authorization": "Bearer ${API_TOKEN}",
      "X-Custom-Header": "value"
    }
  }
}
```

**Use cases:**
- REST API-based MCP servers
- Token-based authentication
- Custom API backends
- Stateless interactions

### WebSocket (Real-time)

Connect to WebSocket MCP servers for real-time bidirectional communication.

**Configuration:**
```json
{
  "realtime-service": {
    "type": "ws",
    "url": "wss://mcp.example.com/ws",
    "headers": {
      "Authorization": "Bearer ${TOKEN}"
    }
  }
}
```

**Use cases:**
- Real-time data streaming
- Persistent connections
- Push notifications from server
- Low-latency requirements

## Environment Variable Expansion

All MCP configurations support environment variable substitution:

**${CLAUDE_PLUGIN_ROOT}** - Plugin directory (always use for portability):
```json
{
  "command": "${CLAUDE_PLUGIN_ROOT}/servers/my-server"
}
```

**User environment variables** - From user's shell:
```json
{
  "env": {
    "API_KEY": "${MY_API_KEY}",
    "DATABASE_URL": "${DB_URL}"
  }
}
```

**Best practice:** Document all required environment variables in plugin README.

## MCP Tool Naming

When MCP servers provide tools, they're automatically prefixed:

**Format:** `mcp__plugin_<plugin-name>_<server-name>__<tool-name>`

**Example:**
- Plugin: `asana`
- Server: `asana`
- Tool: `create_task`
- **Full name:** `mcp__plugin_asana_asana__asana_create_task`

### Using MCP Tools in Commands

Pre-allow specific MCP tools in command frontmatter:

```markdown
```

**Wildcard (use sparingly):**
```markdown
```

**Best practice:** Pre-allow specific tools, not wildcards, for security.

## Lifecycle Management

**Automatic startup:**
- MCP servers start when plugin enables
- Connection established before first tool use
- Restart required for configuration changes

**Lifecycle:**
1. Plugin loads
2. MCP configuration parsed
3. Server process started (stdio) or connection established (SSE/HTTP/WS)
4. Tools discovered and registered
5. Tools available as `mcp__plugin_...__...`

**Viewing servers:**
Use `/mcp` command to see all servers including plugin-provided ones.

## Authentication Patterns

### OAuth (SSE/HTTP)

OAuth handled automatically by Claude Code:

```json
{
  "type": "sse",
  "url": "https://mcp.example.com/sse"
}
```

User authenticates in browser on first use. No additional configuration needed.

### Token-Based (Headers)

Static or environment variable tokens:

```json
{
  "type": "http",
  "url": "https://api.example.com",
  "headers": {
    "Authorization": "Bearer ${API_TOKEN}"
  }
}
```

Document required environment variables in README.

### Environment Variables (stdio)

Pass configuration to MCP server:

```json
{
  "command": "python",
  "args": ["-m", "my_mcp_server"],
  "env": {
    "DATABASE_URL": "${DB_URL}",
    "API_KEY": "${API_KEY}",
    "LOG_LEVEL": "info"
  }
}
```

## Integration Patterns

### Pattern 1: Simple Tool Wrapper

Commands use MCP tools with user interaction:

```markdown
# Command: create-item.md

Steps:
1. Gather item details from user
2. Use mcp__plugin_name_server__create_item
3. Confirm creation
```

**Use for:** Adding validation or preprocessing before MCP calls.

### Pattern 2: Autonomous Agent

Agents use MCP tools autonomously:

```markdown
# Agent: data-analyzer.md

Analysis Process:
1. Query data via mcp__plugin_db_server__query
2. Process and analyze results
3. Generate insights report
```

**Use for:** Multi-step MCP workflows without user interaction.

### Pattern 3: Multi-Server Plugin

Integrate multiple MCP servers:

```json
{
  "github": {
    "type": "sse",
    "url": "https://mcp.github.com/sse"
  },
  "jira": {
    "type": "sse",
    "url": "https://mcp.jira.com/sse"
  }
}
```

**Use for:** Workflows spanning multiple services.

## Security Best Practices

### Use HTTPS/WSS

Always use secure connections:

```json
✅ "url": "https://mcp.example.com/sse"
❌ "url": "http://mcp.example.com/sse"
```

### Token Management

**DO:**
- ✅ Use environment variables for tokens
- ✅ Document required env vars in README
- ✅ Let OAuth flow handle authentication

**DON'T:**
- ❌ Hardcode tokens in configuration
- ❌ Commit tokens to git
- ❌ Share tokens in documentation

### Permission Scoping

Pre-allow only necessary MCP tools:

```markdown
✅ allowed-tools: [
  "mcp__plugin_api_server__read_data",
  "mcp__plugin_api_server__create_item"
]

❌ allowed-tools: ["mcp__plugin_api_server__*"]
```

## Error Handling

### Connection Failures

Handle MCP server unavailability:
- Provide fallback behavior in commands
- Inform user of connection issues
- Check server URL and configuration

### Tool Call Errors

Handle failed MCP operations:
- Validate inputs before calling MCP tools
- Provide clear error messages
- Check rate limiting and quotas

### Configuration Errors

Validate MCP configuration:
- Test server connectivity during development
- Validate JSON syntax
- Check required environment variables

## Performance Considerations

### Lazy Loading

MCP servers connect on-demand:
- Not all servers connect at startup
- First tool use triggers connection
- Connection pooling managed automatically

### Batching

Batch similar requests when possible:

```
# Good: Single query with filters
tasks = search_tasks(project="X", assignee="me", limit=50)

# Avoid: Many individual queries
for id in task_ids:
    task = get_task(id)
```

## Testing MCP Integration

### Local Testing

1. Configure MCP server in `.mcp.json`
2. Install plugin locally (`.claude-plugin/`)
3. Run `/mcp` to verify server appears
4. Test tool calls in commands
5. Check `claude --debug` logs for connection issues

### Validation Checklist

- [ ] MCP configuration is valid JSON
- [ ] Server URL is correct and accessible
- [ ] Required environment variables documented
- [ ] Tools appear in `/mcp` output
- [ ] Authentication works (OAuth or tokens)
- [ ] Tool calls succeed from commands
- [ ] Error cases handled gracefully

## Debugging

### Enable Debug Logging

```bash
claude --debug
```

Look for:
- MCP server connection attempts
- Tool discovery logs
- Authentication flows
- Tool call errors

### Common Issues

**Server not connecting:**
- Check URL is correct
- Verify server is running (stdio)
- Check network connectivity
- Review authentication configuration

**Tools not available:**
- Verify server connected successfully
- Check tool names match exactly
- Run `/mcp` to see available tools
- Restart Claude Code after config changes

**Authentication failing:**
- Clear cached auth tokens
- Re-authenticate
- Check token scopes and permissions
- Verify environment variables set

## Quick Reference

### MCP Server Types

| Type | Transport | Best For | Auth |
|------|-----------|----------|------|
| stdio | Process | Local tools, custom servers | Env vars |
| SSE | HTTP | Hosted services, cloud APIs | OAuth |
| HTTP | REST | API backends, token auth | Tokens |
| ws | WebSocket | Real-time, streaming | Tokens |

### Configuration Checklist

- [ ] Server type specified (stdio/SSE/HTTP/ws)
- [ ] Type-specific fields complete (command or url)
- [ ] Authentication configured
- [ ] Environment variables documented
- [ ] HTTPS/WSS used (not HTTP/WS)
- [ ] ${CLAUDE_PLUGIN_ROOT} used for paths

### Best Practices

**DO:**
- ✅ Use ${CLAUDE_PLUGIN_ROOT} for portable paths
- ✅ Document required environment variables
- ✅ Use secure connections (HTTPS/WSS)
- ✅ Pre-allow specific MCP tools in commands
- ✅ Test MCP integration before publishing
- ✅ Handle connection and tool errors gracefully

**DON'T:**
- ❌ Hardcode absolute paths
- ❌ Commit credentials to git
- ❌ Use HTTP instead of HTTPS
- ❌ Pre-allow all tools with wildcards
- ❌ Skip error handling
- ❌ Forget to document setup

## Additional Resources

### Reference Files

For detailed information, consult:

- **`references/server-types.md`** - Deep dive on each server type
- **`references/authentication.md`** - Authentication patterns and OAuth
- **`references/tool-usage.md`** - Using MCP tools in commands and agents

### Example Configurations

Working examples in `examples/`:

- **`stdio-server.json`** - Local stdio MCP server
- **`sse-server.json`** - Hosted SSE server with OAuth
- **`http-server.json`** - REST API with token auth

### External Resources

- **Official MCP Docs**: https://modelcontextprotocol.io/
- **Claude Code MCP Docs**: https://docs.claude.com/en/docs/claude-code/mcp
- **MCP SDK**: @modelcontextprotocol/sdk
- **Testing**: Use `claude --debug` and `/mcp` command

## Implementation Workflow

To add MCP integration to a plugin:

1. Choose MCP server type (stdio, SSE, HTTP, ws)
2. Create `.mcp.json` at plugin root with configuration
3. Use ${CLAUDE_PLUGIN_ROOT} for all file references
4. Document required environment variables in README
5. Test locally with `/mcp` command
6. Pre-allow MCP tools in relevant commands
7. Handle authentication (OAuth or tokens)
8. Test error cases (connection failures, auth errors)
9. Document MCP integration in plugin README

Focus on stdio for custom/local servers, SSE for hosted services with OAuth.

---

## Source: mcp-integration/references / authentication.md

# MCP Authentication Patterns

Complete guide to authentication methods for MCP servers in Claude Code plugins.

## Overview

MCP servers support multiple authentication methods depending on the server type and service requirements. Choose the method that best matches your use case and security requirements.

## OAuth (Automatic)

### How It Works

Claude Code automatically handles the complete OAuth 2.0 flow for SSE and HTTP servers:

1. User attempts to use MCP tool
2. Claude Code detects authentication needed
3. Opens browser for OAuth consent
4. User authorizes in browser
5. Tokens stored securely by Claude Code
6. Automatic token refresh

### Configuration

```json
{
  "service": {
    "type": "sse",
    "url": "https://mcp.example.com/sse"
  }
}
```

No additional auth configuration needed! Claude Code handles everything.

### Supported Services

**Known OAuth-enabled MCP servers:**
- Asana: `https://mcp.asana.com/sse`
- GitHub (when available)
- Google services (when available)
- Custom OAuth servers

### OAuth Scopes

OAuth scopes are determined by the MCP server. Users see required scopes during the consent flow.

**Document required scopes in your README:**
```markdown
## Authentication

This plugin requires the following Asana permissions:
- Read tasks and projects
- Create and update tasks
- Access workspace data
```

### Token Storage

Tokens are stored securely by Claude Code:
- Not accessible to plugins
- Encrypted at rest
- Automatic refresh
- Cleared on sign-out

### Troubleshooting OAuth

**Authentication loop:**
- Clear cached tokens (sign out and sign in)
- Check OAuth redirect URLs
- Verify server OAuth configuration

**Scope issues:**
- User may need to re-authorize for new scopes
- Check server documentation for required scopes

**Token expiration:**
- Claude Code auto-refreshes
- If refresh fails, prompts re-authentication

## Token-Based Authentication

### Bearer Tokens

Most common for HTTP and WebSocket servers.

**Configuration:**
```json
{
  "api": {
    "type": "http",
    "url": "https://api.example.com/mcp",
    "headers": {
      "Authorization": "Bearer ${API_TOKEN}"
    }
  }
}
```

**Environment variable:**
```bash
export API_TOKEN="your-secret-token-here"
```

### API Keys

Alternative to Bearer tokens, often in custom headers.

**Configuration:**
```json
{
  "api": {
    "type": "http",
    "url": "https://api.example.com/mcp",
    "headers": {
      "X-API-Key": "${API_KEY}",
      "X-API-Secret": "${API_SECRET}"
    }
  }
}
```

### Custom Headers

Services may use custom authentication headers.

**Configuration:**
```json
{
  "service": {
    "type": "sse",
    "url": "https://mcp.example.com/sse",
    "headers": {
      "X-Auth-Token": "${AUTH_TOKEN}",
      "X-User-ID": "${USER_ID}",
      "X-Tenant-ID": "${TENANT_ID}"
    }
  }
}
```

### Documenting Token Requirements

Always document in your README:

```markdown
## Setup

### Required Environment Variables

Set these environment variables before using the plugin:

\`\`\`bash
export API_TOKEN="your-token-here"
export API_SECRET="your-secret-here"
\`\`\`

### Obtaining Tokens

1. Visit https://api.example.com/tokens
2. Create a new API token
3. Copy the token and secret
4. Set environment variables as shown above

### Token Permissions

The API token needs the following permissions:
- Read access to resources
- Write access for creating items
- Delete access (optional, for cleanup operations)
\`\`\`
```

## Environment Variable Authentication (stdio)

### Passing Credentials to Server

For stdio servers, pass credentials via environment variables:

```json
{
  "database": {
    "command": "python",
    "args": ["-m", "mcp_server_db"],
    "env": {
      "DATABASE_URL": "${DATABASE_URL}",
      "DB_USER": "${DB_USER}",
      "DB_PASSWORD": "${DB_PASSWORD}"
    }
  }
}
```

### User Environment Variables

```bash
# User sets these in their shell
export DATABASE_URL="postgresql://localhost/mydb"
export DB_USER="myuser"
export DB_PASSWORD="mypassword"
```

### Documentation Template

```markdown
## Database Configuration

Set these environment variables:

\`\`\`bash
export DATABASE_URL="postgresql://host:port/database"
export DB_USER="username"
export DB_PASSWORD="password"
\`\`\`

Or create a `.env` file (add to `.gitignore`):

\`\`\`
DATABASE_URL=postgresql://localhost:5432/mydb
DB_USER=myuser
DB_PASSWORD=mypassword
\`\`\`

Load with: \`source .env\` or \`export $(cat .env | xargs)\`
\`\`\`
```

## Dynamic Headers

### Headers Helper Script

For tokens that change or expire, use a helper script:

```json
{
  "api": {
    "type": "sse",
    "url": "https://api.example.com",
    "headersHelper": "${CLAUDE_PLUGIN_ROOT}/scripts/get-headers.sh"
  }
}
```

**Script (get-headers.sh):**
```bash
#!/bin/bash
# Generate dynamic authentication headers

# Fetch fresh token
TOKEN=$(get-fresh-token-from-somewhere)

# Output JSON headers
cat <<EOF
{
  "Authorization": "Bearer $TOKEN",
  "X-Timestamp": "$(date -Iseconds)"
}
EOF
```

### Use Cases for Dynamic Headers

- Short-lived tokens that need refresh
- Tokens with HMAC signatures
- Time-based authentication
- Dynamic tenant/workspace selection

## Security Best Practices

### DO

✅ **Use environment variables:**
```json
{
  "headers": {
    "Authorization": "Bearer ${API_TOKEN}"
  }
}
```

✅ **Document required variables in README**

✅ **Use HTTPS/WSS always**

✅ **Implement token rotation**

✅ **Store tokens securely (env vars, not files)**

✅ **Let OAuth handle authentication when available**

### DON'T

❌ **Hardcode tokens:**
```json
{
  "headers": {
    "Authorization": "Bearer sk-abc123..."  // NEVER!
  }
}
```

❌ **Commit tokens to git**

❌ **Share tokens in documentation**

❌ **Use HTTP instead of HTTPS**

❌ **Store tokens in plugin files**

❌ **Log tokens or sensitive headers**

## Multi-Tenancy Patterns

### Workspace/Tenant Selection

**Via environment variable:**
```json
{
  "api": {
    "type": "http",
    "url": "https://api.example.com/mcp",
    "headers": {
      "Authorization": "Bearer ${API_TOKEN}",
      "X-Workspace-ID": "${WORKSPACE_ID}"
    }
  }
}
```

**Via URL:**
```json
{
  "api": {
    "type": "http",
    "url": "https://${TENANT_ID}.api.example.com/mcp"
  }
}
```

### Per-User Configuration

Users set their own workspace:

```bash
export WORKSPACE_ID="my-workspace-123"
export TENANT_ID="my-company"
```

## Authentication Troubleshooting

### Common Issues

**401 Unauthorized:**
- Check token is set correctly
- Verify token hasn't expired
- Check token has required permissions
- Ensure header format is correct

**403 Forbidden:**
- Token valid but lacks permissions
- Check scope/permissions
- Verify workspace/tenant ID
- May need admin approval

**Token not found:**
```bash
# Check environment variable is set
echo $API_TOKEN

# If empty, set it
export API_TOKEN="your-token"
```

**Token in wrong format:**
```json
// Correct
"Authorization": "Bearer sk-abc123"

// Wrong
"Authorization": "sk-abc123"
```

### Debugging Authentication

**Enable debug mode:**
```bash
claude --debug
```

Look for:
- Authentication header values (sanitized)
- OAuth flow progress
- Token refresh attempts
- Authentication errors

**Test authentication separately:**
```bash
# Test HTTP endpoint
curl -H "Authorization: Bearer $API_TOKEN" \
     https://api.example.com/mcp/health

# Should return 200 OK
```

## Migration Patterns

### From Hardcoded to Environment Variables

**Before:**
```json
{
  "headers": {
    "Authorization": "Bearer sk-hardcoded-token"
  }
}
```

**After:**
```json
{
  "headers": {
    "Authorization": "Bearer ${API_TOKEN}"
  }
}
```

**Migration steps:**
1. Add environment variable to plugin README
2. Update configuration to use ${VAR}
3. Test with variable set
4. Remove hardcoded value
5. Commit changes

### From Basic Auth to OAuth

**Before:**
```json
{
  "headers": {
    "Authorization": "Basic ${BASE64_CREDENTIALS}"
  }
}
```

**After:**
```json
{
  "type": "sse",
  "url": "https://mcp.example.com/sse"
}
```

**Benefits:**
- Better security
- No credential management
- Automatic token refresh
- Scoped permissions

## Advanced Authentication

### Mutual TLS (mTLS)

Some enterprise services require client certificates.

**Not directly supported in MCP configuration.**

**Workaround:** Wrap in stdio server that handles mTLS:

```json
{
  "secure-api": {
    "command": "${CLAUDE_PLUGIN_ROOT}/servers/mtls-wrapper",
    "args": ["--cert", "${CLIENT_CERT}", "--key", "${CLIENT_KEY}"],
    "env": {
      "API_URL": "https://secure.example.com"
    }
  }
}
```

### JWT Tokens

Generate JWT tokens dynamically with headers helper:

```bash
#!/bin/bash
# generate-jwt.sh

# Generate JWT (using library or API call)
JWT=$(generate-jwt-token)

echo "{\"Authorization\": \"Bearer $JWT\"}"
```

```json
{
  "headersHelper": "${CLAUDE_PLUGIN_ROOT}/scripts/generate-jwt.sh"
}
```

### HMAC Signatures

For APIs requiring request signing:

```bash
#!/bin/bash
# generate-hmac.sh

TIMESTAMP=$(date -Iseconds)
SIGNATURE=$(echo -n "$TIMESTAMP" | openssl dgst -sha256 -hmac "$SECRET_KEY" | cut -d' ' -f2)

cat <<EOF
{
  "X-Timestamp": "$TIMESTAMP",
  "X-Signature": "$SIGNATURE",
  "X-API-Key": "$API_KEY"
}
EOF
```

## Best Practices Summary

### For Plugin Developers

1. **Prefer OAuth** when service supports it
2. **Use environment variables** for tokens
3. **Document all required variables** in README
4. **Provide setup instructions** with examples
5. **Never commit credentials**
6. **Use HTTPS/WSS only**
7. **Test authentication thoroughly**

### For Plugin Users

1. **Set environment variables** before using plugin
2. **Keep tokens secure** and private
3. **Rotate tokens regularly**
4. **Use different tokens** for dev/prod
5. **Don't commit .env files** to git
6. **Review OAuth scopes** before authorizing

## Conclusion

Choose the authentication method that matches your MCP server's requirements:
- **OAuth** for cloud services (easiest for users)
- **Bearer tokens** for API services
- **Environment variables** for stdio servers
- **Dynamic headers** for complex auth flows

Always prioritize security and provide clear setup documentation for users.

---

## Source: mcp-integration/references / server-types.md

# MCP Server Types: Deep Dive

Complete reference for all MCP server types supported in Claude Code plugins.

## stdio (Standard Input/Output)

### Overview

Execute local MCP servers as child processes with communication via stdin/stdout. Best choice for local tools, custom servers, and NPM packages.

### Configuration

**Basic:**
```json
{
  "my-server": {
    "command": "npx",
    "args": ["-y", "my-mcp-server"]
  }
}
```

**With environment:**
```json
{
  "my-server": {
    "command": "${CLAUDE_PLUGIN_ROOT}/servers/custom-server",
    "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
    "env": {
      "API_KEY": "${MY_API_KEY}",
      "LOG_LEVEL": "debug",
      "DATABASE_URL": "${DB_URL}"
    }
  }
}
```

### Process Lifecycle

1. **Startup**: Claude Code spawns process with `command` and `args`
2. **Communication**: JSON-RPC messages via stdin/stdout
3. **Lifecycle**: Process runs for entire Claude Code session
4. **Shutdown**: Process terminated when Claude Code exits

### Use Cases

**NPM Packages:**
```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
  }
}
```

**Custom Scripts:**
```json
{
  "custom": {
    "command": "${CLAUDE_PLUGIN_ROOT}/servers/my-server.js",
    "args": ["--verbose"]
  }
}
```

**Python Servers:**
```json
{
  "python-server": {
    "command": "python",
    "args": ["-m", "my_mcp_server"],
    "env": {
      "PYTHONUNBUFFERED": "1"
    }
  }
}
```

### Best Practices

1. **Use absolute paths or ${CLAUDE_PLUGIN_ROOT}**
2. **Set PYTHONUNBUFFERED for Python servers**
3. **Pass configuration via args or env, not stdin**
4. **Handle server crashes gracefully**
5. **Log to stderr, not stdout (stdout is for MCP protocol)**

### Troubleshooting

**Server won't start:**
- Check command exists and is executable
- Verify file paths are correct
- Check permissions
- Review `claude --debug` logs

**Communication fails:**
- Ensure server uses stdin/stdout correctly
- Check for stray print/console.log statements
- Verify JSON-RPC format

## SSE (Server-Sent Events)

### Overview

Connect to hosted MCP servers via HTTP with server-sent events for streaming. Best for cloud services and OAuth authentication.

### Configuration

**Basic:**
```json
{
  "hosted-service": {
    "type": "sse",
    "url": "https://mcp.example.com/sse"
  }
}
```

**With headers:**
```json
{
  "service": {
    "type": "sse",
    "url": "https://mcp.example.com/sse",
    "headers": {
      "X-API-Version": "v1",
      "X-Client-ID": "${CLIENT_ID}"
    }
  }
}
```

### Connection Lifecycle

1. **Initialization**: HTTP connection established to URL
2. **Handshake**: MCP protocol negotiation
3. **Streaming**: Server sends events via SSE
4. **Requests**: Client sends HTTP POST for tool calls
5. **Reconnection**: Automatic reconnection on disconnect

### Authentication

**OAuth (Automatic):**
```json
{
  "asana": {
    "type": "sse",
    "url": "https://mcp.asana.com/sse"
  }
}
```

Claude Code handles OAuth flow:
1. User prompted to authenticate on first use
2. Opens browser for OAuth flow
3. Tokens stored securely
4. Automatic token refresh

**Custom Headers:**
```json
{
  "service": {
    "type": "sse",
    "url": "https://mcp.example.com/sse",
    "headers": {
      "Authorization": "Bearer ${API_TOKEN}"
    }
  }
}
```

### Use Cases

**Official Services:**
- Asana: `https://mcp.asana.com/sse`
- GitHub: `https://mcp.github.com/sse`
- Other hosted MCP servers

**Custom Hosted Servers:**
Deploy your own MCP server and expose via HTTPS + SSE.

### Best Practices

1. **Always use HTTPS, never HTTP**
2. **Let OAuth handle authentication when available**
3. **Use environment variables for tokens**
4. **Handle connection failures gracefully**
5. **Document OAuth scopes required**

### Troubleshooting

**Connection refused:**
- Check URL is correct and accessible
- Verify HTTPS certificate is valid
- Check network connectivity
- Review firewall settings

**OAuth fails:**
- Clear cached tokens
- Check OAuth scopes
- Verify redirect URLs
- Re-authenticate

## HTTP (REST API)

### Overview

Connect to RESTful MCP servers via standard HTTP requests. Best for token-based auth and stateless interactions.

### Configuration

**Basic:**
```json
{
  "api": {
    "type": "http",
    "url": "https://api.example.com/mcp"
  }
}
```

**With authentication:**
```json
{
  "api": {
    "type": "http",
    "url": "https://api.example.com/mcp",
    "headers": {
      "Authorization": "Bearer ${API_TOKEN}",
      "Content-Type": "application/json",
      "X-API-Version": "2024-01-01"
    }
  }
}
```

### Request/Response Flow

1. **Tool Discovery**: GET to discover available tools
2. **Tool Invocation**: POST with tool name and parameters
3. **Response**: JSON response with results or errors
4. **Stateless**: Each request independent

### Authentication

**Token-Based:**
```json
{
  "headers": {
    "Authorization": "Bearer ${API_TOKEN}"
  }
}
```

**API Key:**
```json
{
  "headers": {
    "X-API-Key": "${API_KEY}"
  }
}
```

**Custom Auth:**
```json
{
  "headers": {
    "X-Auth-Token": "${AUTH_TOKEN}",
    "X-User-ID": "${USER_ID}"
  }
}
```

### Use Cases

- REST API backends
- Internal services
- Microservices
- Serverless functions

### Best Practices

1. **Use HTTPS for all connections**
2. **Store tokens in environment variables**
3. **Implement retry logic for transient failures**
4. **Handle rate limiting**
5. **Set appropriate timeouts**

### Troubleshooting

**HTTP errors:**
- 401: Check authentication headers
- 403: Verify permissions
- 429: Implement rate limiting
- 500: Check server logs

**Timeout issues:**
- Increase timeout if needed
- Check server performance
- Optimize tool implementations

## WebSocket (Real-time)

### Overview

Connect to MCP servers via WebSocket for real-time bidirectional communication. Best for streaming and low-latency applications.

### Configuration

**Basic:**
```json
{
  "realtime": {
    "type": "ws",
    "url": "wss://mcp.example.com/ws"
  }
}
```

**With authentication:**
```json
{
  "realtime": {
    "type": "ws",
    "url": "wss://mcp.example.com/ws",
    "headers": {
      "Authorization": "Bearer ${TOKEN}",
      "X-Client-ID": "${CLIENT_ID}"
    }
  }
}
```

### Connection Lifecycle

1. **Handshake**: WebSocket upgrade request
2. **Connection**: Persistent bidirectional channel
3. **Messages**: JSON-RPC over WebSocket
4. **Heartbeat**: Keep-alive messages
5. **Reconnection**: Automatic on disconnect

### Use Cases

- Real-time data streaming
- Live updates and notifications
- Collaborative editing
- Low-latency tool calls
- Push notifications from server

### Best Practices

1. **Use WSS (secure WebSocket), never WS**
2. **Implement heartbeat/ping-pong**
3. **Handle reconnection logic**
4. **Buffer messages during disconnection**
5. **Set connection timeouts**

### Troubleshooting

**Connection drops:**
- Implement reconnection logic
- Check network stability
- Verify server supports WebSocket
- Review firewall settings

**Message delivery:**
- Implement message acknowledgment
- Handle out-of-order messages
- Buffer during disconnection

## Comparison Matrix

| Feature | stdio | SSE | HTTP | WebSocket |
|---------|-------|-----|------|-----------|
| **Transport** | Process | HTTP/SSE | HTTP | WebSocket |
| **Direction** | Bidirectional | Server→Client | Request/Response | Bidirectional |
| **State** | Stateful | Stateful | Stateless | Stateful |
| **Auth** | Env vars | OAuth/Headers | Headers | Headers |
| **Use Case** | Local tools | Cloud services | REST APIs | Real-time |
| **Latency** | Lowest | Medium | Medium | Low |
| **Setup** | Easy | Medium | Easy | Medium |
| **Reconnect** | Process respawn | Automatic | N/A | Automatic |

## Choosing the Right Type

**Use stdio when:**
- Running local tools or custom servers
- Need lowest latency
- Working with file systems or local databases
- Distributing server with plugin

**Use SSE when:**
- Connecting to hosted services
- Need OAuth authentication
- Using official MCP servers (Asana, GitHub)
- Want automatic reconnection

**Use HTTP when:**
- Integrating with REST APIs
- Need stateless interactions
- Using token-based auth
- Simple request/response pattern

**Use WebSocket when:**
- Need real-time updates
- Building collaborative features
- Low-latency critical
- Bi-directional streaming required

## Migration Between Types

### From stdio to SSE

**Before (stdio):**
```json
{
  "local-server": {
    "command": "node",
    "args": ["server.js"]
  }
}
```

**After (SSE - deploy server):**
```json
{
  "hosted-server": {
    "type": "sse",
    "url": "https://mcp.example.com/sse"
  }
}
```

### From HTTP to WebSocket

**Before (HTTP):**
```json
{
  "api": {
    "type": "http",
    "url": "https://api.example.com/mcp"
  }
}
```

**After (WebSocket):**
```json
{
  "realtime": {
    "type": "ws",
    "url": "wss://api.example.com/ws"
  }
}
```

Benefits: Real-time updates, lower latency, bi-directional communication.

## Advanced Configuration

### Multiple Servers

Combine different types:

```json
{
  "local-db": {
    "command": "npx",
    "args": ["-y", "mcp-server-sqlite", "./data.db"]
  },
  "cloud-api": {
    "type": "sse",
    "url": "https://mcp.example.com/sse"
  },
  "internal-service": {
    "type": "http",
    "url": "https://api.example.com/mcp",
    "headers": {
      "Authorization": "Bearer ${API_TOKEN}"
    }
  }
}
```

### Conditional Configuration

Use environment variables to switch servers:

```json
{
  "api": {
    "type": "http",
    "url": "${API_URL}",
    "headers": {
      "Authorization": "Bearer ${API_TOKEN}"
    }
  }
}
```

Set different values for dev/prod:
- Dev: `API_URL=http://localhost:8080/mcp`
- Prod: `API_URL=https://api.production.com/mcp`

## Security Considerations

### Stdio Security

- Validate command paths
- Don't execute user-provided commands
- Limit environment variable access
- Restrict file system access

### Network Security

- Always use HTTPS/WSS
- Validate SSL certificates
- Don't skip certificate verification
- Use secure token storage

### Token Management

- Never hardcode tokens
- Use environment variables
- Rotate tokens regularly
- Implement token refresh
- Document scopes required

## Conclusion

Choose the MCP server type based on your use case:
- **stdio** for local, custom, or NPM-packaged servers
- **SSE** for hosted services with OAuth
- **HTTP** for REST APIs with token auth
- **WebSocket** for real-time bidirectional communication

Test thoroughly and handle errors gracefully for robust MCP integration.

---

## Source: mcp-integration/references / tool-usage.md

# Using MCP Tools in Commands and Agents

Complete guide to using MCP tools effectively in Claude Code plugin commands and agents.

## Overview

Once an MCP server is configured, its tools become available with the prefix `mcp__plugin_<plugin-name>_<server-name>__<tool-name>`. Use these tools in commands and agents just like built-in Claude Code tools.

## Tool Naming Convention

### Format

```
mcp__plugin_<plugin-name>_<server-name>__<tool-name>
```

### Examples

**Asana plugin with asana server:**
- `mcp__plugin_asana_asana__asana_create_task`
- `mcp__plugin_asana_asana__asana_search_tasks`
- `mcp__plugin_asana_asana__asana_get_project`

**Custom plugin with database server:**
- `mcp__plugin_myplug_database__query`
- `mcp__plugin_myplug_database__execute`
- `mcp__plugin_myplug_database__list_tables`

### Discovering Tool Names

**Use `/mcp` command:**
```bash
/mcp
```

This shows:
- All available MCP servers
- Tools provided by each server
- Tool schemas and descriptions
- Full tool names for use in configuration

## Using Tools in Commands

### Pre-Allowing Tools

Specify MCP tools in command frontmatter:

```markdown
---
description: Create a new Asana task
allowed-tools: [
  "mcp__plugin_asana_asana__asana_create_task"
]
---

# Create Task Command

To create a task:
1. Gather task details from user
2. Use mcp__plugin_asana_asana__asana_create_task with the details
3. Confirm creation to user
```

### Multiple Tools

```markdown
---
allowed-tools: [
  "mcp__plugin_asana_asana__asana_create_task",
  "mcp__plugin_asana_asana__asana_search_tasks",
  "mcp__plugin_asana_asana__asana_get_project"
]
---
```

### Wildcard (Use Sparingly)

```markdown
---
allowed-tools: ["mcp__plugin_asana_asana__*"]
---
```

**Caution:** Only use wildcards if the command truly needs access to all tools from a server.

### Tool Usage in Command Instructions

**Example command:**
```markdown
---
description: Search and create Asana tasks
allowed-tools: [
  "mcp__plugin_asana_asana__asana_search_tasks",
  "mcp__plugin_asana_asana__asana_create_task"
]
---

# Asana Task Management

## Searching Tasks

To search for tasks:
1. Use mcp__plugin_asana_asana__asana_search_tasks
2. Provide search filters (assignee, project, etc.)
3. Display results to user

## Creating Tasks

To create a task:
1. Gather task details:
   - Title (required)
   - Description
   - Project
   - Assignee
   - Due date
2. Use mcp__plugin_asana_asana__asana_create_task
3. Show confirmation with task link
```

## Using Tools in Agents

### Agent Configuration

Agents can use MCP tools autonomously without pre-allowing them:

```markdown
---
name: asana-status-updater
description: This agent should be used when the user asks to "update Asana status", "generate project report", or "sync Asana tasks"
model: inherit
color: blue
---

## Role

Autonomous agent for generating Asana project status reports.

## Process

1. **Query tasks**: Use mcp__plugin_asana_asana__asana_search_tasks to get all tasks
2. **Analyze progress**: Calculate completion rates and identify blockers
3. **Generate report**: Create formatted status update
4. **Update Asana**: Use mcp__plugin_asana_asana__asana_create_comment to post report

## Available Tools

The agent has access to all Asana MCP tools without pre-approval.
```

### Agent Tool Access

Agents have broader tool access than commands:
- Can use any tool Claude determines is necessary
- Don't need pre-allowed lists
- Should document which tools they typically use

## Tool Call Patterns

### Pattern 1: Simple Tool Call

Single tool call with validation:

```markdown
Steps:
1. Validate user provided required fields
2. Call mcp__plugin_api_server__create_item with validated data
3. Check for errors
4. Display confirmation
```

### Pattern 2: Sequential Tools

Chain multiple tool calls:

```markdown
Steps:
1. Search for existing items: mcp__plugin_api_server__search
2. If not found, create new: mcp__plugin_api_server__create
3. Add metadata: mcp__plugin_api_server__update_metadata
4. Return final item ID
```

### Pattern 3: Batch Operations

Multiple calls with same tool:

```markdown
Steps:
1. Get list of items to process
2. For each item:
   - Call mcp__plugin_api_server__update_item
   - Track success/failure
3. Report results summary
```

### Pattern 4: Error Handling

Graceful error handling:

```markdown
Steps:
1. Try to call mcp__plugin_api_server__get_data
2. If error (rate limit, network, etc.):
   - Wait and retry (max 3 attempts)
   - If still failing, inform user
   - Suggest checking configuration
3. On success, process data
```

## Tool Parameters

### Understanding Tool Schemas

Each MCP tool has a schema defining its parameters. View with `/mcp`.

**Example schema:**
```json
{
  "name": "asana_create_task",
  "description": "Create a new Asana task",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Task title"
      },
      "notes": {
        "type": "string",
        "description": "Task description"
      },
      "workspace": {
        "type": "string",
        "description": "Workspace GID"
      }
    },
    "required": ["name", "workspace"]
  }
}
```

### Calling Tools with Parameters

Claude automatically structures tool calls based on schema:

```typescript
// Claude generates this internally
{
  toolName: "mcp__plugin_asana_asana__asana_create_task",
  input: {
    name: "Review PR #123",
    notes: "Code review for new feature",
    workspace: "12345",
    assignee: "67890",
    due_on: "2025-01-15"
  }
}
```

### Parameter Validation

**In commands, validate before calling:**

```markdown
Steps:
1. Check required parameters:
   - Title is not empty
   - Workspace ID is provided
   - Due date is valid format (YYYY-MM-DD)
2. If validation fails, ask user to provide missing data
3. If validation passes, call MCP tool
4. Handle tool errors gracefully
```

## Response Handling

### Success Responses

```markdown
Steps:
1. Call MCP tool
2. On success:
   - Extract relevant data from response
   - Format for user display
   - Provide confirmation message
   - Include relevant links or IDs
```

### Error Responses

```markdown
Steps:
1. Call MCP tool
2. On error:
   - Check error type (auth, rate limit, validation, etc.)
   - Provide helpful error message
   - Suggest remediation steps
   - Don't expose internal error details to user
```

### Partial Success

```markdown
Steps:
1. Batch operation with multiple MCP calls
2. Track successes and failures separately
3. Report summary:
   - "Successfully processed 8 of 10 items"
   - "Failed items: [item1, item2] due to [reason]"
   - Suggest retry or manual intervention
```

## Performance Optimization

### Batching Requests

**Good: Single query with filters**
```markdown
Steps:
1. Call mcp__plugin_api_server__search with filters:
   - project_id: "123"
   - status: "active"
   - limit: 100
2. Process all results
```

**Avoid: Many individual queries**
```markdown
Steps:
1. For each item ID:
   - Call mcp__plugin_api_server__get_item
   - Process item
```

### Caching Results

```markdown
Steps:
1. Call expensive MCP operation: mcp__plugin_api_server__analyze
2. Store results in variable for reuse
3. Use cached results for subsequent operations
4. Only re-fetch if data changes
```

### Parallel Tool Calls

When tools don't depend on each other, call in parallel:

```markdown
Steps:
1. Make parallel calls (Claude handles this automatically):
   - mcp__plugin_api_server__get_project
   - mcp__plugin_api_server__get_users
   - mcp__plugin_api_server__get_tags
2. Wait for all to complete
3. Combine results
```

## Integration Best Practices

### User Experience

**Provide feedback:**
```markdown
Steps:
1. Inform user: "Searching Asana tasks..."
2. Call mcp__plugin_asana_asana__asana_search_tasks
3. Show progress: "Found 15 tasks, analyzing..."
4. Present results
```

**Handle long operations:**
```markdown
Steps:
1. Warn user: "This may take a minute..."
2. Break into smaller steps with updates
3. Show incremental progress
4. Final summary when complete
```

### Error Messages

**Good error messages:**
```
❌ "Could not create task. Please check:
   1. You're logged into Asana
   2. You have access to workspace 'Engineering'
   3. The project 'Q1 Goals' exists"
```

**Poor error messages:**
```
❌ "Error: MCP tool returned 403"
```

### Documentation

**Document MCP tool usage in command:**
```markdown
## MCP Tools Used

This command uses the following Asana MCP tools:
- **asana_search_tasks**: Search for tasks matching criteria
- **asana_create_task**: Create new task with details
- **asana_update_task**: Update existing task properties

Ensure you're authenticated to Asana before running this command.
```

## Testing Tool Usage

### Local Testing

1. **Configure MCP server** in `.mcp.json`
2. **Install plugin locally** in `.claude-plugin/`
3. **Verify tools available** with `/mcp`
4. **Test command** that uses tools
5. **Check debug output**: `claude --debug`

### Test Scenarios

**Test successful calls:**
```markdown
Steps:
1. Create test data in external service
2. Run command that queries this data
3. Verify correct results returned
```

**Test error cases:**
```markdown
Steps:
1. Test with missing authentication
2. Test with invalid parameters
3. Test with non-existent resources
4. Verify graceful error handling
```

**Test edge cases:**
```markdown
Steps:
1. Test with empty results
2. Test with maximum results
3. Test with special characters
4. Test with concurrent access
```

## Common Patterns

### Pattern: CRUD Operations

```markdown
---
allowed-tools: [
  "mcp__plugin_api_server__create_item",
  "mcp__plugin_api_server__read_item",
  "mcp__plugin_api_server__update_item",
  "mcp__plugin_api_server__delete_item"
]
---

# Item Management

## Create
Use create_item with required fields...

## Read
Use read_item with item ID...

## Update
Use update_item with item ID and changes...

## Delete
Use delete_item with item ID (ask for confirmation first)...
```

### Pattern: Search and Process

```markdown
Steps:
1. **Search**: mcp__plugin_api_server__search with filters
2. **Filter**: Apply additional local filtering if needed
3. **Transform**: Process each result
4. **Present**: Format and display to user
```

### Pattern: Multi-Step Workflow

```markdown
Steps:
1. **Setup**: Gather all required information
2. **Validate**: Check data completeness
3. **Execute**: Chain of MCP tool calls:
   - Create parent resource
   - Create child resources
   - Link resources together
   - Add metadata
4. **Verify**: Confirm all steps succeeded
5. **Report**: Provide summary to user
```

## Troubleshooting

### Tools Not Available

**Check:**
- MCP server configured correctly
- Server connected (check `/mcp`)
- Tool names match exactly (case-sensitive)
- Restart Claude Code after config changes

### Tool Calls Failing

**Check:**
- Authentication is valid
- Parameters match tool schema
- Required parameters provided
- Check `claude --debug` logs

### Performance Issues

**Check:**
- Batching queries instead of individual calls
- Caching results when appropriate
- Not making unnecessary tool calls
- Parallel calls when possible

## Conclusion

Effective MCP tool usage requires:
1. **Understanding tool schemas** via `/mcp`
2. **Pre-allowing tools** in commands appropriately
3. **Handling errors gracefully**
4. **Optimizing performance** with batching and caching
5. **Providing good UX** with feedback and clear errors
6. **Testing thoroughly** before deployment

Follow these patterns for robust MCP tool integration in your plugin commands and agents.

---
