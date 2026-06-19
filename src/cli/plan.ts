import { GraphBuilder } from "../intelligence/graphBuilder.js";

export async function planCommand(intent: string) {
  const builder = new GraphBuilder();

  const graph = builder.build(intent);

  console.log(JSON.stringify(graph, null, 2));
}
