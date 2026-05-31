import createMDX from "@next/mdx";
import remarkGfm from "remark-gfm";

const withMDX = createMDX({
  options: {
    remarkPlugins: [remarkGfm],
  },
});

const nextConfig = {
  pageExtensions: ["ts", "tsx", "mdx"],
  output: "export" as const,
  basePath: "/tailored-ai",
  images: { unoptimized: true },
};

export default withMDX(nextConfig);
