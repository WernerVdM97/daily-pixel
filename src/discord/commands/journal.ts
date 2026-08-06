/**
 * /journal — the chronicle + NPC list crosses the JSON seam as `screen.journal` (M8.1,
 * DC-M8.4): the composition moved into the controller layer
 * (src/controller/journalScreen.ts). This handler is translate + paint only — the router's
 * error.message IS the string the dispatcher paints, and the view maps through
 * `noticeViewToDiscord`.
 */
import { noticeViewToDiscord } from "../viewToDiscord.js";
import type { GameRouter } from "../../protocol/router.js";
import type { NoticeViewState } from "../../view/viewState.js";

export function makeJournalCommand(router: GameRouter) {
  return async (interaction: { user: { id: string } }): Promise<string> => {
    const response = await router.dispatch({
      type: "screen.journal",
      playerId: interaction.user.id,
    });

    if (!response.ok) {
      return response.error.message;
    }

    const view = response.view as NoticeViewState | undefined;
    return view ? noticeViewToDiscord(view).content : "Something went wrong.";
  };
}
