import { SUPPORTED_TIME_LIMITS } from '../models/types.js';
import { CHESSTEMPO_LIVE_BRIDGE } from '../integrations/featureFlags.js';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Participant IDs like "P01". Rules: 1–32 chars, letters/numbers/dash/underscore. */
export function validateParticipantId(raw: string): string {
  const id = raw.trim();
  if (id.length === 0) throw new ValidationError('Participant ID cannot be empty.');
  if (id.length > 32) throw new ValidationError('Participant ID must be 32 characters or fewer.');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new ValidationError('Participant ID may only contain letters, numbers, dash, and underscore.');
  }
  return id;
}

export function validateTargetAttempts(n: number): number {
  if (!Number.isInteger(n)) throw new ValidationError('Number of puzzles must be an integer.');
  if (n < 1 || n > 100) throw new ValidationError('Number of puzzles must be between 1 and 100.');
  return n;
}

/**
 * Development-only short timeout (2 minutes) for TEST01 timeout drills.
 * Available ONLY in live-bridge builds; production conditions (15/30/45/60)
 * are never altered. Never select this for real participants.
 */
export const DEV_TIME_LIMIT_SECONDS = 120;

export function isSupportedTimeLimit(seconds: number, liveBridge = CHESSTEMPO_LIVE_BRIDGE): boolean {
  if ((SUPPORTED_TIME_LIMITS as readonly number[]).includes(seconds)) return true;
  return liveBridge && seconds === DEV_TIME_LIMIT_SECONDS;
}

export function validateTimeLimit(seconds: number): number {
  if (!isSupportedTimeLimit(seconds)) {
    throw new ValidationError(
      `Time limit must be one of: ${SUPPORTED_TIME_LIMITS.join(', ')} seconds.`,
    );
  }
  return seconds;
}
