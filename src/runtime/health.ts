import { runtimeRegistry } from './runtimeRegistry';
import { metrics } from '../telemetry/metrics';

export function getRuntimeHealth() {
  const failures = metrics.get('tasksFailed');

  return {
    status: failures > 0 ? 'degraded' : 'healthy',
    activeExecutions: runtimeRegistry.list().length,
    failedExecutions: failures,
    timestamp: new Date().toISOString()
  };
}