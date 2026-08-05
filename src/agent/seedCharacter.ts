/**
 * The agent's character creation through the protocol (M7.3, DC-M7.3.9) — the last
 * engine-direct bookend leaves the harness (the observer surface is exactly
 * getCharacter/getMeta/tick, DC-S4's stated end state). Drives the join wizard through the
 * seam exactly as a player would: `join.open` → `wizard.answer` (the free-text name) →
 * `wizard.choose` × steps 2–7 (class/upbringing/race/alignment/dayJob + the mandatory
 * starting kit) → `character.create`. `itemSetName` is required (the wizard's step 7 has no
 * skip — a kit-less seed is impossible through the protocol). Any `ok:false` throws with the
 * envelope's message (the router never throws — a rejection here is a real protocol failure
 * the run should surface).
 */

import type { GameRouter } from '../protocol/router.js';
import type { CharCreateData } from '../engine/WorldEngine.js';

export async function seedCharacterViaProtocol(
  router: GameRouter,
  userId: string,
  data: CharCreateData,
): Promise<void> {
  let response = await router.dispatch({ type: 'join.open', playerId: userId });
  if (!response.ok) throw new Error(response.error.message);

  response = await router.dispatch({ type: 'wizard.answer', playerId: userId, text: data.name });
  if (!response.ok) throw new Error(response.error.message);

  // Steps 2-6: class, upbringing, race, alignment, dayJob. The persisted keys are the def
  // names — except alignment, which the wizard persists lowercase ("lawful good"), so the
  // caller's fixture must carry the lowercase value (the controller validates against the
  // defs, so a title-case fixture would now be rejected).
  for (const [step, value] of [[2, data.class], [3, data.upbringing], [4, data.race], [5, data.alignment], [6, data.dayJob]] as const) {
    response = await router.dispatch({ type: 'wizard.choose', playerId: userId, step, value });
    if (!response.ok) throw new Error(response.error.message);
  }

  // Step 7 (Starting Kit) is MANDATORY in the wizard — the walk can only reach the step-8
  // confirm screen by choosing a kit, so a kit-less seed is impossible through the protocol
  // (old createCharacter had no such constraint). Fail loudly up front rather than stall at
  // step 7 and surface the confusing "isn't ready to confirm" envelope at character.create.
  if (!data.itemSetName) {
    throw new Error('seed: itemSetName is required — the wizard has no kit-less creation path (step 7 is mandatory)');
  }

  response = await router.dispatch({ type: 'wizard.choose', playerId: userId, step: 7, value: data.itemSetName });
  if (!response.ok) throw new Error(response.error.message);

  response = await router.dispatch({ type: 'character.create', playerId: userId });
  if (!response.ok) throw new Error(response.error.message);
}
