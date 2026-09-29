/**
 * /help crosses the JSON seam as `screen.help`; the copy is `src/controller/helpScreen.ts`. The
 * event has no no-character arm — help works charless, and gating it would be a behaviour change.
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

    // Reported before the ok check because the read it replaces was outcome-independent; `/help`
    // works charless, so its facts still follow the router's own character read.
    onNav?.(response.facts?.nav as NavFacts | undefined);

    if (!response.ok) {
      return response.error.message;
    }

    const view = response.view as NoticeViewState | undefined;
    return view ? noticeViewToDiscord(view).content : "Something went wrong.";
  };
}
