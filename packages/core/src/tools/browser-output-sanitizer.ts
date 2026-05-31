/**
 * TAI re-export of the framework-agnostic output sanitiser. The
 * canonical implementation lives in `@tailored-ai/browser-mediator`.
 * The TAI-specific function names (`sanitizeBrowserOutput`,
 * `sanitizeAltText`, `sanitizeToolResult`) are kept as thin
 * forwarders so existing call-sites continue to work.
 */
import { sanitizeOutput } from "@tailored-ai/browser-mediator";

export function sanitizeBrowserOutput(text: string): string {
  return sanitizeOutput(text);
}

export function sanitizeAltText(alt: string): string {
  return sanitizeOutput(alt);
}

export function sanitizeToolResult(result: { success: boolean; output: string; error?: string }): {
  success: boolean;
  output: string;
  error?: string;
} {
  return {
    success: result.success,
    output: sanitizeBrowserOutput(result.output),
    error: result.error !== undefined ? sanitizeBrowserOutput(result.error) : undefined,
  };
}
