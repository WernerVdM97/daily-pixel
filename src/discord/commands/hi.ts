/**
 * /hi — the greeting screen crosses the JSON seam as `hi.open` (M7.2, DC-M7.2.4): the
 * screen composition (character header, weekend hooks / day-job block, unfinished-action
 * resume) moved into the controller layer (`composeHiScreen` in src/controller/hiScreen.ts)
 * and the reply copy moved to the router (DC-P4). This handler is translate + paint only —
 * the router's error.message IS the string the dispatcher paints, and the view maps through
 * `noticeViewToDiscord`.
 */
import { noticeViewToDiscord } from "../viewToDiscord.js";
import type { GameRouter } from "../../protocol/router.js";
import type { NoticeViewState } from "../../view/viewState.js";

export function makeHiCommand(router: GameRouter) {
  return async (interaction: { user: { id: string } }): Promise<string> => {
    const response = await router.dispatch({
      type: "hi.open",
      playerId: interaction.user.id,
    });

    if (!response.ok) {
      return response.error.message;
    }

    const view = response.view as NoticeViewState | undefined;
    return view ? noticeViewToDiscord(view).content : "Something went wrong.";
  };
}
