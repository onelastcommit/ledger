import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

export const ULID_MAX_TIME = 281_474_976_710_655;

const encodeTime = (time: number): string => {
  if (!Number.isInteger(time) || time < 0 || time > ULID_MAX_TIME) {
    throw new RangeError(`ULID timestamp out of range: ${time}`);
  }
  let remaining = time;
  let out = '';
  for (let i = 0; i < TIME_LEN; i += 1) {
    const mod = remaining % ENCODING_LEN;
    out = ENCODING.charAt(mod) + out;
    remaining = (remaining - mod) / ENCODING_LEN;
  }
  return out;
};

const randomDigits = (): number[] => {
  const bytes = randomBytes(RANDOM_LEN);
  const digits: number[] = new Array<number>(RANDOM_LEN);
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    digits[i] = (bytes.at(i) ?? 0) % ENCODING_LEN;
  }
  return digits;
};

const incrementDigits = (digits: number[]): boolean => {
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const digit = digits[i] ?? 0;
    if (digit < ENCODING_LEN - 1) {
      digits[i] = digit + 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
};

const encodeDigits = (digits: number[]): string => {
  let out = '';
  for (const digit of digits) out += ENCODING.charAt(digit);
  return out;
};

export const monotonicUlidFactory = (now: () => number = Date.now): (() => string) => {
  let lastTime = -1;
  let lastDigits: number[] = [];

  return (): string => {
    const time = now();
    if (time > lastTime) {
      lastTime = time;
      lastDigits = randomDigits();
    } else if (!incrementDigits(lastDigits)) {
      lastTime += 1;
      lastDigits = randomDigits();
    }
    return encodeTime(lastTime) + encodeDigits(lastDigits);
  };
};

export const ulid = monotonicUlidFactory();

export const decodeUlidTime = (id: string): number => {
  if (id.length !== TIME_LEN + RANDOM_LEN) {
    throw new TypeError(`Not a ULID: expected 26 characters, got ${id.length}`);
  }
  let time = 0;
  for (let i = 0; i < TIME_LEN; i += 1) {
    const value = ENCODING.indexOf(id.charAt(i));
    if (value === -1) throw new TypeError(`Not a ULID: invalid character "${id.charAt(i)}"`);
    time = time * ENCODING_LEN + value;
  }
  return time;
};

export const isUlid = (value: string): boolean => {
  if (value.length !== TIME_LEN + RANDOM_LEN) return false;
  for (const char of value) {
    if (!ENCODING.includes(char)) return false;
  }
  return decodeUlidTime(value) <= ULID_MAX_TIME;
};
