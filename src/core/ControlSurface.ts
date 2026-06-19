export class ControlSurface {
  private active = false;

  begin(graph: any) {
    if (this.active) throw new Error('active execution');
    this.active = true;
    return graph;
  }

  validate(graph: any) {
    if (!graph || !graph.nodes) throw new Error('invalid graph');
  }

  end() {
    this.active = false;
  }

  record(nodeId: string, result: any) {
    return { nodeId, result, timestamp: Date.now() };
  }
}
