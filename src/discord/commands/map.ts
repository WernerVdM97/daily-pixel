/**
 * /map — the discovered-graph render crosses the JSON seam as `screen.map` (M8.1, DC-M8.4):
 * the composition (the pure `renderMap` over the character's discovered graph) moved into
 * the controller layer (`composeMapScreen` in src/controller/mapScreen.ts, DC-M8.6). This
 * handler is translate + paint only. The optional `focus` is the slash-arm drill-down —
 * the registry wrapper in index.ts extracts `place` from the interaction and a nav click
 * passes none (full map); that extraction stays adapter-side until M9.
 */
import { noticeViewToDiscord } from "../viewToDiscord.js";
import type { GameRouter } from "../../protocol/router.js";
import type { NoticeViewState } from "../../view/viewState.js";
import type { NavFacts } from "../CommandRegistry.js";

export function makeMapCommand(router: GameRouter) {
  return async (
    interaction: { user: { id: string }; focus?: string },
    onNav?: (nav: NavFacts | undefined) => void,
  ): Promise<string> => {
    const response = await router.dispatch({
      type: "screen.map",
      playerId: interaction.user.id,
      ...(interaction.focus !== undefined ? { focus: interaction.focus } : {}),
    });

    // DC-M9.6: hand the dispatcher its nav facts rather than let it read the engine.
    // Reported before the ok check because the read it replaces was outcome-independent;
    // absent when there is no character, which is today's `if (char)` gate.
    onNav?.(response.facts?.nav as NavFacts | undefined);

    if (!response.ok) {
      return response.error.message;
    }

    const view = response.view as NoticeViewState | undefined;
    return view ? noticeViewToDiscord(view).content : "Something went wrong.";
  };
}
