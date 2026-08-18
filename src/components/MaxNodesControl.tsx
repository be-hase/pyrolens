import { useEffect, useId, useRef, useState } from 'react';
import { Slider } from '@components/core/Slider';
import { parseMaxNodes } from '@api/client';
import { useDebouncedValue } from '@hooks/useDebouncedValue';
import { useEditBuffer } from '@hooks/useEditBuffer';
import { navigate, pushGenerationNow, useRoute } from '../urlState';
import './MaxNodesControl.css';

const TOOLTIP =
  'Caps flame graph detail per query — lower is lighter and faster; ' +
  "Default uses the server's own limit.";

// Trailing debounce before a commit reaches the URL. Slider's onCommit
// fires once per native `change` event, and keyboard auto-repeat dispatches
// one of those per repeat tick while an arrow key is held — undebounced,
// each tick would push its own history entry and refire every range-keyed
// fetch (AGENTS.md: one navigation per burst, the flame graph search is the
// model). A held key or a released drag therefore commits once, after the
// burst has been quiet for this long; a lone press/release still commits,
// just after this delay instead of immediately.
const COMMIT_DEBOUNCE_MS = 350;

// Discrete presets, ascending. Default sits at the LEFT end (index 0, no
// maxNodes param), PRESETS[0..7] fill indexes 1..8 — not the more obvious
// "Default trails the ascending presets" layout — so that fiddling with the
// slider (an accidental drag, a stray key) biases toward a SMALLER cap, or
// none at all, never a larger one: index 0 is a hard stop (native range
// input already refuses to go below `min`; MaxNodesControl.test.tsx pins
// this), and every step right only ever increases the cap or leaves Default
// behind. The slider itself moves over indexes (0..PRESETS.length), not the
// node counts, so a plain <input type="range"> with step 1 is enough.
const PRESETS = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const LABELS = ['Default', '512', '1k', '2k', '4k', '8k', '16k', '32k', '64k'];
const DEFAULT_INDEX = 0;

// Maps a resolved maxNodes value to its slider index (PRESETS[i] lives at
// slider index i+1 — see the layout note above). An exact preset match
// lands on its own slot; anything else — a hand-edited URL, or a value the
// classic UI wrote — snaps to the closest preset rather than reporting
// "Default" for a cap that is, in fact, still being sent to the server.
function indexForMaxNodes(maxNodes: number | undefined): number {
  if (maxNodes === undefined) return DEFAULT_INDEX;
  let best = 0;
  let bestDiff = Infinity;
  PRESETS.forEach((preset, i) => {
    const diff = Math.abs(preset - maxNodes);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  });
  return best + 1;
}

