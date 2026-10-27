// `import x from '...' with { type: 'file' }` yields a path (embedded into `bun build --compile` binaries).
declare module '*.ttf' {
  const path: string;
  export default path;
}
declare module '*.wasm' {
  const path: string;
  export default path;
}
