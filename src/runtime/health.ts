import { runtimeRegistry } from './runtimeRegistry';

export function getRuntimeHealth() {
  const activeExecutions = runtimeRegistry.list().length;

  return {
    status: activeExecutions > 0 ? 'degraded' : 'healthy',
    activeExecutions,
    failedExecutions: 'unsupported',
    timestamp: new Date().toISOString()
  };
}