// Max nodes slider, rendered in ControlsBar on the flame-graph views (Single,
// Comparison, Diff — Tag Explorer has no flame graph, so it does not render
// this). Reuses parseMaxNodes so "absent or invalid means Default" lives in
// one place (src/api/client.ts) instead of being re-derived here.
//
// Dragging must not navigate per tick (AGENTS.md: every param write is a
// refresh for a relative range) — the position is a local draft, an edit
// buffer anchored to the *resolved index* of the committed URL value rather
// than the raw param string, so a URL change that still resolves to the same
// index does not spuriously reset an in-progress drag.
export function MaxNodesControl() {
  const labelId = useId();
  const { params } = useRoute();
  const committedIndex = indexForMaxNodes(
    parseMaxNodes(params.get('maxNodes')),
  );

  const [draftStr, setDraftStr] = useEditBuffer(String(committedIndex));
  const draftIndex = Number(draftStr);

  // Slider's onCommit (the native `change` event) only means "the user's
  // intent moved" — it does not write to the URL directly. Each commit is
  // captured as an object — `index` plus `baseline` (committedIndex at the
  // moment it was requested) and a unique `gen` — and fed through
  // useDebouncedValue so a burst of commits (a held key) collapses into one
  // navigation once it has been quiet for COMMIT_DEBOUNCE_MS. A fresh object
  // per commit (not e.g. just the index) is what lets a repeated pick of the
  // same index later be told apart from "already handled" below.
  const [pending, setPending] = useState<{
    index: number;
    baseline: number;
    gen: number;
    // urlState.ts's push generation as of the commit — see its doc for the
    // doctrine. `baseline` alone misses the case that motivated this: a
    // Reset-shaped push that clears every OTHER param but leaves maxNodes
    // absent both before and after (it was never present to begin with)
    // resolves to the same DEFAULT_INDEX baseline on both sides, so the
    // baseline check alone can't tell the context moved.
    pushGen: number;
  } | null>(null);
  const debouncedPending = useDebouncedValue(pending, COMMIT_DEBOUNCE_MS);
  const commitGeneration = useRef(0);
  // Last `gen` actually acted on. A ref, not state: it only needs to survive
  // across renders to stop the effect below from re-navigating for a commit
  // it already handled (committedIndex changing again later would otherwise
  // re-run the effect against the same settled `pending`) — never to cause a
  // render itself, so mutating it here doesn't fall under
  // react-hooks/set-state-in-effect the way clearing `pending` via a setState
  // call from inside the effect did before this rewrite.
  const handledGeneration = useRef(0);

  useEffect(() => {
    // Nothing pending, or the debounce hasn't caught up to the latest tick
    // yet — a later commit already replaced `pending` with a new object, so
    // this render has nothing to act on (the next one will, once
    // debouncedPending catches up).
    if (!pending || debouncedPending !== pending) return;
    if (handledGeneration.current === pending.gen) return;
    handledGeneration.current = pending.gen;
    // The URL's maxNodes moved between the commit and now (another tab,
    // Back, a deep link landing mid-debounce) — useEditBuffer already reset
    // `draftStr` to follow it, and applying this commit would silently
    // stomp that external change with a value picked against a world that
    // no longer exists. `baseline` was captured at commit time, not read
    // fresh here, so this comparison can actually tell a stale commit apart
    // from a legitimate "different from committed" one — two live reads of
    // committedIndex could never do that.
    if (pending.baseline !== committedIndex) return;
    // A push (Reset view, Back, a deep link landing mid-debounce) happened
    // since this commit was made — the user's context moved, and this
    // commit was decided in the one that no longer exists. See the pushGen
    // field's comment above and urlState.ts's pushGenerationNow doc.
    if (pending.pushGen !== pushGenerationNow()) return;
    if (pending.index === committedIndex) return;
    navigate({
      set: {
        // PRESETS[i] lives at slider index i+1 (index 0 is Default), so the
        // reverse lookup shifts by one — the mirror image of
        // indexForMaxNodes's `+ 1`.
        maxNodes:
          pending.index === DEFAULT_INDEX
            ? null
            : String(PRESETS[pending.index - 1]),
      },
    });
  }, [debouncedPending, pending, committedIndex]);

  return (
    <div className="max-nodes-control" title={TOOLTIP}>
      <span className="max-nodes-control-label" id={labelId}>
        Max nodes
      </span>
      {/* Real elements, not a gradient painted on the track: three CSS
          gradient attempts in a row each broke a different way (a
          track-within-a-track look, alpha doubling where layers overlapped,
          a soft/asymmetric fade edge at small sizes) — see MaxNodesControl.css
          for the history. A dot and a bar sized and positioned in real CSS
          pixels render crisp at any zoom the way a gradient edge cannot. */}
      <div className="max-nodes-rail">
        <span className="max-nodes-rail-dot" aria-hidden="true" />
        <div className="max-nodes-rail-bar" aria-hidden="true" />
        <Slider
          min={0}
          max={PRESETS.length}
          value={draftIndex}
          label="Max nodes"
          labelledBy={labelId}
          valueText={LABELS[draftIndex]}
          onInput={(index) => setDraftStr(String(index))}
          onCommit={(index) => {
            commitGeneration.current += 1;
            setPending({
              index,
              baseline: committedIndex,
              gen: commitGeneration.current,
              pushGen: pushGenerationNow(),
            });
          }}
        />
      </div>
    </div>
  );
}
