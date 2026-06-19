export function deepFreezeGraph<T>(graph: T): T {
  Object.freeze(graph);

  for (const key of Object.keys(graph as any)) {
    const value = (graph as any)[key];

    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreezeGraph(value);
    }
  }

  return graph;
}
