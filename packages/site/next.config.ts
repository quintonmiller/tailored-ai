import createMDX from "@next/mdx";

const withMDX = createMDX({});

const nextConfig = {
  pageExtensions: ["ts", "tsx", "mdx"],
  output: "standalone" as const,
};

export default withMDX(nextConfig);
