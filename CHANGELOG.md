# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-08

First release. Built from the KeyCRM OpenAPI document version 1.2.0; not yet verified on a live KeyCRM account.

### Added

- stdio MCP server, started with `npx -y @myradostudio/keycrm-mcp`, configured with environment variables.
- Authorization with the API key of a KeyCRM account.
- 11 read-only tools: `list_orders`, `get_order`, `list_order_statuses`, `list_order_sources`, `list_buyers`, `get_buyer`, `list_pipelines`, `list_pipeline_statuses`, `list_pipeline_cards`, `get_pipeline_card`, `list_users`.
- 1 write tool, registered only with `KEYCRM_ALLOW_WRITE=1`: `create_pipeline_card`.
- Request pacing within the documented limit of 20 requests per minute for one API key, a request timeout, no following of redirects, pagination with the API default of 15 and its maximum of 50, API errors returned as tool errors with the message of the API.
- Date arguments take ISO 8601 with a UTC offset and are converted to UTC, which is what KeyCRM works in.
- The write tool reports an unknown outcome (timeout, gateway error, unreadable response) together with the way to check it, instead of inviting a blind retry.
- `server.json` for the MCP registry.
- Tests with a mocked HTTP layer that check every request against a snapshot of the official OpenAPI document, and an end-to-end test over stdio.

[0.1.0]: https://github.com/myradostudio/keycrm-mcp/releases/tag/v0.1.0
