/**
 * /look crosses the JSON seam as `screen.look`; `composeLookScreen` in `src/controller/lookScreen.ts`
 * owns the composition and the `SceneLookupFn` type, and the no-character copy is the router's.
 */
import { noticeViewToDiscord } from "../viewToDiscord.js";
import type { GameRouter } from "../../protocol/router.js";
import type { NoticeViewState } from "../../view/viewState.js";
import type { NavFacts } from "../CommandRegistry.js";

export function makeLookCommand(router: GameRouter) {
  return async (
    interaction: { user: { id: string } },
    onNav?: (nav: NavFacts | undefined) => void,
  ): Promise<string> => {
    const response = await router.dispatch({
      type: "screen.look",
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
