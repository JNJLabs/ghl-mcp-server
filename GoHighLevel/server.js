// GoHighLevel MCP Server
// A real Model Context Protocol server (JSON-RPC over Streamable HTTP).
// Exposes GoHighLevel CRM tools to MCP clients like Claude.
//
// Required Railway environment variables:
//   GOHL_API_KEY     - your GoHighLevel API key / access token
//   GOHL_ACCOUNT_ID  - your GoHighLevel location (account) ID
//   PORT             - set automatically by Railway

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ── Config ──────────────────────────────────────────────────────────────────
const GHL_API_KEY = process.env.GOHL_API_KEY;
const GHL_LOCATION_ID = process.env.GOHL_ACCOUNT_ID;
const GHL_BASE = "https://services.leadconnectorhq.com";
const PORT = process.env.PORT || 3000;

// ── Helper: call the GoHighLevel REST API ───────────────────────────────────
async function ghlFetch(path, options = {}) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: "2021-07-28",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`GoHighLevel API error ${res.status}: ${detail}`);
  }
  return data;
}

// ── Build a fresh MCP server instance (one per request, stateless) ──────────
function buildServer() {
  const server = new McpServer({
    name: "gohighlevel-mcp",
    version: "2.0.0",
  });

  server.registerTool(
    "list_recent_leads",
    {
      title: "List recent leads",
      description: "Get recent contacts/leads from GoHighLevel.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("How many leads to fetch (default 20, max 100)"),
      },
    },
    async ({ limit }) => {
      const data = await ghlFetch(
        `/contacts/?locationId=${GHL_LOCATION_ID}&limit=${limit || 20}`
      );
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "get_lead_details",
    {
      title: "Get lead details",
      description: "Get the full details of a specific contact by its ID.",
      inputSchema: {
        contact_id: z.string().describe("The GoHighLevel contact ID"),
      },
    },
    async ({ contact_id }) => {
      const data = await ghlFetch(`/contacts/${contact_id}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  server.registerTool(
    "update_lead_status",
    {
      title: "Update lead status",
      description: "Update a contact's tags in GoHighLevel.",
      inputSchema: {
        contact_id: z.string().describe("The GoHighLevel contact ID"),
        tags: z
          .array(z.string())
          .describe("Tags to apply to the contact"),
      },
    },
    async ({ contact_id, tags }) => {
      const data = await ghlFetch(`/contacts/${contact_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: tags || [] }),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  return server;
}

// ── HTTP layer ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Health check
app.get("/", (req, res) => res.send("GoHighLevel MCP Server is running!"));

// MCP endpoint — stateless: a new server + transport is created per request.
app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// In stateless mode there is no session to GET (stream) or DELETE.
const methodNotAllowed = (req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST." },
    id: null,
  });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(PORT, () => {
  console.log(`GoHighLevel MCP server running on port ${PORT}`);
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    console.warn(
      "WARNING: GOHL_API_KEY or GOHL_ACCOUNT_ID is not set — tool calls will fail until they are."
    );
  }
});
