/**
 * Minimal stand-ins for the `@grafana/data` primitives the flame graph needs.
 *
 * Only the shape matters here: the app builds `DataFrame`s by hand and the
 * flame graph reads fields out of them, so we keep the same field/frame model
 * without pulling in the whole Grafana data package.
 */

export const FieldType = {
  number: 'number',
  string: 'string',
  time: 'time',
  boolean: 'boolean',
  other: 'other',
} as const;

export type FieldType = (typeof FieldType)[keyof typeof FieldType];

export interface FieldConfig {
  unit?: string;
  displayName?: string;
  custom?: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Field<T = any> {
  name: string;
  type: FieldType;
  values: T[];
  config: FieldConfig;
}

export interface DataFrame {
  name?: string;
  fields: Field[];
  length: number;
}

/** Case-insensitive field lookup by name, used by dataTransform. */
export function getFieldByName(
  frame: DataFrame,
  name: string,
): Field | undefined {
  const target = name.toLowerCase();
  return frame.fields.find((field) => field.name.toLowerCase() === target);
}
