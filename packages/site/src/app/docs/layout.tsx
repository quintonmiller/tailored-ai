import { DocsSidebar } from "@/components/DocsSidebar";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex flex-col gap-10 lg:flex-row">
        <aside className="w-full shrink-0 lg:w-56">
          <DocsSidebar />
        </aside>
        <article className="prose prose-invert min-w-0 max-w-none flex-1">{children}</article>
      </div>
    </div>
  );
}
