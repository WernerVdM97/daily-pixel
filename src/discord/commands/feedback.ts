/**
 * /feedback crosses the JSON seam as `feedback.submit` with the `slash-feedback` surface; the router
 * owns the guard and the confirmation copy. No `actionId`: the slash-command registry supplies none.
 */
import { noticeViewToDiscord } from "../viewToDiscord.js";
import type { GameRouter } from "../../protocol/router.js";
import type { NoticeViewState } from "../../view/viewState.js";
import type { NavFacts } from "../CommandRegistry.js";

export function makeFeedbackCommand(
  router: GameRouter,
  notifyAdmin: (label: string, err: unknown) => Promise<void>,
) {
  return async (
    interaction: { user: { id: string }; text: string },
    onNav?: (nav: NavFacts | undefined) => void,
  ): Promise<string> => {
    const response = await router.dispatch({
      type: "feedback.submit",
      playerId: interaction.user.id,
      text: interaction.text,
      surface: "slash-feedback",
    });

    // Absent on the no-character arm: the router builds `nav` off the character read its own guard already performs.
    onNav?.(response.facts?.nav as NavFacts | undefined);

    // Preserves the pre-seam page: a throwing `recordFeedback` used to reach the dispatcher's error net.
    if (response.facts?.persistFailed) {
      void notifyAdmin("Slash feedback submission failed", new Error("recordFeedback failed"));
    }

    if (!response.ok) {
      return response.error.message;
    }

    const view = response.view as NoticeViewState | undefined;
    return view ? noticeViewToDiscord(view).content : "Something went wrong.";
  };
}
