# keycrm-mcp

An [MCP](https://modelcontextprotocol.io) server for the API of [KeyCRM](https://keycrm.app), a Ukrainian CRM for trade and service businesses. It lets an AI assistant such as Claude answer questions about your orders, buyers and pipelines, and, only if you explicitly allow it, register a new lead as a pipeline card.

Українською: [README.uk.md](README.uk.md)

> **Unofficial.** This project is not affiliated with or endorsed by KeyCRM. "KeyCRM" is a trademark of its owner. Use it at your own risk.

> **Status: 0.1.0, not yet verified on a live KeyCRM account.** The server is built from the official [OpenAPI document](https://docs.keycrm.app/api.yaml) (version 1.2.0). All tests run against a mocked HTTP layer and check every request against a snapshot of that document. Nobody has run it with a real API key yet. See [Limitations](#limitations).

## What it is for

- **Reading.** "What came in today and what is not paid yet?", "Find the orders of +380501234567", "Which leads are still in the first stage?" The assistant reads orders, buyers and pipeline cards and answers in plain words.
- **Registering a lead.** A chat bot or a voice agent that talked to a prospect can put the contact and a summary of the conversation into a pipeline, where your managers pick it up. This is the only thing the server can write, and only after you switch it on.

The server does not change or delete anything that already exists in the CRM: it has no tool for that.

## Quick start

You need Node.js 20 or newer and an **API key** of your KeyCRM account. KeyCRM explains where to get it in its [help centre](https://help.keycrm.app/uk/process-automation-api-and-more/where-to-get-an-api-key).

> **Not on npm yet.** Until the first release is published, the `npx -y @myradostudio/keycrm-mcp` commands below will not work. Run the server from source instead: `git clone https://github.com/myradostudio/keycrm-mcp`, then `npm install` and `npm run build` in that folder, and use `"command": "node"` with `"args": ["/absolute/path/to/keycrm-mcp/dist/index.js"]` in the configurations below.

### Claude Desktop

Add the server to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "keycrm": {
      "command": "npx",
      "args": ["-y", "@myradostudio/keycrm-mcp"],
      "env": {
        "KEYCRM_API_KEY": "your API key"
      }
    }
  }
}
```

If the server does not start on Windows, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "@myradostudio/keycrm-mcp"]`.

### Claude Code

```bash
claude mcp add --transport stdio \
  --env KEYCRM_API_KEY=your-api-key \
  keycrm -- npx -y @myradostudio/keycrm-mcp
```

### Cursor

Add the same block to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "keycrm": {
      "command": "npx",
      "args": ["-y", "@myradostudio/keycrm-mcp"],
      "env": {
        "KEYCRM_API_KEY": "your API key"
      }
    }
  }
}
```

Any other MCP client that can start a local stdio server works the same way: run `npx -y @myradostudio/keycrm-mcp` with the environment variables below.

Then ask, for example:

- "Show yesterday's orders with buyers and totals. Which ones are not paid?"
- "Is there a buyer with the phone +380501234567? What did they order?"
- "What pipelines do we have, and how many leads are in each stage of the first one?"
- With the write tool enabled: "Register a lead: Iryna, +380501234567, asked about wholesale prices, call back tomorrow at 10."

## Configuration

The server is configured with environment variables only. It validates them at startup and exits with an explanation on stderr if something is wrong.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KEYCRM_API_KEY` | yes | | API key of your KeyCRM account. The key alone, without `Bearer`. |
| `KEYCRM_API_URL` | no | `https://openapi.keycrm.app` | API origin. Must be `https://` (plain `http://` is accepted for localhost only). |
| `KEYCRM_ALLOW_WRITE` | no | off | Set to `1` to register the write tool. Any other value than `1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off` stops the server. |

## Tools

Every date and time in KeyCRM is **UTC**. Date arguments take ISO 8601 with a UTC offset (for example `2026-10-01T00:00:00+03:00`) and the server converts them to UTC; results come back in UTC as KeyCRM sends them. Money amounts are plain numbers in the currency of the order source, not in minor units. The server tells the model so.

### Read tools (always available)

