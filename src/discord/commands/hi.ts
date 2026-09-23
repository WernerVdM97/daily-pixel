/**
 * /hi crosses the JSON seam as `hi.open`: the screen composition is `composeHiScreen` in
 * `src/controller/hiScreen.ts`; the copy is the router's.
 */
import { noticeViewToDiscord } from "../viewToDiscord.js";
import type { GameRouter } from "../../protocol/router.js";
import type { NoticeViewState } from "../../view/viewState.js";
import type { NavFacts } from "../CommandRegistry.js";

export function makeHiCommand(router: GameRouter) {
  return async (
    interaction: { user: { id: string } },
    onNav?: (nav: NavFacts | undefined) => void,
  ): Promise<string> => {
    const response = await router.dispatch({
      type: "hi.open",
      playerId: interaction.user.id,
    });

    // Reported before the ok check: the read it replaces was outcome-independent. `nav` is absent
    // for a charless player, and a `nav:hi` button click reaches exactly that arm.
    onNav?.(response.facts?.nav as NavFacts | undefined);

    if (!response.ok) {
      return response.error.message;
    }

    const view = response.view as NoticeViewState | undefined;
    return view ? noticeViewToDiscord(view).content : "Something went wrong.";
  };
}
