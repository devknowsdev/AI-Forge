export interface CapabilityResult {
  success: boolean;
  output: unknown;
  metadata?: Record<string, unknown>;
  error?: string;
}
