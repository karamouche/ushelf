# Remote client compatibility check

Checked on 2026-09-23 (macOS). This records what was actually verified, rather than implying a live connector test.

| Client          | Installed version | Verified here                                                                                     | Still requires a live HTTPS deployment                    |
| --------------- | ----------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Codex CLI       | 0.156.1           | `ushelf setup codex --print` emitted the expected user-scope `codex mcp add` command              | Run the MCP bridge against an authorized remote           |
| Claude Code     | 2.1.212           | `ushelf setup claude-code --print` emitted the expected user-scope `claude mcp add` command       | Run the MCP bridge against an authorized remote           |
| ChatGPT Desktop | 26.917.62051      | Version inspected; `/connections` and `setup chatgpt` provide the MCP URL and instructions        | Add the custom connector, complete OAuth, and call a tool |
| Claude Desktop  | 1.22209.0         | Version inspected; `/connections` and `setup claude-desktop` provide the MCP URL and instructions | Add the custom connector, complete OAuth, and call a tool |

The OAuth discovery and MCP challenge are covered by automated server tests. No public HTTPS origin was available in this workspace, so direct desktop OAuth approval and end-to-end remote tool calls were not manually verified. Recheck client menu labels and complete the live tests on the first deployment.
