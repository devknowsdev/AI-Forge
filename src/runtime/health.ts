import { runtimeRegistry } from './runtimeRegistry';

export function getRuntimeHealth() {
  return {
    status: 'healthy',
    activeExecutions: runtimeRegistry.list().length,
    timestamp: new Date().toISOString()
  };
}