| Tool | What it returns | API call |
| --- | --- | --- |
| `list_orders` | Orders with totals, payment status and dates; filters by status, source, buyer phone or e-mail, payment status, tracking code and periods | `GET /order` |
| `get_order` | One order in full | `GET /order/{orderId}` |
| `list_order_statuses` | Active order statuses | `GET /order/status` |
| `list_order_sources` | Sources of orders and leads with their currency | `GET /order/source` |
| `list_buyers` | Buyers; filters by id, phone, e-mail and periods | `GET /buyer` |
| `get_buyer` | One buyer in full | `GET /buyer/{buyerId}` |
| `list_pipelines` | Pipelines of the account | `GET /pipelines` |
| `list_pipeline_statuses` | Stages of one pipeline with the number of leads in each | `GET /pipelines/{pipelineId}/statuses` |
| `list_pipeline_cards` | Pipeline cards (leads); filters by pipeline, stage, source and periods | `GET /pipelines/cards` |
| `get_pipeline_card` | One pipeline card in full | `GET /pipelines/cards/{cardId}` |
| `list_users` | Users of the account, i.e. managers | `GET /users` |

All paths are relative to `https://openapi.keycrm.app/v1`.

List tools return compact summaries and a `pagination` block. The page size defaults to 15, the default of the API, and is capped at 50, its maximum; `next_page` tells the model how to continue.

Related data is returned only when asked for with `include`, exactly as in the API: for example `["buyer", "status", "products.offer"]` for orders, or `["contact.client", "status"]` for pipeline cards. The `get_*` tools offer every value the document lists as allowed, and a test keeps the two lists equal. The list tools offer only the values their summaries show, so a request is never spent on data that would be dropped: delivery addresses come with `get_buyer`, UTM marks and custom fields with `get_order` and `get_pipeline_card`.

### Write tool (only with `KEYCRM_ALLOW_WRITE=1`)

| Tool | What it does | API call |
| --- | --- | --- |
| `create_pipeline_card` | Creates a card in a pipeline: a lead with its contact, title, comment for the manager, source, responsible manager, next contact time, UTM marks and custom fields | `POST /pipelines/cards` |

The contact is given either as a name with a phone or an e-mail, or as the id of an existing buyer. Without a pipeline id KeyCRM uses the first pipeline of the list.

## Safety model

A CRM holds your customers' personal data and your managers act on what appears in it, so the server is conservative by design.

- **Read-only unless you opt in.** Without `KEYCRM_ALLOW_WRITE=1` the write tool is not registered at all: the model cannot see or call it. Every read tool issues only `GET` requests, and a test enforces that.
- **Nothing existing can be changed.** There is no tool that updates or deletes an order, a buyer or a card.
- **Honest annotations.** Read tools carry `readOnlyHint: true`. `create_pipeline_card` adds a record and is marked as a non-destructive, non-idempotent write. Whether and how confirmation is shown is up to your MCP client; keep per-call approval switched on for the write tool.
- **Strict input.** Every tool rejects arguments it does not know, so a filter the API does not have is never silently ignored. A period needs both ends, and a date that does not exist (31 April) is refused instead of rolling over into the next month. A contact needs a phone, an e-mail or a buyer id; a name alone is not enough.
- **No blind retries.** The server never repeats a request on its own. If creating a card ends without a definite answer (a timeout, a broken connection, a gateway error, HTTP 429, an unreadable response), the tool says that the outcome is unknown and how to check it. KeyCRM documents no way to make this request safe to repeat, so a blind retry could create the same lead twice.
- **Stays within the documented rate.** KeyCRM allows 20 requests per minute for one API key. The server counts its own requests: when the limit is reached it waits up to five seconds for a free moment, and beyond that the tool reports when to try again instead of sending.
- **The key stays local.** It is read from an environment variable, used only for requests to `KEYCRM_API_URL`, and never written to stdout or stderr. Every answer of the API is cleaned of the key before anything is built from it, so it cannot reach a tool result either. Redirects are not followed, so neither the key nor a request body can end up on another host.
- **Less data to the model.** List tools return summaries. An order or a card shows its buyer or contact person only when the model asks for it with `include`; `list_buyers` is a list of customers and returns their names, phones and e-mail addresses by nature. `get_order`, `get_buyer` and `get_pipeline_card` return full records.
- **No telemetry, no logging of business data.** stderr gets only startup messages (configuration problems and a one-line banner with the mode) and the type of a transport error. Requests and responses are never logged.

Two things the server cannot do for you. First, whatever a tool returns is sent to the AI model you use and to its provider; orders and buyers are personal data, so decide whether that is acceptable and lawful for your customers. Second, comments, names and titles stored in KeyCRM reach the model as-is and could contain instructions written by someone else (prompt injection); a buyer's comment is typed by your customer. That is one more reason to approve every write call yourself.

## Limitations

