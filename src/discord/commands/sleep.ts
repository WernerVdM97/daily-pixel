/**
 * /sleep — rest or advance the world.
 *
 * Admin (ADMIN_USER_ID env var): triggers the daily tick.
 * Non-admin: returns a camp-by-the-Oak rest scene, no tick.
 */
import type { WorldEngine } from "../../engine/WorldEngine.js";
import { mapError } from "../../engine/ErrorMapper.js";

export function makeSleepCommand(engine: WorldEngine) {
  /** Warn once at first call if ADMIN_USER_ID is unset (deploy-time safety net). */
  const adminUserId = process.env.ADMIN_USER_ID ?? '';
  if (!adminUserId) {
    console.warn(
      '[sleep] WARNING: ADMIN_USER_ID is not set. Admin `/sleep` will be unreachable —',
      'the world can only advance via nightly cron. Set this env var to enable admin tick.',
    );
  }

  return async (interaction: { user: { id: string } }): Promise<string> => {
    const isAdmin = interaction.user.id === adminUserId;

    if (isAdmin) {
      try {
        const result = engine.tick(true);

        // Scaling flavor text per day range
        const flavor = result.dayNumber <= 3
          ? 'The warden watches the horizon. The fire crackles, steady and low.'
          : 'The smoke on the eastern horizon has thickened. The warden hasn\'t spoken since yesterday.';

        const lines: string[] = [];
        lines.push(`🌅 **Day ${result.dayNumber} begins.**`);
        lines.push('');
        lines.push(flavor);
        lines.push('');
        lines.push(`The Oak awaits. \`/hi\` to begin.`);

        if (result.playersAffected > 0 || result.npcMovements.length > 0) {
          lines.push('');
          lines.push(`─ ${result.playersAffected} soul(s) stirred, ${result.npcMovements.length} NPC(s) on the move.`);
        }

        return lines.join('\n');
      } catch (e) {
        console.error('[sleep] tick failed:', e);
        return mapError(e);
      }
    }

    // Non-admin: rest scene, no tick
    return [
      '🏕️ **Camp by the Oak**',
      '═'.repeat(30),
      '',
      'You bank the fire and bed down beneath the Oak.',
      'The day turns when the world wills it — not when you do.',
      '',
      '*The ember glows. The Oak stands watch. Rest, for now.*',
    ].join('\n');
  };
}


