import { classifyTask } from './taskClassifier';
import type { RouteDecision } from './types';

const ROUTE_MAP = {
  code: { executor: 'deepseek-coder', plannerRequired: false },
  planning: { executor: 'qwen', plannerRequired: true },
  reasoning: { executor: 'llama', plannerRequired: false },
  retrieval: { executor: 'mistral', plannerRequired: false },
  tooling: { executor: 'mistral', plannerRequired: false },
  'audio.analysis': { executor: 'mistral', plannerRequired: false },
  'audio.transcription': { executor: 'mistral', plannerRequired: false },
  'audio.semantic': { executor: 'mistral', plannerRequired: false }
} as const;

export async function routeTask(input: string): Promise<RouteDecision> {
  const classification = await classifyTask(input);
  const route = ROUTE_MAP[classification.taskType] ?? ROUTE_MAP.reasoning;

  return {
    taskType: classification.taskType,
    confidence: classification.confidence,
    executor: route.executor,
    plannerRequired: route.plannerRequired,
    validationRequired: true
  };
}