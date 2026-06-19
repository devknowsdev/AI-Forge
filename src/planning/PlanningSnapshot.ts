export interface PlanningSnapshot {
  recentFailures: any[];
  costBudget: {
    remaining: number;
    tier: 'local' | 'hybrid' | 'cloud';
  };
  systemHints: {
    preferLocal: boolean;
    maxDepth?: number;
  };
}
