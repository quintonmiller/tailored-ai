import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("yaml", yaml);

const LANGUAGE_ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  yml: "yaml",
};

function highlightedCode(source: string, language?: string): string | undefined {
  if (!language) return undefined;

  const resolvedLanguage = LANGUAGE_ALIASES[language] ?? language;
  if (!hljs.getLanguage(resolvedLanguage)) return undefined;

  return hljs.highlight(source, {
    language: resolvedLanguage,
    ignoreIllegals: true,
  }).value;
}

export function CodeBlock({ children, language }: { children: string; language?: string }) {
  const highlighted = highlightedCode(children, language);

  return (
    <div className="docs-code-block">
      {language ? <div className="docs-code-language">{language}</div> : null}
      <pre>
        {highlighted ? (
          <code
            className={`hljs language-${LANGUAGE_ALIASES[language ?? ""] ?? language}`}
            // highlight.js escapes source text before adding token spans.
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <code>{children}</code>
        )}
      </pre>
    </div>
  );
}
