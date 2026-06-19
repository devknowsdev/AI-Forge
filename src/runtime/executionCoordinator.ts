import { randomUUID } from 'crypto';
import { routeTask } from '../routing/router';
import { executeModel } from '../executors/localExecutor';
import { scheduler } from './resourceScheduler';
import { runtimeValidator } from './validator';
import { ledgerStore } from '../memory/ledgerStore';
import { eventBus } from '../events/eventBus';
import { createRuntimeEvent } from '../events/runtimeEvents';
import { runtimeRegistry } from './runtimeRegistry';
import { RuntimeState, ExecutionStatus } from './state';
import { metrics } from '../telemetry/metrics';

export async function execute(input: string) {
 const executionId = randomUUID();
 const context = { executionId, request:{id:executionId,input}, state:RuntimeState.ROUTING, status:ExecutionStatus.RUNNING, startedAt:new Date().toISOString() };
 runtimeRegistry.register(context);
 try {
 await eventBus.publish(createRuntimeEvent('TaskReceived',{executionId}));
 const route = await routeTask(input);
 metrics.increment('tasksRouted');
 context.route = route; runtimeRegistry.update(executionId, context);
 await eventBus.publish(createRuntimeEvent('TaskRouted',{executionId,route}));
 context.state = RuntimeState.SCHEDULED; runtimeRegistry.update(executionId, context);
 await eventBus.publish(createRuntimeEvent('TaskScheduled',{executionId}));
 context.state = RuntimeState.EXECUTING; runtimeRegistry.update(executionId, context);
 const result = await scheduler.run(() => executeModel(route.executor, input));
 await eventBus.publish(createRuntimeEvent('TaskExecuted',{executionId}));
 context.state = RuntimeState.VALIDATING; runtimeRegistry.update(executionId, context);
 try { runtimeValidator.validate(result); } catch(error){ metrics.increment('taskValidationFailures'); throw error; }
 metrics.increment('tasksValidated');
 await eventBus.publish(createRuntimeEvent('TaskValidated',{executionId}));
 context.state = RuntimeState.PERSISTING; runtimeRegistry.update(executionId, context);
 await ledgerStore.append({id:executionId,timestamp:new Date().toISOString(),request:context.request,route,result});
 metrics.increment('tasksPersisted');
 await eventBus.publish(createRuntimeEvent('TaskPersisted',{executionId}));
 metrics.increment('tasksExecuted');
 context.status = ExecutionStatus.COMPLETED; context.result=result; context.completedAt=new Date().toISOString(); runtimeRegistry.update(executionId, context);
 return result;
 } catch(error){ context.state = RuntimeState.FAILED; context.status = ExecutionStatus.FAILED; context.error = String(error); runtimeRegistry.update(executionId, context); metrics.increment('tasksFailed'); await eventBus.publish(createRuntimeEvent('TaskFailed',{executionId,error:String(error)})); throw error; }
 finally { runtimeRegistry.remove(executionId); }
}