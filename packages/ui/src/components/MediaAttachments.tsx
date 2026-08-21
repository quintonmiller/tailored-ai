/**
 * Media attached to a message.
 *
 * An image renders inline; anything else gets a labelled link. The two are
 * genuinely different affordances rather than one with a fallback: a
 * screenshot is meant to be looked at in place, and a 40 MB PDF is not.
 *
 * Every `src` here points at this deployment's own `/api/media/:id`, which is
 * what the CSP's `img-src 'self' data:` admits. That is not incidental — the
 * whole reason images are safe to render is that they cannot be fetched from
 * anywhere else.
 */

import { useState } from "react";
import { formatBytes, isImage, type MediaRef, mediaSrc } from "../lib/content.js";

export function MediaAttachments(props: { media: MediaRef[]; compact?: boolean }) {
  if (props.media.length === 0) return null;
  return (
    <div className={`media-attachments${props.compact ? " compact" : ""}`}>
      {props.media.map((ref) => (
        <MediaItem key={ref.id} media={ref} />
      ))}
    </div>
  );
}

function MediaItem({ media }: { media: MediaRef }) {
  const [failed, setFailed] = useState(false);

  if (isImage(media) && !failed) {
    return (
      <figure className="media-item media-image">
        <a href={mediaSrc(media)} target="_blank" rel="noopener noreferrer">
          <img
            src={mediaSrc(media)}
            alt={media.name ?? "attached image"}
            // Known dimensions reserve the space before the bytes arrive, so a
            // transcript does not jump as images load.
            width={media.width}
            height={media.height}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        </a>
        {media.name ? <figcaption>{media.name}</figcaption> : null}
      </figure>
    );
  }

  // Either not an image, or one whose blob has been swept by retention. Both
  // deserve a visible row rather than a silent gap — an attachment that is gone
  // is information.
  return (
    <a className="media-item media-file" href={mediaSrc(media)} target="_blank" rel="noopener noreferrer">
      <span className="media-file-name">{media.name ?? media.mimeType}</span>
      <span className="media-file-meta">
        {media.mimeType} · {formatBytes(media.bytes)}
        {failed ? " · unavailable" : ""}
      </span>
    </a>
  );
}
