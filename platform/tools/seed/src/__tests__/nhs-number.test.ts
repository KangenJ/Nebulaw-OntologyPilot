import { describe, it, expect } from 'vitest';
import { calculateCheckDigit, isValidNhsNumber, generateNhsNumber, generateUniqueNhsNumbers } from '../nhs-number.js';
import { createRng } from '../rng.js';

describe('NHS Number — checksum', () => {
  it('calculates correct check digit for known prefix', () => {
    // Example: 401023218 -> check digit = 0 (known valid: 4010232180)
    // We verify the algorithm manually:
    // 4*10 + 0*9 + 1*8 + 0*7 + 2*6 + 3*5 + 2*4 + 1*3 + 8*2 = 40+0+8+0+12+15+8+3+16 = 102
    // 11 - (102 % 11) = 11 - 3 = 8
    const check = calculateCheckDigit('401023218');
    expect(check).toBe(8);
  });

  it('returns null for prefix where remainder is 10', () => {
    // Construct a prefix that yields remainder 10
    // Need: 11 - (sum%11) = 10, so sum%11 = 1
    // 100000000: 1*10 = 10, 10%11 = 10, 11-10=1 -> no
    // Try brute force a known case
    // Just verify the null path exists by checking many numbers
    let foundNull = false;
    for (let i = 0; i < 1000; i++) {
      const prefix = String(100000000 + i);
      if (calculateCheckDigit(prefix) === null) {
        foundNull = true;
        break;
      }
    }
    expect(foundNull).toBe(true);
  });

  it('returns 0 when remainder is 11', () => {
    // Need: sum%11 = 0, so 11-0 = 11, return 0
    // Verify this case exists
    let foundZero = false;
    for (let i = 0; i < 10000; i++) {
      const prefix = String(100000000 + i);
      if (calculateCheckDigit(prefix) === 0) {
        foundZero = true;
        break;
      }
    }
    expect(foundZero).toBe(true);
  });
});

describe('NHS Number — validation', () => {
  it('validates a correctly generated number', () => {
    const rng = createRng(42);
    const num = generateNhsNumber(rng);
    expect(isValidNhsNumber(num)).toBe(true);
  });

  it('rejects numbers with wrong length', () => {
    expect(isValidNhsNumber('123')).toBe(false);
    expect(isValidNhsNumber('12345678901')).toBe(false);
  });

  it('rejects non-numeric strings', () => {
    expect(isValidNhsNumber('abcdefghij')).toBe(false);
  });

  it('rejects numbers with incorrect check digit', () => {
    const rng = createRng(42);
    const num = generateNhsNumber(rng);
    // Flip last digit
    const lastDigit = Number(num[9]);
    const wrongDigit = (lastDigit + 1) % 10;
    const corrupted = num.substring(0, 9) + String(wrongDigit);
    expect(isValidNhsNumber(corrupted)).toBe(false);
  });
});

describe('NHS Number — generation', () => {
  it('generates 10-digit numbers', () => {
    const rng = createRng(42);
    const num = generateNhsNumber(rng);
    expect(num).toHaveLength(10);
    expect(/^\d{10}$/.test(num)).toBe(true);
  });

  it('all generated numbers pass validation', () => {
    const rng = createRng(42);
    for (let i = 0; i < 100; i++) {
      const num = generateNhsNumber(rng);
      expect(isValidNhsNumber(num)).toBe(true);
    }
  });

  it('generates unique numbers', () => {
    const rng = createRng(42);
    const numbers = generateUniqueNhsNumbers(1000, rng);
    expect(numbers).toHaveLength(1000);
    expect(new Set(numbers).size).toBe(1000);
  });

  it('all unique numbers pass checksum', () => {
    const rng = createRng(42);
    const numbers = generateUniqueNhsNumbers(500, rng);
    for (const num of numbers) {
      expect(isValidNhsNumber(num)).toBe(true);
    }
  });
});
