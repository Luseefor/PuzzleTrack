import { SUPPORTED_TIME_LIMITS } from '../models/types.js';

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

export function validateTimeLimit(seconds: number): number {
  if (!(SUPPORTED_TIME_LIMITS as readonly number[]).includes(seconds)) {
    throw new ValidationError(
      `Time limit must be one of: ${SUPPORTED_TIME_LIMITS.join(', ')} seconds.`,
    );
  }
  return seconds;
}
