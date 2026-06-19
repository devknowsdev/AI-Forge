// src/taskGraph/graphContract.ts

/**
 * TaskGraph Contract Layer
 * Enforces structural invariants BEFORE execution.
 *
 * This is a compile-time / pre-execution safety boundary.
 */

export class TaskGraphContract {
  validate(graph: any): void {
    this.validateStructure(graph);
    this.validateNodes(graph);
    this.validateNoSelfDependencies(graph);
    this.validateAcyclic(graph);
  }

  private validateStructure(graph: any): void {
    if (!graph) throw new Error("Graph is null/undefined");
    if (!Array.isArray(graph.nodes)) {
      throw new Error("Graph must contain nodes array");
    }
  }

  private validateNodes(graph: any): void {
    const ids = new Set<string>();

    for (const node of graph.nodes) {
      if (!node.id) throw new Error("Node missing id");
      if (ids.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
      ids.add(node.id);

      if (!node.packet) throw new Error(`Node ${node.id} missing packet`);
      if (!node.packet.intent) throw new Error(`Node ${node.id} missing intent`);
    }
  }

  private validateNoSelfDependencies(graph: any): void {
    for (const node of graph.nodes) {
      const deps = node.dependsOn ?? node.dependencies ?? [];

      if (Array.isArray(deps)) {
        for (const dep of deps) {
          if (dep === node.id) {
            throw new Error(`Self-dependency detected on node ${node.id}`);
          }
        }
      }
    }
  }

  private validateAcyclic(graph: any): void {
    const adj = new Map<string, string[]>();

    for (const node of graph.nodes) {
      const deps = node.dependsOn ?? node.dependencies ?? [];
      adj.set(node.id, Array.isArray(deps) ? deps : []);
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();

    const dfs = (id: string) => {
      if (visiting.has(id)) {
        throw new Error(`Cycle detected at node ${id}`);
      }
      if (visited.has(id)) return;

      visiting.add(id);

      for (const dep of adj.get(id) ?? []) {
        if (adj.has(dep)) dfs(dep);
      }

      visiting.delete(id);
      visited.add(id);
    };

    for (const node of graph.nodes) {
      dfs(node.id);
    }
  }
}
