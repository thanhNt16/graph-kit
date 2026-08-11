export function sampleGreet(name: string): string {
  return `Hello, ${name}!`;
}

export function sampleLength<T>(arr: T[]): number {
  return arr.length;
}
