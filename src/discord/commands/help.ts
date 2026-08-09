/**
 * /help — the command list + Economy block crosses the JSON seam as `screen.help` (M8.1,
 * DC-M8.3/4): the copy moved into the controller layer (src/controller/helpScreen.ts) and
 * the event has NO no-character arm (help works charless today — gating it would be a
 * behaviour change). This handler is translate + paint only; the view maps through
 * `noticeViewToDiscord`.
 */
import { noticeViewToDiscord } from "../viewToDiscord.js";
import type { GameRouter } from "../../protocol/router.js";
import type { NoticeViewState } from "../../view/viewState.js";
import type { NavFacts } from "../CommandRegistry.js";

export function makeHelpCommand(router: GameRouter) {
  return async (
    interaction: { user: { id: string } },
    onNav?: (nav: NavFacts | undefined) => void,
  ): Promise<string> => {
    const response = await router.dispatch({
      type: "screen.help",
      playerId: interaction.user.id,
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
