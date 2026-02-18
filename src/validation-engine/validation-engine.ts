import type { ValidationContext, ValidationRule, ValidationResult } from './rule-types';

export async function runValidationRules(
  ctx: ValidationContext,
  rules: ValidationRule[]
): Promise<ValidationResult[]> {
  if (process.env.ENABLE_VALIDATION_RULES !== 'true') {
    return [];
  }
  const results: ValidationResult[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    try {
      const passed = await r.validate(ctx);
      results.push({ ruleId: r.id, passed });
    } catch {
      results.push({ ruleId: r.id, passed: false });
    }
  }
  return results;
}
