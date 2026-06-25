type ClassDictionary = Record<string, unknown>;
type ClassArray = ClassValue[];
type ClassValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | ClassDictionary
  | ClassArray;

function flattenClass(value: ClassValue | null | undefined | false): string[] {
  if (value === null || value === undefined || value === false || value === true) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return [String(value)];
  }
  if (Array.isArray(value)) return value.flatMap(flattenClass);
  return Object.entries(value)
    .filter(([, enabled]) => enabled)
    .map(([className]) => className);
}

export function cn(...classes: (ClassValue | null | undefined | false)[]): string {
  return classes.flatMap(flattenClass).join(" ");
}
