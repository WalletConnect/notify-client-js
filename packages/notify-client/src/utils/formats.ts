export const convertUint8ArrayToHex = (uint8Array: Uint8Array): string =>
  Array.from(uint8Array)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
