/**
 * /bug — crosses the JSON seam as `bug.submit` with the `slash-bug` surface (M9.2,
 * DC-M9.2.1/DC-M9.5): the confirmation copy and the persist routing already live
 * controller-side byte-identically (`feedbackConfirmation`/`recordFeedback`), and the
 * no-character guard lives in the router (`dispatchFeedback`). This handler is translate +
 * paint only, the `hi.ts`/`look.ts` shape — the router's error.message IS the string the
 * dispatcher paints, and the view maps through `noticeViewToDiscord`. No `actionId`: the
 * slash command registry never supplies one.
 */
import { noticeViewToDiscord } from "../viewToDiscord.js";
import type { GameRouter } from "../../protocol/router.js";
import type { NoticeViewState } from "../../view/viewState.js";

export function makeBugCommand(router: GameRouter) {
  return async (interaction: { user: { id: string }; text: string }): Promise<string> => {
    const response = await router.dispatch({
      type: "bug.submit",
      playerId: interaction.user.id,
      text: interaction.text,
      surface: "slash-bug",
    });

    if (!response.ok) {
      return response.error.message;
    }

    const view = response.view as NoticeViewState | undefined;
    return view ? noticeViewToDiscord(view).content : "Something went wrong.";
  };
}
