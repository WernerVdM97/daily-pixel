/**
 * /stats — the character sheet crosses the JSON seam as `screen.stats` (M8.1, DC-M8.4): the
 * composition (`formatStats` + the gear breakdown) moved into the controller layer
 * (src/controller/statsScreen.ts). This handler is translate + paint only — the router's
 * error.message IS the string the dispatcher paints, and the view maps through
 * `noticeViewToDiscord`.
 */
import { noticeViewToDiscord } from "../viewToDiscord.js";
import type { GameRouter } from "../../protocol/router.js";
import type { NoticeViewState } from "../../view/viewState.js";

export function makeStatsCommand(router: GameRouter) {
  return async (interaction: { user: { id: string } }): Promise<string> => {
    const response = await router.dispatch({
      type: "screen.stats",
      playerId: interaction.user.id,
    });

    if (!response.ok) {
      return response.error.message;
    }

    const view = response.view as NoticeViewState | undefined;
    return view ? noticeViewToDiscord(view).content : "Something went wrong.";
  };
}
