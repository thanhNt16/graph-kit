export class SampleRepo {
  private items: Map<string, unknown> = new Map();

  set(key: string, value: unknown): void {
    this.items.set(key, value);
  }

  get(key: string): unknown {
    return this.items.get(key);
  }
}

export function sampleFlatten<T>(nested: T[][]): T[] {
  return nested.flat();
}
