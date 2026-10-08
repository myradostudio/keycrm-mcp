# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Write to **hello@myradostudio.com** with a description, the affected version and, if you can, steps to reproduce.

Never include a real API key or customer data in a report. If a key has been exposed, replace it in KeyCRM; the [help centre article about API keys](https://help.keycrm.app/uk/process-automation-api-and-more/where-to-get-an-api-key) is the place to start.

## Supported versions

Only the latest published version receives fixes.

## What the server does with your data

- The API key (`KEYCRM_API_KEY`) is read from an environment variable and sent only to the API origin in `KEYCRM_API_URL` (by default `https://openapi.keycrm.app`). Plain `http://` is refused for anything but localhost.
- Nothing is written to disk. stderr receives startup messages and the type of a transport error; requests, responses, the key and customer data are never logged. There is no telemetry.
- Tool results go to the MCP client and from there to the AI model you use. Orders, buyers and pipeline cards contain personal data of your customers: names, phone numbers, e-mail addresses and delivery addresses.

## Things to keep in mind

- The API key opens the whole account to the server: the KeyCRM document describes no way to limit a key to some sections. The server uses it for the twelve operations listed in the README and nothing else.
- `KEYCRM_ALLOW_WRITE=1` lets the connected AI model create lead cards that your managers will see and act on. Keep per-call confirmation enabled in your MCP client.
- Your MCP client stores the environment variables you give it, usually in a plain-text configuration file. Protect that file like any other credential store.
- Text stored in KeyCRM (comments of buyers and managers, product names, card titles) is passed to the model unchanged and can carry prompt-injection attempts. A comment field is filled in by your customers.
- This is an unofficial project. It is not affiliated with or endorsed by KeyCRM.
