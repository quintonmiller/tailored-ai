---
"@tailored-ai/core": patch
---

Built-in tools now construct through the tool-factory registry, not an if-chain in createTools(). Every tool — memory, exec, read, write, web_fetch, web_search, facts, recall, tasks/task_query, notify_owner, claude_code, browser, md_to_pdf, projects, documents, extract_document, ask_user, and custom_tools — registers a factory in tools/builtin.ts on module load, identically to how external plugin tools register. createTools() is now a pure registry walk. The META_TOOL_NAMES constant replaces the hardcoded array in validateConfig. Zero behavior change: tool sets, constructor args, and config shapes are preserved exactly.
