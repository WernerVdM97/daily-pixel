# M8.5 protocol corpus

Committed protocol-log transcripts (DC-S1) for M9's replay gate: the Discord rebuild must replay every corpus entry byte-green (the M9 gate — "replay of the M8.5 corpus (stub + deterministic real-backend transcripts) byte-green").

## Entries

- `stub-1d.protocol.json` — a 1-day stub-backed scripted session (`npm run agent:stub -- 1`), header `{ brain: 'scripted', backend: 'stub' }`. Byte-deterministic across fresh runs (the stub-run dogfood pin), so the committed bytes are stable.

## Regenerating

The corpus is pinned two ways by `tests/agent/protocol-transcript.test.ts`: the file must replay byte-green AND deep-equal a fresh in-process run. When the tooling drifts (a new event, changed copy), regenerate with:

```sh
AGENT_PROTOCOL_OUT=tests/fixtures/protocol-corpus/stub-1d.protocol.json npm run agent:stub -- 1
```

Regenerate with `AGENT_PROTOCOL_BEATS` unset — the corpus is recorded with the DC-S1 beats knob off.

Commit the regenerated file together with the change that caused the drift. Never hand-edit the JSON.

## Real-backend entries (deferred to M9)

The corpus intentionally carries the stub transcript only. Deterministic real-backend transcripts are SF3-wall-clock-dependent (the day-start greeting reads `isWeekend()`; the nightly tick runs the Saturday bonus roll + NPC script and the 5-day absence nudge on `getUTCDay() === 6`), so a committed real transcript would drift when replayed on a different weekday class. M9's real-class corpus entries need a same-weekday-class guard at replay (or same-day record+replay), per SF3. The stub corpus replays on the stub backend only — forcing `--real` against it would mismatch the canned envelopes (the DC-S5 contract describe pins the one structural divergence); real-class corpus entries land with M9.
