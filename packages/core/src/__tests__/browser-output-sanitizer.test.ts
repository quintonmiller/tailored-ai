import { describe, expect, it } from "vitest";
import { sanitizeAltText, sanitizeBrowserOutput, sanitizeToolResult } from "../tools/browser-output-sanitizer.js";

describe("sanitizeBrowserOutput", () => {
  // ---------- PAN (Luhn-checked) ----------

  it("redacts a valid Luhn card number (16 digits)", () => {
    const input = "My card is 4111111111111111";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("My card is [REDACTED-PAN]");
  });

  it("redacts a valid Luhn card number with spaces in surrounding text", () => {
    const input = "Card: 4111111111111111 exp 12/25";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("Card: [REDACTED-PAN] exp 12/25");
  });

  it("does NOT redact a 16-digit number that fails Luhn", () => {
    const input = "Order number 1234567890123456";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("Order number 1234567890123456");
  });

  it("redacts a 13-digit Luhn-valid PAN", () => {
    // 4222222222222 is a known Luhn-valid 13-digit test number
    const input = "Card 4222222222222";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("Card [REDACTED-PAN]");
  });

  // ---------- SSN ----------

  it("redacts an SSN", () => {
    const input = "SSN: 123-45-6789";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("SSN: [REDACTED-SSN]");
  });

  it("redacts multiple SSNs", () => {
    const input = "SSNs: 111-22-3333 and 444-55-6666";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("SSNs: [REDACTED-SSN] and [REDACTED-SSN]");
  });

  // ---------- IBAN ----------

  it("redacts an IBAN", () => {
    const input = "IBAN: DE89370400440532013000";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("IBAN: [REDACTED-IBAN]");
  });

  it("redacts a UK IBAN", () => {
    const input = "Account GB29NWBK60161331926819";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("Account [REDACTED-IBAN]");
  });

  // ---------- US Phone ----------

  it("redacts a US phone number (parens)", () => {
    const input = "Call (555) 123-4567";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("Call [REDACTED-PHONE]");
  });

  it("redacts a US phone number (dashes)", () => {
    const input = "Call 555-123-4567";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("Call [REDACTED-PHONE]");
  });

  it("redacts a US phone number (dots)", () => {
    const input = "Call 555.123.4567";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("Call [REDACTED-PHONE]");
  });

  it("redacts a US phone number (plain 10 digits)", () => {
    const input = "Call 5551234567";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("Call [REDACTED-PHONE]");
  });

  // ---------- Email ----------

  it("redacts an email address", () => {
    const input = "Email me at user@example.com";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("Email me at [REDACTED-EMAIL]");
  });

  it("redacts multiple emails", () => {
    const input = "Contact a@b.com or c@d.org";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("Contact [REDACTED-EMAIL] or [REDACTED-EMAIL]");
  });

  // ---------- Address (heuristic) ----------

  it("redacts a US street address", () => {
    const input = "123 Main St";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("[REDACTED-ADDRESS]");
  });

  it("redacts an address with city/state/zip", () => {
    const input = "456 Oak Ave, Springfield IL 62704";
    const out = sanitizeBrowserOutput(input);
    expect(out).toContain("[REDACTED-ADDRESS]");
  });

  it("redacts a Blvd address", () => {
    const input = "789 Sunset Blvd";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("[REDACTED-ADDRESS]");
  });

  // ---------- Non-sensitive text passes through ----------

  it("does not modify plain text", () => {
    const input = "Hello world, this is a normal sentence.";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("Hello world, this is a normal sentence.");
  });

  it("does not modify URLs", () => {
    const input = "Visit https://example.com for more info";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("Visit https://example.com for more info");
  });

  it("does not modify short numbers", () => {
    const input = "I have 3 cats and 2 dogs";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("I have 3 cats and 2 dogs");
  });

  it("handles empty string", () => {
    expect(sanitizeBrowserOutput("")).toBe("");
  });

  it("handles mixed sensitive content", () => {
    const input = "Card 4111111111111111, SSN 123-45-6789, email user@example.com";
    const out = sanitizeBrowserOutput(input);
    expect(out).toBe("Card [REDACTED-PAN], SSN [REDACTED-SSN], email [REDACTED-EMAIL]");
  });
});

describe("sanitizeAltText", () => {
  it("delegates to sanitizeBrowserOutput", () => {
    const input = "Card number 4111111111111111";
    expect(sanitizeAltText(input)).toBe("Card number [REDACTED-PAN]");
  });
});

describe("sanitizeToolResult", () => {
  it("sanitizes output and error fields", () => {
    const result = {
      success: true,
      output: "Card 4111111111111111 found on page",
      error: "SSN 123-45-6789 leaked in error",
    };
    const sanitized = sanitizeToolResult(result);
    expect(sanitized.success).toBe(true);
    expect(sanitized.output).toBe("Card [REDACTED-PAN] found on page");
    expect(sanitized.error).toBe("SSN [REDACTED-SSN] leaked in error");
  });

  it("preserves success flag", () => {
    const result = { success: false, output: "no sensitive data" };
    const sanitized = sanitizeToolResult(result);
    expect(sanitized.success).toBe(false);
    expect(sanitized.output).toBe("no sensitive data");
  });

  it("handles missing error field", () => {
    const result = { success: true, output: "clean" };
    const sanitized = sanitizeToolResult(result);
    expect(sanitized.error).toBeUndefined();
  });
});