- **Not verified on a live account.** Requests are checked against the OpenAPI document, which describes shapes, not behaviour. Response handling and error texts are implemented from the documentation. The [live check](#live-check) is there to find out; it has not been run on a real account yet.
- **Filters come from the examples of the document.** KeyCRM declares `filter` as a free-form object and shows the available fields only in examples. The server offers exactly those fields. How each one matches (exact or partial, how a phone number has to be written) is not documented and has to be checked on a live account.
- **A period needs both ends.** The filters are ranges (`created_between`, `updated_between`, `shipping_between`), so a tool wants a start and an end.
- **The key is the whole account.** The document describes no scopes for an API key.
- **Not covered:** creating or changing orders and buyers, moving a card to another stage, payments and expenses, products, stock, companies, tags, files, calls, custom field definitions, webhooks.
- **`create_pipeline_card` does not send products or payments**, although the API accepts them.
- **`get_pipeline_card`.** The document describes the answer for a single card as a paginated list. The server returns the record of that list whose id is the one asked for, accepts a bare object as well, and reports an error rather than present another card as the requested one.
- **Error details.** The document shows only `{"message": "…"}` for an error. If KeyCRM sends a map of field errors under `errors`, the server lists it; that part is a guess about an undocumented format and is shown only when present.
- **Pacing is per server process.** KeyCRM counts requests per API key. Other programs that use the same key spend the same allowance, so the API can still refuse a request.
- **One account per server instance.**
- **Fixed 30-second timeout** per request.

## Live check

Nobody has run this server on a live account yet (see the status at the top). `npm run live-check` is how to do it: it starts the built server the way an MCP host does and calls every read tool with every argument it has. The values for the filters (a status, a source, a phone, a period) come from the records your account already holds, so every filtered list has to bring back the record the values were taken from, and nothing that does not fit them. That is how the open questions of [Limitations](#limitations) get an answer: whether a phone is matched the way it is stored, whether the periods are really UTC. Each check prints one line, `PASS`, `FAIL` or `SKIP`, and the exit code is 1 when anything failed.

```bash
npm run live-check    # read tools only; nothing is created
```

The key is taken from `KEYCRM_API_KEY`; when that is not set, the script asks for it and the input is hidden. The key reaches the server through its environment, so it is neither in the command nor in the shell history, and the output is cleaned of it. The output holds counts and field names, not what your orders, buyers and cards hold. The exception is the list of pipelines with their ids and names, which the write check below needs.

The run sends 19 requests, one less than KeyCRM allows per minute for one key, so wait a minute before running it again. When the limit is used up, the script stops and says so.

**Creating a card is a separate run that you have to ask for:**

```bash
node scripts/live-check.mjs --create-card --pipeline-id 3
```

KeyCRM has no API operation that deletes a pipeline card: its OpenAPI document (version 1.2.0) deletes only a tag or an attachment. The card this run creates therefore stays in the pipeline until somebody deletes it by hand. That is why the pipeline has to be named, and why the script says so and waits for `yes` before it creates anything. The card is titled "MCP live check" with the date and "delete this card", has a made-up contact (`live-check@example.com`), no manager and no source. The script reads it back, checks that it is in the pipeline you named and looks it up by the time of its creation. The read checks are not part of this run; it needs a build, so run `npm run build` or `npm run live-check` before it.

## Development

```bash
npm install
npm run lint          # tsc --noEmit over src/ and tests/
npm test              # builds dist/ and the tests, then runs them with node:test
npm run spec:update   # refreshes the OpenAPI snapshot from docs.keycrm.app
npm run live-check    # runs every read tool against the real API (asks for a key)
```

- `src/endpoints.ts` is the catalogue of API operations the server calls. `tests/spec.test.ts` compares it with `spec/keycrm-api.snapshot.json`, a reduced copy of the official OpenAPI document (parameters, request schemas, filter names and allowed `include` values of those operations only).
- Every tool test calls the tool through a real MCP client. When a test ends, each request it recorded goes through `assertMatchesSpec`, which checks the path, query parameters, filters, headers and body against that snapshot.
- `tests/e2e.test.ts` starts the built server as a child process over stdio against a local HTTP mock.
- `scripts/live-check.mjs` is the [live check](#live-check). `tests/live-check.test.ts` runs it against a local stand-in for the API that keeps a small account, checks every request it causes against the snapshot, and covers the cases in which it has to fail, in which nothing may be created, and in which the key must not reach the output.
- To poke at the server by hand: `npx @modelcontextprotocol/inspector node dist/index.js`.

The server uses the official TypeScript SDK ([`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server)) and `zod`; there are no other runtime dependencies.

Issues and pull requests are welcome. For security reports see [SECURITY.md](SECURITY.md).

## Built by

Built and maintained by [Myrado Studio](https://myradostudio.com) — custom MCP servers, AI agents and automation. Need an MCP server for your own system? https://myradostudio.com/en/mcp-server-development/

## License

[MIT](LICENSE) © 2026 Myrado Studio
