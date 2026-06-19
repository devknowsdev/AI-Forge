import { ValidationError } from './errors';
import type { ExecutionResult } from '../types/contracts';

export class RuntimeValidator {
  validate(result: ExecutionResult): void {
    if (typeof result.output !== 'string' || result.output.trim().length === 0) {
      throw new ValidationError('Execution produced empty output');
    }

    if (typeof result.modelUsed !== 'string' || result.modelUsed.trim().length === 0) {
      throw new ValidationError('Execution did not record modelUsed');
    }

    const anyResult = result as Record<string, unknown>;

    if ('timestamp' in anyResult && !anyResult.timestamp) {
      throw new ValidationError('Execution timestamp is empty');
    }

    if ('route' in anyResult && 'executor' in anyResult.route as Record<string, unknown> && 'modelUsed' in anyResult) {
      const route = anyResult.route as Record<string, unknown>;
      if (route.executor && typeof route.executor !== 'string') {
        throw new ValidationError('Route executor is invalid');
      }
    }
  }
}

export const runtimeValidator = new RuntimeValidator();