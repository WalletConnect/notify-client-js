export const isEip191Signature = (signature: string) => {
  return signature.startsWith("0x19");
};
