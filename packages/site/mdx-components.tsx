import type { MDXComponents } from "mdx/types";
import { CodeBlock } from "@/components/CodeBlock";

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    pre: ({ children, ...props }) => {
      const codeElement = children as React.ReactElement<{ children: string; className?: string }>;
      if (codeElement?.props?.children) {
        const lang = codeElement.props.className?.replace("language-", "") || "";
        return <CodeBlock language={lang}>{codeElement.props.children}</CodeBlock>;
      }
      return <pre {...props}>{children}</pre>;
    },
    ...components,
  };
}
