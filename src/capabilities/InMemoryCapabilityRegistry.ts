import type { Capability } from './Capability.js';
import type { CapabilityRegistry } from './CapabilityRegistry.js';

export class InMemoryCapabilityRegistry implements CapabilityRegistry {
  private readonly capabilities = new Map<string, Capability>();
  register(capability: Capability): void { this.capabilities.set(capability.id, capability); }
  get(id: string): Capability | undefined { return this.capabilities.get(id); }
  list(): Capability[] { return [...this.capabilities.values()]; }
}
