import { useEffect, useState } from "react";
import { fetchSuggestions, type SuggestionsResponse } from "../api";

/**
 * Chat empty-state suggestion chips. Renders nothing until `GET
 * /api/suggestions` confirms the feature is enabled AND returned at least two
 * usable suggestions — so non-users (and the empty/garbage case) see the
 * unchanged empty state. When ready, shows a wrap row of ghost-button chips;
 * clicking one sends that text via the supplied `onPick`.
 *
 * The fetch is silent while in flight: the caller's plain empty text shows
 * first and the chips fade in when ready, so there's no layout jolt on a slow
 * model.
 */
export function SuggestionChips({ onPick }: { onPick: (text: string) => void }) {
  const [state, setState] = useState<SuggestionsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSuggestions()
      .then((r) => {
        if (!cancelled) setState(r);
      })
      .catch(() => {
        // Network/disabled failures hide the chips rather than show an error.
        if (!cancelled) setState({ enabled: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Disabled, failed, still loading, or fewer than two usable suggestions →
  // render nothing so the caller's plain empty state stands.
  if (!state?.enabled || state.suggestions.length < 2) return null;

  return (
    <div className="chat-suggestions" role="group" aria-label="Suggested prompts">
      {state.suggestions.map((text) => (
        <button key={text} type="button" className="chat-suggestion-chip" onClick={() => onPick(text)}>
          {text}
        </button>
      ))}
    </div>
  );
}
