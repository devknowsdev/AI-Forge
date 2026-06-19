export interface ForgeEvent<T = unknown> {
  id: string;
  type: string;
  timestamp: string;
  payload: T;
}

export const RuntimeEvents = {
  TaskReceived: 'TaskReceived',
  TaskClassified: 'TaskClassified',
  TaskRouted: 'TaskRouted',
  TaskScheduled: 'TaskScheduled',
  TaskExecuted: 'TaskExecuted',
  TaskValidated: 'TaskValidated',
  TaskFailed: 'TaskFailed'
} as const;
