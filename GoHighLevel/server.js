// GoHighLevel MCP Server (v2.1)
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
// `version` lets specific endpoints use the API version they expect.
async function ghlFetch(path, { version = "2021-07-28", ...options } = {}) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: version,
      Accept: "application/json",
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

// Shorthand for returning a tool result as a text block.
const text = (data) => ({
  content: [
    {
      type: "text",
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    },
  ],
});

// ── Build a fresh MCP server instance (one per request, stateless) ──────────
function buildServer() {
  const server = new McpServer({
    name: "gohighlevel-mcp",
    version: "2.1.0",
  });

  // ─── Contacts ──────────────────────────────────────────────────────────────
  server.registerTool(
    "list_recent_leads",
    {
      title: "List recent leads",
      description: "Get recent contacts/leads from GoHighLevel.",
      inputSchema: {
        limit: z.number().int().positive().max(100).optional()
          .describe("How many leads to fetch (default 20, max 100)"),
      },
    },
    async ({ limit }) => {
      const data = await ghlFetch(
        `/contacts/?locationId=${GHL_LOCATION_ID}&limit=${limit || 20}`
      );
      return text(data);
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
    async ({ contact_id }) => text(await ghlFetch(`/contacts/${contact_id}`))
  );

  server.registerTool(
    "update_lead_status",
    {
      title: "Update lead tags",
      description: "Update a contact's tags in GoHighLevel.",
      inputSchema: {
        contact_id: z.string().describe("The GoHighLevel contact ID"),
        tags: z.array(z.string()).describe("Tags to apply to the contact"),
      },
    },
    async ({ contact_id, tags }) =>
      text(
        await ghlFetch(`/contacts/${contact_id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags: tags || [] }),
        })
      )
  );

  // ─── Conversations: SMS & Email ────────────────────────────────────────────
  server.registerTool(
    "send_sms_to_lead",
    {
      title: "Send SMS to a lead",
      description:
        "Send a text message to a GoHighLevel contact. Requires your GHL plan/token to allow outbound SMS.",
      inputSchema: {
        contact_id: z.string().describe("The GoHighLevel contact ID"),
        message: z.string().min(1).max(1600).describe("SMS body (max ~1600 chars)"),
      },
    },
    async ({ contact_id, message }) =>
      text(
        await ghlFetch(`/conversations/messages`, {
          version: "2021-04-15",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "SMS",
            contactId: contact_id,
            message,
          }),
        })
      )
  );

  server.registerTool(
    "send_email_to_lead",
    {
      title: "Send email to a lead",
      description:
        "Send an email to a GoHighLevel contact. Requires your GHL plan/token to allow outbound email.",
      inputSchema: {
        contact_id: z.string().describe("The GoHighLevel contact ID"),
        subject: z.string().describe("Email subject line"),
        body: z.string().describe("Email body (HTML allowed)"),
      },
    },
    async ({ contact_id, subject, body }) =>
      text(
        await ghlFetch(`/conversations/messages`, {
          version: "2021-04-15",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "Email",
            contactId: contact_id,
            subject,
            html: body,
          }),
        })
      )
  );

  // ─── Pipelines & Opportunities ─────────────────────────────────────────────
  server.registerTool(
    "list_pipelines",
    {
      title: "List pipelines",
      description: "List all opportunity pipelines and their stages in this location.",
      inputSchema: {},
    },
    async () =>
      text(
        await ghlFetch(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`)
      )
  );

  server.registerTool(
    "list_opportunities",
    {
      title: "List opportunities",
      description:
        "Search opportunities in this location. Optionally filter by pipeline.",
      inputSchema: {
        pipeline_id: z.string().optional().describe("Pipeline ID to filter by"),
        limit: z.number().int().positive().max(100).optional()
          .describe("How many opportunities to fetch (default 20, max 100)"),
      },
    },
    async ({ pipeline_id, limit }) => {
      const params = new URLSearchParams({
        location_id: GHL_LOCATION_ID,
        limit: String(limit || 20),
      });
      if (pipeline_id) params.set("pipeline_id", pipeline_id);
      return text(await ghlFetch(`/opportunities/search?${params.toString()}`));
    }
  );

  server.registerTool(
    "create_opportunity",
    {
      title: "Create opportunity",
      description: "Create a new opportunity (deal) in a pipeline stage for a contact.",
      inputSchema: {
        pipeline_id: z.string().describe("Pipeline ID"),
        pipeline_stage_id: z.string().describe("Pipeline stage ID"),
        contact_id: z.string().describe("Contact ID for this opportunity"),
        name: z.string().optional().describe("Opportunity name (default: contact name)"),
        monetary_value: z.number().nonnegative().optional()
          .describe("Dollar value of the opportunity"),
        status: z.enum(["open", "won", "lost", "abandoned"]).optional()
          .describe("Status (default: open)"),
      },
    },
    async ({ pipeline_id, pipeline_stage_id, contact_id, name, monetary_value, status }) => {
      const body = {
        locationId: GHL_LOCATION_ID,
        pipelineId: pipeline_id,
        pipelineStageId: pipeline_stage_id,
        contactId: contact_id,
        status: status || "open",
      };
      if (name) body.name = name;
      if (monetary_value !== undefined) body.monetaryValue = monetary_value;
      return text(
        await ghlFetch(`/opportunities/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      );
    }
  );

  server.registerTool(
    "update_opportunity_stage",
    {
      title: "Move opportunity to a different stage",
      description: "Update an opportunity's pipeline stage and/or status.",
      inputSchema: {
        opportunity_id: z.string().describe("Opportunity ID"),
        pipeline_id: z.string().describe("Pipeline ID the opportunity belongs to"),
        pipeline_stage_id: z.string().optional().describe("New pipeline stage ID"),
        status: z.enum(["open", "won", "lost", "abandoned"]).optional()
          .describe("New status"),
      },
    },
    async ({ opportunity_id, pipeline_id, pipeline_stage_id, status }) => {
      const body = { pipelineId: pipeline_id };
      if (pipeline_stage_id) body.pipelineStageId = pipeline_stage_id;
      if (status) body.status = status;
      return text(
        await ghlFetch(`/opportunities/${opportunity_id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      );
    }
  );

  // ─── Funnels ───────────────────────────────────────────────────────────────
  server.registerTool(
    "list_funnels",
    {
      title: "List funnels",
      description: "List all funnels in this GoHighLevel location.",
      inputSchema: {},
    },
    async () =>
      text(
        await ghlFetch(`/funnels/funnel/list?locationId=${GHL_LOCATION_ID}`)
      )
  );

  server.registerTool(
    "list_funnel_pages",
    {
      title: "List pages in a funnel",
      description: "List the pages inside a specific funnel.",
      inputSchema: {
        funnel_id: z.string().describe("Funnel ID"),
      },
    },
    async ({ funnel_id }) =>
      text(
        await ghlFetch(
          `/funnels/page?locationId=${GHL_LOCATION_ID}&funnelId=${funnel_id}`
        )
      )
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
  console.log(`GoHighLevel MCP server v2.1 running on port ${PORT}`);
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    console.warn(
      "WARNING: GOHL_API_KEY or GOHL_ACCOUNT_ID is not set — tool calls will fail until they are."
    );
  }
});
