// Stub for Node.js built-ins that some transitive dependencies reference.
// These are not used by the engine spike.
export const randomBytes = () => new Uint8Array(0);
export const createHash = () => ({ update: () => ({ digest: () => "" }) });
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;
export default {};
