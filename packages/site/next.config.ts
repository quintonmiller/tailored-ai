import createMDX from "@next/mdx";

const withMDX = createMDX({});

const nextConfig = {
  pageExtensions: ["ts", "tsx", "mdx"],
  output: "export" as const,
  basePath: "/tailored-ai",
  images: { unoptimized: true },
};

export default withMDX(nextConfig);
