import { generateRandomBytes32 } from "@walletconnect/utils";

export const generateClientDbName = (prefix: string) =>
  `./test/tmp/${prefix}_${generateRandomBytes32()}.db`;
