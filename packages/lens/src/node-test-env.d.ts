// The repo has no @types/node. These are the only Node APIs the tests use (lens tests and the
// root notices.test.ts); delete this file if @types/node is ever added.
declare module 'node:fs' {
  export function existsSync(path: string | URL): boolean;
  export function readdirSync(path: string | URL, encoding: 'utf8'): string[];
  export function readFileSync(path: string | URL): Uint8Array;
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
}

declare module 'node:process' {
  export const env: Record<string, string | undefined>;
}
