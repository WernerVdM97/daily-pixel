import type { CommandHandler } from '../CommandRegistry.js';

export const pingCommand: CommandHandler = async () => 'pong';
