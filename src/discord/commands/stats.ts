/**
 * /stats crosses the JSON seam as `screen.stats`; `formatStats` and the gear breakdown live in
 * `src/controller/statsScreen.ts`.
 */
import { noticeViewToDiscord } from "../viewToDiscord.js";
import type { GameRouter } from "../../protocol/router.js";
import type { NoticeViewState } from "../../view/viewState.js";
import type { NavFacts } from "../CommandRegistry.js";

export function makeStatsCommand(router: GameRouter) {
  return async (
    interaction: { user: { id: string } },
    onNav?: (nav: NavFacts | undefined) => void,
  ): Promise<string> => {
    const response = await router.dispatch({
      type: "screen.stats",
      playerId: interaction.user.id,
    });

    // Reported before the ok check because the read it replaces was outcome-independent; `nav` is
    // absent on the no-character arm.
    onNav?.(response.facts?.nav as NavFacts | undefined);

    if (!response.ok) {
      return response.error.message;
    }

    const view = response.view as NoticeViewState | undefined;
    return view ? noticeViewToDiscord(view).content : "Something went wrong.";
  };
}
