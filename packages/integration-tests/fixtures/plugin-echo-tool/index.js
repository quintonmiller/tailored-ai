// Fixture plugin for the e2e plugin-load scenario. Demonstrates the
// register(ctx) contract added in #47: the plugin has zero runtime
// dependency on @tailored-ai/core. Type imports (when written in
// TypeScript) would erase at compile time; this is plain JS so there's
// nothing to erase.
//
// The marker log line is what the scenario greps for to confirm the
// register function actually ran with a real ctx.

export default (ctx) => {
  console.log("[plugin-echo-tool] register called");

  ctx.tools.register("echo_tool", () => [
    {
      name: "echo_tool",
      description: "Echoes the provided text back to the caller. Used by the e2e plugin-load fixture.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Text to echo" } },
        required: ["text"],
      },
      execute: async (args) => ({ success: true, output: String(args.text ?? "") }),
    },
  ]);

  console.log("[plugin-echo-tool] registered echo_tool");
};
