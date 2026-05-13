import * as path from 'path';

export function resolveGauzMemProjectRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

export function resolveGauzMemProjectPath(input: string): string {
  return path.isAbsolute(input)
    ? input
    : path.resolve(resolveGauzMemProjectRoot(), input);
}
