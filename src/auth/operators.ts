/**
 * Operator credentials.
 *
 * Was: one shared `ADMIN_API_KEY`. Everyone who ran a show typed the same
 * string, so there was no way to tell who created a room or ejected someone,
 * and removing one person's access meant rotating the key for everyone.
 *
 * Now: named credentials. Each operator has their own, actions are attributed
 * to them in the logs, and revoking one is deleting one entry.
 *
 * Format: `name:secret` entries separated by commas.
 *
 *   OPERATOR_KEYS=ada:xLq…,producer-zola:9fK…
 *
 * A bare secret with no name is accepted and labelled `default`, so an existing
 * ADMIN_API_KEY deployment keeps working while the named ones are rolled out.
 */

import { secretsMatch } from './keys.js';

export interface OperatorCredential {
  id: string;
  secret: string;
}

export function parseOperators(raw: string): OperatorCredential[] {
  const operators: OperatorCredential[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    const hasName = separator > 0;
    const id = hasName ? entry.slice(0, separator) : 'default';
    const secret = hasName ? entry.slice(separator + 1) : entry;

    if (secret.length < 24) {
      throw new Error(`Operator credential ${id} is too short; at least 24 chars required.`);
    }
    if (seen.has(id)) throw new Error(`Duplicate operator id ${id}`);
    seen.add(id);
    operators.push({ id, secret });
  }
  return operators;
}

/**
 * Which operator does this credential belong to, if any?
 *
 * Every candidate is compared even after a match, so the work does not depend
 * on WHICH credential was presented — an early return would leak an operator's
 * position in the list through timing.
 */
export function identifyOperator(
  provided: string,
  operators: readonly OperatorCredential[],
): string | null {
  let matched: string | null = null;
  for (const operator of operators) {
    if (secretsMatch(provided, operator.secret)) matched = operator.id;
  }
  return matched;
}
