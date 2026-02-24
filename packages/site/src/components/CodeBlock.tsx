export function CodeBlock({ children, language }: { children: string; language?: string }) {
  return (
    <div className="group relative rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      {language && (
        <div className="border-b border-[var(--color-border)] px-4 py-1.5 text-xs text-[var(--color-text-muted)]">
          {language}
        </div>
      )}
      <pre className="overflow-x-auto p-4 text-sm leading-relaxed">
        <code>{children}</code>
      </pre>
    </div>
  );
}
