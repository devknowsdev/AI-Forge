// src/taskGraph/graph.ts
//
// DAG of TaskPackets. Two things this class is intentionally strict about,
// both because the spec is strict about them:
//
// 1. Partial failure is DIRECT-dependents-only (04_TASK_GRAPH_SYSTEM.md,
//    07_SAFETY_SYSTEM.md): when a node fails, only its immediate dependents
//    are explicitly marked 'blocked'. We do NOT walk the transitive closure
//    and mark further-downstream nodes blocked too — they simply never
//    become 'ready' because isReady() requires ALL direct dependencies to
//    be 'success', and a blocked dependency never is. Same end state,
//    different mechanism, and the difference matters if this graph is ever
//    inspected mid-run: a transitively-stuck node correctly reads as
//    'pending' (still waiting), not 'blocked' (actively rejected).
// 2. Sibling branches with no dependency on the failed node are untouched
//    and keep executing — this falls out naturally from (1) since their
//    isReady() check never references the failed node.

import type { GraphNode, NodeStatus, TaskPacket } from "../types.js";

export interface NodeInput {
  id: string;
  packet: TaskPacket;
}

export class TaskGraph {
  readonly id: string;
  readonly projectId: string;
  private nodes: Map<string, GraphNode> = new Map();

  constructor(id: string, projectId: string, inputs: NodeInput[]) {
    this.id = id;
    this.projectId = projectId;

    for (const { id: nodeId, packet } of inputs) {
      this.nodes.set(nodeId, { id: nodeId, packet, status: "pending", dependents: [] });
    }
    // Reverse edges for dependents, computed once at build time.
    for (const node of this.nodes.values()) {
      for (const depId of node.packet.dependencies) {
        const dep = this.nodes.get(depId);
        if (!dep) {
          throw new Error(`Node "${node.id}" depends on unknown node "${depId}"`);
        }
        dep.dependents.push(node.id);
      }
    }
    this.assertAcyclic();
  }

  private assertAcyclic(): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string, path: string[]): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Cycle detected in task graph: ${[...path, id].join(" -> ")}`);
      }
      visiting.add(id);
      const node = this.nodes.get(id)!;
      for (const depId of node.packet.dependencies) visit(depId, [...path, id]);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of this.nodes.keys()) visit(id, []);
  }

  get(id: string): GraphNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown node "${id}"`);
    return node;
  }

  all(): GraphNode[] {
    return [...this.nodes.values()];
  }

  isReady(id: string): boolean {
    const node = this.get(id);
    if (node.status !== "pending") return false;
    return node.packet.dependencies.every((depId) => this.get(depId).status === "success");
  }

  readyNodeIds(): string[] {
    return this.all()
      .filter((n) => this.isReady(n.id))
      .map((n) => n.id);
  }

  setStatus(id: string, status: NodeStatus): void {
    this.get(id).status = status;
  }

  /** Direct-dependents-only blocking — see class docblock for why this is correct as written. */
  markFailed(id: string): void {
    const node = this.get(id);
    node.status = "failed";
    for (const depId of node.dependents) {
      const dependent = this.get(depId);
      if (dependent.status === "pending" || dependent.status === "ready") {
        dependent.status = "blocked";
      }
    }
  }

  /** True once no node can make further progress (nothing running, nothing currently ready). */
  isSettled(): boolean {
    const hasRunning = this.all().some((n) => n.status === "running");
    if (hasRunning) return false;
    return this.readyNodeIds().length === 0;
  }

  summary(): Record<NodeStatus, number> {
    const counts: Record<NodeStatus, number> = {
      pending: 0,
      ready: 0,
      running: 0,
      success: 0,
      failed: 0,
      blocked: 0,
    };
    for (const n of this.all()) counts[n.status]++;
    return counts;
  }
}
