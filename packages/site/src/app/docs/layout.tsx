import { DocsPager } from "@/components/DocsPager";
import { DocsSidebar } from "@/components/DocsSidebar";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[76rem] px-6 py-10 lg:py-16">
      <div className="flex flex-col gap-6 lg:flex-row lg:gap-16">
        <aside className="w-full shrink-0 lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:w-60 lg:self-start lg:overflow-y-auto lg:pr-4">
          <DocsSidebar />
        </aside>
        <article className="prose prose-invert min-w-0 max-w-[52rem] flex-1">
          {children}
          <DocsPager />
        </article>
      </div>
    </div>
  );
}
