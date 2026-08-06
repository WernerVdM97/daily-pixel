/**
 * /look — the scene survey crosses the JSON seam as `screen.look` (M8.1, DC-M8.4): the
 * composition (scene code block, location, safe/unsafe block, Paths, entities) moved into
 * the controller layer (`composeLookScreen` in src/controller/lookScreen.ts, which now also
 * owns the `SceneLookupFn` type) and the no-character copy moved to the router (DC-P4).
 * This handler is translate + paint only — the router's error.message IS the string the
 * dispatcher paints, and the view maps through `noticeViewToDiscord`.
 */
import { noticeViewToDiscord } from "../viewToDiscord.js";
import type { GameRouter } from "../../protocol/router.js";
import type { NoticeViewState } from "../../view/viewState.js";

export function makeLookCommand(router: GameRouter) {
  return async (interaction: { user: { id: string } }): Promise<string> => {
    const response = await router.dispatch({
      type: "screen.look",
      playerId: interaction.user.id,
    });

    if (!response.ok) {
      return response.error.message;
    }

    const view = response.view as NoticeViewState | undefined;
    return view ? noticeViewToDiscord(view).content : "Something went wrong.";
  };
}
