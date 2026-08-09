# M8.5 protocol corpus

Committed protocol-log transcripts (DC-S1) for M9's replay gate: the Discord rebuild must replay every corpus entry byte-green (the M9 gate — "replay of the M8.5 corpus (stub + deterministic real-backend transcripts) byte-green").

## Entries

- `stub-1d.protocol.json` — a 1-day stub-backed scripted session (`npm run agent:stub -- 1`), header `{ brain: 'scripted', backend: 'stub' }`. Byte-deterministic across fresh runs (the stub-run dogfood pin), so the committed bytes are stable.

## Regenerating

The corpus is pinned two ways by `tests/agent/protocol-transcript.test.ts`: the file must replay byte-green AND deep-equal a fresh in-process run. When the tooling drifts (a new event, changed copy), regenerate with:

```sh
AGENT_PROTOCOL_OUT=tests/fixtures/protocol-corpus/stub-1d.protocol.json npm run agent:stub -- 1
```

Regenerate with `AGENT_PROTOCOL_BEATS` unset — the corpus is recorded with the DC-S1 beats knob off. No clock env is needed: `stubRun` stamps and pins a fixed `recordedAt` (`STUB_RECORDED_AT`, a Wednesday) precisely so a regeneration is byte-reproducible on any day of the week.

Commit the regenerated file together with the change that caused the drift. Never hand-edit the JSON.

## The recording clock (DC-M10.6) — and the SF3 caveat it retires

Every header carries `recordedAt`, an ISO-8601 stamp, and **both halves obey it**: a deterministic recorder pins the process clock to the stamp it writes, and replay pins itself to the header's stamp before running anything.

This is what retires the SF3 same-weekday-class caveat that deferred real-backend corpus entries from M8.5 through M9. These streams read the wall clock in two places — the day-start greeting branches on `isWeekend()` (`src/controller/hiScreen.ts`) and the nightly tick grants the Saturday bonus roll on `getUTCDay() === 6` (`src/engine/WorldEngineImpl.ts`) — so before the pin, a transcript recorded on a Thursday diverged when replayed on a Saturday, and a committed real-backend entry would have rotted on a schedule.

Pinning only the replay half is not enough and the suite proves it: the recording would still run on the wall clock, so the two would disagree on exactly those branches. `tests/agent/replay.test.ts` pins the mechanism with a tamper rather than an assertion — a session recorded on a Saturday stamp replays green, and the identical stream restamped to a Wednesday replays RED. If the clock were not being obeyed, both would agree.

A header without a parseable `recordedAt` is rejected by `parseProtocolFile` rather than defaulted, because pinning to `Invalid Date` would turn every weekday comparison into a silent `NaN` rather than a loud failure.

## Real-backend entries

Still stub-only, but no longer for the SF3 reason above — that is discharged. What remains is a recorder: the deterministic real-backend session (scripted pipeline gateway, fixed d20, no live LLM and no tokens) currently lives as a helper inside `tests/agent/replay.test.ts` rather than anywhere a regen command can call. Promoting it is the remaining step.

Note that the stub corpus replays on the stub backend only — forcing `--real` against it would mismatch the canned envelopes (the DC-S5 contract describe pins the one structural divergence).
