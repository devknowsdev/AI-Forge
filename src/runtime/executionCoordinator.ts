import { routeTask } from '../routing/router';
import { executeModel } from '../executors/localExecutor';
import { scheduler } from './resourceScheduler';

export async function execute(input: string) {
  const route = await routeTask(input);

  return scheduler.run(() => executeModel(route.executor, input));
}
