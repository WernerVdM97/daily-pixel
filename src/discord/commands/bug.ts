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
import type { NavFacts } from "../CommandRegistry.js";

export function makeBugCommand(
  router: GameRouter,
  notifyAdmin: (label: string, err: unknown) => Promise<void>,
) {
  return async (
    interaction: { user: { id: string }; text: string },
    onNav?: (nav: NavFacts | undefined) => void,
  ): Promise<string> => {
    const response = await router.dispatch({
      type: "bug.submit",
      playerId: interaction.user.id,
      text: interaction.text,
      surface: "slash-bug",
    });

    // DC-M9.6: hand the dispatcher its nav facts rather than let it read the engine.
    // Only the two slash surfaces carry `nav` (the router builds it off the character read
    // its own guard already performs); the two in-message surfaces never reach here.
    onNav?.(response.facts?.nav as NavFacts | undefined);

    // DC-M9.3.10: the two in-message bug leaves page the admin on this fact already — before
    // the seam crossing a throwing recordFeedback propagated out of this handler into the
    // dispatcher's error net, which did page. Without this the slash path lost that signal.
    if (response.facts?.persistFailed) {
      void notifyAdmin("Slash bug report failed", new Error("recordFeedback failed"));
    }

    if (!response.ok) {
      return response.error.message;
    }

    const view = response.view as NoticeViewState | undefined;
    return view ? noticeViewToDiscord(view).content : "Something went wrong.";
  };
}
