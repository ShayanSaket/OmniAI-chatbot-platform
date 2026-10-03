// Minimal Zod (v3) → JSON Schema converter for AI tool parameters. Supports the subset
// tool schemas use: object, string (+enum), number, integer, boolean, array, optional,
// nullable, default, and `.describe()`. Unsupported types throw so a new tool can't
// silently ship a wrong schema.
import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

function withDescription(schema: JsonSchema, type: z.ZodTypeAny): JsonSchema {
  return type.description ? { ...schema, description: type.description } : schema;
}

/** True when the property may be left out of the object. */
function isOptional(type: z.ZodTypeAny): boolean {
  return type instanceof z.ZodOptional || type instanceof z.ZodDefault;
}

export function zodToJsonSchema(type: z.ZodTypeAny): JsonSchema {
  if (type instanceof z.ZodOptional || type instanceof z.ZodDefault) {
    const inner = type instanceof z.ZodOptional ? type.unwrap() : type.removeDefault();
    return withDescription(zodToJsonSchema(inner), type);
  }
  if (type instanceof z.ZodNullable) {
    const inner = zodToJsonSchema(type.unwrap());
    return withDescription({ anyOf: [inner, { type: 'null' }] }, type);
  }
  if (type instanceof z.ZodEffects) {
    return withDescription(zodToJsonSchema(type.innerType()), type);
  }
  if (type instanceof z.ZodString) {
    const schema: JsonSchema = { type: 'string' };
    for (const check of type._def.checks) {
      if (check.kind === 'max') schema.maxLength = check.value;
      if (check.kind === 'min') schema.minLength = check.value;
      if (check.kind === 'email') schema.format = 'email';
    }
    return withDescription(schema, type);
  }
  if (type instanceof z.ZodEnum) {
    return withDescription({ type: 'string', enum: type.options as string[] }, type);
  }
  if (type instanceof z.ZodNumber) {
    const isInt = type._def.checks.some((c) => c.kind === 'int');
    const schema: JsonSchema = { type: isInt ? 'integer' : 'number' };
    for (const check of type._def.checks) {
      if (check.kind === 'min') schema.minimum = check.value;
      if (check.kind === 'max') schema.maximum = check.value;
    }
    return withDescription(schema, type);
  }
  if (type instanceof z.ZodBoolean) return withDescription({ type: 'boolean' }, type);
  if (type instanceof z.ZodArray) {
    const schema: JsonSchema = { type: 'array', items: zodToJsonSchema(type.element) };
    if (type._def.maxLength) schema.maxItems = type._def.maxLength.value;
    if (type._def.minLength) schema.minItems = type._def.minLength.value;
    return withDescription(schema, type);
  }
  if (type instanceof z.ZodObject) {
    const shape = type.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!isOptional(value)) required.push(key);
    }
    return withDescription(
      { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
      type,
    );
  }
  throw new Error(`zodToJsonSchema: unsupported type ${type.constructor.name}`);
}
