import type { HeavyTaskDescriptor, HeavyTaskHandler, HeavyTaskReport } from './types';
import { modelOptimizeTaskHandler } from './model-optimize';

export class TaskRegistry {
  private readonly handlers = new Map<string, HeavyTaskHandler<unknown>>();

  register<TPayload>(handler: HeavyTaskHandler<TPayload>): void {
    this.handlers.set(handler.type, handler as HeavyTaskHandler<unknown>);
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  async run(inputPath: string, outputPath: string, descriptor: HeavyTaskDescriptor): Promise<HeavyTaskReport> {
    const handler = this.handlers.get(descriptor.type);
    if (!handler) {
      throw new Error(`No task handler registered for taskType: ${descriptor.type}`);
    }
    return handler.run(inputPath, outputPath, descriptor);
  }

  listTypes(): string[] {
    return [...this.handlers.keys()];
  }
}

export function createDefaultTaskRegistry(): TaskRegistry {
  const registry = new TaskRegistry();
  registry.register(modelOptimizeTaskHandler);
  return registry;
}

export const taskRegistry = createDefaultTaskRegistry();
