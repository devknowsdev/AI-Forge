export class Metrics {
  private counters = { tasksExecuted: 0, tasksFailed: 0, tasksValidated: 0, tasksPersisted: 0, tasksRouted: 0, taskValidationFailures: 0 };
  increment(metric: keyof typeof this.counters): void { this.counters[metric] += 1; }
  get(metric: keyof typeof this.counters): number { return this.counters[metric]; }
  snapshot() { return { ...this.counters }; }
}
export const metrics = new Metrics();