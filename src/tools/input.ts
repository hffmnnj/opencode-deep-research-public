import { ValidationError } from "../library/validate.ts";

export type Input = Record<string, unknown>;

export function asInput(value: unknown): Input {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ValidationError("input must be an object");
  return value as Input;
}

export function optString(input: Input, key: string): string | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ValidationError(`${key} must be a string`);
  return v;
}

export function reqString(input: Input, key: string): string {
  const v = optString(input, key);
  if (!v || !v.trim()) throw new ValidationError(`${key} is required`);
  return v;
}

export function optNumber(input: Input, key: string, min: number, max: number): number | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationError(`${key} must be a number`);
  return Math.min(max, Math.max(min, v));
}

export function optBool(input: Input, key: string): boolean | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ValidationError(`${key} must be true or false`);
  return v;
}

export function optStringArray(input: Input, key: string): string[] | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new ValidationError(`${key} must be an array of strings`);
  return v as string[];
}
