/**
 * NHS Number generation and validation.
 *
 * NHS numbers are 10-digit numbers where the 10th digit is a check digit
 * calculated using Modulus 11. If the check digit is 10, the number is invalid
 * and must be discarded.
 *
 * Algorithm: https://www.datadictionary.nhs.uk/attributes/nhs_number.html
 */

const WEIGHTS = [10, 9, 8, 7, 6, 5, 4, 3, 2] as const;

/**
 * Calculate the check digit for a 9-digit NHS number prefix.
 * Returns the check digit (0-9) or null if the number is invalid (remainder = 10).
 */
export function calculateCheckDigit(nineDigits: string): number | null {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(nineDigits[i]) * WEIGHTS[i]!;
  }
  const remainder = 11 - (sum % 11);

  if (remainder === 11) return 0;
  if (remainder === 10) return null; // invalid, must discard
  return remainder;
}

/**
 * Validate an NHS number (10 digits with valid check digit).
 */
export function isValidNhsNumber(nhsNumber: string): boolean {
  if (!/^\d{10}$/.test(nhsNumber)) return false;
  const checkDigit = calculateCheckDigit(nhsNumber.substring(0, 9));
  return checkDigit !== null && checkDigit === Number(nhsNumber[9]);
}

/**
 * Generate a valid NHS number using the provided RNG function.
 * The RNG should return a float in [0, 1).
 */
export function generateNhsNumber(rng: () => number): string {
  // Retry until we get a valid check digit (roughly 1 in 11 are discarded)
  for (;;) {
    const digits = Array.from({ length: 9 }, () => Math.floor(rng() * 10));
    const prefix = digits.join('');
    const check = calculateCheckDigit(prefix);
    if (check !== null) {
      return prefix + String(check);
    }
  }
}

/**
 * Generate `count` unique valid NHS numbers.
 */
export function generateUniqueNhsNumbers(count: number, rng: () => number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  while (result.length < count) {
    const num = generateNhsNumber(rng);
    if (!seen.has(num)) {
      seen.add(num);
      result.push(num);
    }
  }
  return result;
}
