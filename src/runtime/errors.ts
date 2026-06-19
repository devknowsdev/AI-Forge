export class RouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouterError';
  }
}

export class ExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorError';
  }
}

export class SchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
