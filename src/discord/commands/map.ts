/**
 * /map crosses the JSON seam as `screen.map`, rendered by `composeMapScreen` in `src/controller/mapScreen.ts`.
 * `focus` is the slash arm's drill-down — the registry wrapper in index.ts extracts `place`; a nav click passes none.
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
