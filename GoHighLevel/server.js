// GoHighLevel MCP Server (v3.0)
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

// Convert an ISO date string to GHL's expected millisecond epoch.
const toEpochMs = (iso) => String(new Date(iso).getTime());

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
    version: "3.0.0",
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
    async ({ limit }) =>
      text(
        await ghlFetch(
          `/contacts/?locationId=${GHL_LOCATION_ID}&limit=${limit || 20}`
        )
      )
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

  // ─── Conversations: send SMS / email ───────────────────────────────────────
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

  // ─── Conversations: history ────────────────────────────────────────────────
  server.registerTool(
    "search_conversations",
    {
      title: "Search conversations",
      description:
        "Search conversations in this location. Optionally filter by contact.",
      inputSchema: {
        contact_id: z.string().optional().describe("Filter by contact ID"),
        limit: z.number().int().positive().max(100).optional()
          .describe("How many conversations (default 20, max 100)"),
      },
    },
    async ({ contact_id, limit }) => {
      const params = new URLSearchParams({
        locationId: GHL_LOCATION_ID,
        limit: String(limit || 20),
      });
      if (contact_id) params.set("contactId", contact_id);
      return text(
        await ghlFetch(`/conversations/search?${params.toString()}`, {
          version: "2021-04-15",
        })
      );
    }
  );

  server.registerTool(
    "get_conversation_messages",
    {
      title: "Get conversation messages",
      description: "Get the messages in a specific conversation.",
      inputSchema: {
        conversation_id: z.string().describe("Conversation ID"),
        limit: z.number().int().positive().max(100).optional()
          .describe("How many messages (default 20, max 100)"),
      },
    },
    async ({ conversation_id, limit }) =>
      text(
        await ghlFetch(
          `/conversations/${conversation_id}/messages?limit=${limit || 20}`,
          { version: "2021-04-15" }
        )
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

  server.registerTool(
    "get_funnel_page",
    {
      title: "Get funnel page details",
      description: "Get details of a specific page in a funnel.",
      inputSchema: {
        page_id: z.string().describe("Funnel page ID"),
      },
    },
    async ({ page_id }) =>
      text(
        await ghlFetch(
          `/funnels/page/${page_id}?locationId=${GHL_LOCATION_ID}`
        )
      )
  );

  // ─── Workflows ─────────────────────────────────────────────────────────────
  server.registerTool(
    "list_workflows",
    {
      title: "List workflows",
      description: "List all automation workflows in this location.",
      inputSchema: {},
    },
    async () =>
      text(await ghlFetch(`/workflows/?locationId=${GHL_LOCATION_ID}`))
  );

  server.registerTool(
    "add_lead_to_workflow",
    {
      title: "Add a lead to a workflow",
      description: "Enroll a contact into an automation workflow.",
      inputSchema: {
        contact_id: z.string().describe("Contact ID"),
        workflow_id: z.string().describe("Workflow ID"),
      },
    },
    async ({ contact_id, workflow_id }) =>
      text(
        await ghlFetch(
          `/contacts/${contact_id}/workflow/${workflow_id}`,
          { method: "POST" }
        )
      )
  );

  server.registerTool(
    "remove_lead_from_workflow",
    {
      title: "Remove a lead from a workflow",
      description: "Remove a contact from an automation workflow.",
      inputSchema: {
        contact_id: z.string().describe("Contact ID"),
        workflow_id: z.string().describe("Workflow ID"),
      },
    },
    async ({ contact_id, workflow_id }) =>
      text(
        await ghlFetch(
          `/contacts/${contact_id}/workflow/${workflow_id}`,
          { method: "DELETE" }
        )
      )
  );

  // ─── Calendars & Appointments ──────────────────────────────────────────────
  server.registerTool(
    "list_calendars",
    {
      title: "List calendars",
      description: "List all calendars in this location.",
      inputSchema: {},
    },
    async () =>
      text(
        await ghlFetch(`/calendars/?locationId=${GHL_LOCATION_ID}`, {
          version: "2021-04-15",
        })
      )
  );

  server.registerTool(
    "list_calendar_events",
    {
      title: "List calendar events",
      description:
        "List calendar events / appointments within a date range. Optionally filter by calendar.",
      inputSchema: {
        start_time: z.string()
          .describe("Start time as ISO 8601, e.g. '2026-05-19T00:00:00Z'"),
        end_time: z.string()
          .describe("End time as ISO 8601, e.g. '2026-05-26T00:00:00Z'"),
        calendar_id: z.string().optional()
          .describe("Filter to one calendar (optional)"),
      },
    },
    async ({ start_time, end_time, calendar_id }) => {
      const params = new URLSearchParams({
        locationId: GHL_LOCATION_ID,
        startTime: toEpochMs(start_time),
        endTime: toEpochMs(end_time),
      });
      if (calendar_id) params.set("calendarId", calendar_id);
      return text(
        await ghlFetch(`/calendars/events?${params.toString()}`, {
          version: "2021-04-15",
        })
      );
    }
  );

  server.registerTool(
    "get_calendar_free_slots",
    {
      title: "Get free time slots on a calendar",
      description: "Find available booking slots in a calendar's date range.",
      inputSchema: {
        calendar_id: z.string().describe("Calendar ID"),
        start_date: z.string()
          .describe("Start date as ISO 8601, e.g. '2026-05-19T00:00:00Z'"),
        end_date: z.string()
          .describe("End date as ISO 8601, e.g. '2026-05-26T00:00:00Z'"),
        timezone: z.string().optional()
          .describe("IANA timezone (e.g. 'America/Toronto'). Defaults to GHL location default."),
      },
    },
    async ({ calendar_id, start_date, end_date, timezone }) => {
      const params = new URLSearchParams({
        startDate: toEpochMs(start_date),
        endDate: toEpochMs(end_date),
      });
      if (timezone) params.set("timezone", timezone);
      return text(
        await ghlFetch(
          `/calendars/${calendar_id}/free-slots?${params.toString()}`,
          { version: "2021-04-15" }
        )
      );
    }
  );

  server.registerTool(
    "create_appointment",
    {
      title: "Book a calendar appointment",
      description:
        "Create an appointment for a contact on a calendar. Times in ISO 8601.",
      inputSchema: {
        calendar_id: z.string().describe("Calendar ID"),
        contact_id: z.string().describe("Contact ID booking the appointment"),
        start_time: z.string()
          .describe("Start as ISO 8601, e.g. '2026-05-20T14:00:00-04:00'"),
        end_time: z.string()
          .describe("End as ISO 8601, e.g. '2026-05-20T14:30:00-04:00'"),
        title: z.string().optional().describe("Appointment title"),
        appointment_status: z
          .enum(["new", "confirmed", "cancelled", "showed", "noshow"])
          .optional()
          .describe("Appointment status (default: new)"),
        notes: z.string().optional().describe("Notes for the appointment"),
      },
    },
    async ({
      calendar_id,
      contact_id,
      start_time,
      end_time,
      title,
      appointment_status,
      notes,
    }) => {
      const body = {
        locationId: GHL_LOCATION_ID,
        calendarId: calendar_id,
        contactId: contact_id,
        startTime: start_time,
        endTime: end_time,
      };
      if (title) body.title = title;
      if (appointment_status) body.appointmentStatus = appointment_status;
      if (notes) body.notes = notes;
      return text(
        await ghlFetch(`/calendars/events/appointments`, {
          version: "2021-04-15",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      );
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
  console.log(`GoHighLevel MCP server v3.0 running on port ${PORT}`);
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    console.warn(
      "WARNING: GOHL_API_KEY or GOHL_ACCOUNT_ID is not set — tool calls will fail until they are."
    );
  }
});
